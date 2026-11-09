/**
 * The job queue and its state machine, and the only module that writes the
 * job, clip, and transcript tables. The web app calls the first block of
 * functions. The worker calls claimJob and drives the returned Lease.
 *
 *   queued ──claim──▶ transcribing ──saveTranscript──▶ selecting ──saveMoments──▶ rendering
 *     ▲                     │                              │                          │
 *     │                     └────────── finish(error) ─────┴──────── finish() ───────┤
 *     │                                                                              ▼
 *     └──────────── retryJob (failed | partial) ◀──────────── completed | partial | failed
 *
 * Crash recovery and user retry share one path. The job goes back in the
 * queue, and claim works out where to resume from what is saved: a transcript
 * row skips Whisper, clip rows skip the LLM, and ready clips never render again.
 *
 * Every worker write runs in a transaction that first locks the job row while
 * this attempt still holds it (same attempt, running, lease not expired). A
 * worker whose lease expired writes nothing, even before anyone reclaims the
 * job, and its Lease aborts so its ffmpeg and fetch calls stop too.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "./index";
import {
  leaseEnd,
  MAX_ATTEMPTS,
  NOT_HELD,
  startHeartbeat,
  type Tx,
  truncate,
} from "./queue";
import {
  type ClipStatus,
  clip,
  type JobStatus,
  job,
  mediaTrash,
  RETRYABLE,
  RUNNING,
  type RunningStatus,
  type Segment,
  transcript,
} from "./schema/job";

export type { ClipStatus, JobStatus, Segment, Word } from "./schema/job";

const LIST_LIMIT = 50;
const NOT_RENDERED = "Not rendered.";
const STEPS = ["queued", ...RUNNING] as const satisfies readonly Step[];
const SAVED_TRANSCRIPT = {
  columns: { language: true, durationSeconds: true },
} as const;
const ABANDONED = `The worker stopped ${MAX_ATTEMPTS} times while working on this job. Check \`docker compose logs worker\`, then retry.`;

/** What Whisper heard, parsed and validated by the worker's Whisper client. */
export interface Transcript {
  durationSeconds: number;
  language: string;
  segments: Segment[];
}

/**
 * A moment the worker's selector validated against CLIP_SECONDS and SCORE.
 * The clip table's check constraints enforce both again.
 */
export interface Moment {
  endSeconds: number;
  reason: string;
  score: number;
  startSeconds: number;
  title: string;
}

/** The pipeline in run order. A job's status names the step it is on while active. */
export type Step = "queued" | RunningStatus;

/** `failed` and `partial` mark the step a finished job stopped at. */
export type StepState = "done" | "running" | "waiting" | "failed" | "partial";

/** Where a clip sits in the source, for timelines and moment maps. */
export interface ClipSpan {
  durationSeconds: number;
  id: string;
  rank: number;
  startSeconds: number;
  status: ClipStatus;
}

/** Timestamps are ISO strings because this tRPC setup has no transformer. */
export interface JobSummary {
  /** Queued or running. The UI polls while true. */
  active: boolean;
  clipCount: number;
  /** By rank. */
  clips: ClipSpan[];
  createdAt: string;
  /** Known once transcribed. */
  durationSeconds: number | null;
  id: string;
  /** Detected by Whisper once transcribed, else the requested one, else null. */
  language: string | null;
  readyCount: number;
  sourceName: string;
  status: JobStatus;
  totalCount: number;
}

export interface ClipView extends ClipSpan {
  error: string | null;
  reason: string;
  score: number;
  title: string;
}

export interface JobView extends JobSummary {
  canRetry: boolean;
  /** By rank. Pending clips already carry their title and score. */
  clips: ClipView[];
  error: string | null;
  /** The clip the worker is rendering now. It renders pending clips one at a time in rank order. */
  renderingClipId: string | null;
  /** Read from what is saved, so a retried job shows its kept transcript and clips as done. */
  steps: Record<Step, StepState>;
}

export interface ClipFile {
  file: string;
  rank: number;
  title: string;
}

export interface PendingClip {
  endSeconds: number;
  id: string;
  rank: number;
  startSeconds: number;
}

/** Where the claimed attempt resumes. The union makes "a transcript exists from selecting on" a type fact. */
export type ClaimedJob = {
  id: string;
  attempt: number;
  sourcePath: string;
  clipCount: number;
  language: string | null;
} & (
  | { stage: "transcribing" }
  | { stage: "selecting"; transcript: Transcript }
  | { stage: "rendering"; transcript: Transcript; clips: PendingClip[] }
);

/**
 * One attempt's hold on a job. Every method writes only while this attempt
 * still holds the job. Otherwise it writes nothing, aborts `signal`, and
 * throws `signal.reason`.
 */
export interface Lease {
  /** pending → failed. Siblings carry on. */
  failClip: (clipId: string, error: string) => Promise<void>;
  /**
   * Ends the attempt. Pending clips fail with `error`, then the status follows
   * from the clips: completed if all are ready, partial if some, failed if none
   * (including a job that never got clips).
   */
  finish: (error?: string) => Promise<void>;
  readonly job: ClaimedJob;
  /** pending → ready. `file` is relative to DATA_DIR and already in place. */
  publishClip: (clipId: string, file: string) => Promise<void>;
  /**
   * Stops the heartbeat and, if this attempt still holds the running job,
   * hands it straight back to the queue. The attempt is refunded only when the
   * worker is shutting down, so a restart never counts toward abandoning the
   * job but an attempt that ended some other way without finish does. A no-op
   * after finish or a lost lease. Always call it in `finally`.
   */
  release: () => Promise<void>;
  /** selecting → rendering. Ranks by score, highest first, and returns the clips in rank order. The caller handles the empty case. */
  saveMoments: (moments: readonly Moment[]) => Promise<PendingClip[]>;
  /** transcribing → selecting. */
  saveTranscript: (transcript: Transcript) => Promise<void>;
  /**
   * Aborts when the lease is lost (reclaimed, expired, or no heartbeat could
   * reach Postgres) or the worker is shutting down. Pass it to every spawn and
   * fetch.
   */
  readonly signal: AbortSignal;
}

export async function createJob(
  db: Database,
  input: {
    userId: string;
    sourceName: string;
    sourcePath: string;
    clipCount: number;
    language: string | null;
  }
): Promise<string> {
  const [row] = await db
    .insert(job)
    .values({ ...input, attemptsLeft: MAX_ATTEMPTS })
    .returning({ id: job.id });
  if (!row) {
    throw new Error("Inserting the job returned no row.");
  }
  return row.id;
}

/** The user's latest jobs, newest first. jobs[0] is the job the app opens on. */
export async function listJobs(
  db: Database,
  userId: string
): Promise<JobSummary[]> {
  // ponytail: latest 50 only; keyset pagination on created_at once someone has more.
  const rows = await db.query.job.findMany({
    columns: {
      id: true,
      sourceName: true,
      status: true,
      createdAt: true,
      clipCount: true,
      language: true,
    },
    where: { userId },
    orderBy: { createdAt: "desc" },
    limit: LIST_LIMIT,
    with: {
      clips: {
        columns: {
          id: true,
          rank: true,
          startSeconds: true,
          endSeconds: true,
          status: true,
        },
        orderBy: { rank: "asc" },
      },
      transcript: SAVED_TRANSCRIPT,
    },
  });
  return rows.map(toSummary);
}

/** Null when the job does not exist or belongs to someone else. */
export async function getJob(
  db: Database,
  userId: string,
  jobId: string
): Promise<JobView | null> {
  const row = await db.query.job.findFirst({
    where: { id: jobId, userId },
    with: {
      clips: { orderBy: { rank: "asc" } },
      transcript: SAVED_TRANSCRIPT,
    },
  });
  if (!row) {
    return null;
  }
  const clips = row.clips.map(
    (c): ClipView => ({
      ...toSpan(c),
      title: c.title,
      reason: c.reason,
      score: c.score,
      error: c.error,
    })
  );
  return {
    ...toSummary(row),
    canRetry: RETRYABLE.some((status) => status === row.status),
    error: row.error,
    clips,
    renderingClipId:
      row.status === "rendering"
        ? (clips.find((c) => c.status === "pending")?.id ?? null)
        : null,
    steps: stepStates(row.status, {
      transcript: row.transcript !== null,
      clips: clips.length > 0,
    }),
  };
}

/**
 * Queues a failed or partial job again. Ready clips stay ready, failed clips
 * go back to pending, and the transcript is kept, so the next claim resumes
 * at the earliest missing step. Idempotent: on any other status it changes
 * nothing and returns the job as it is. Null when not found or not owned.
 */
export async function retryJob(
  db: Database,
  userId: string,
  jobId: string
): Promise<JobView | null> {
  await db.transaction(async (tx) => {
    const requeued = await tx
      .update(job)
      .set({ status: "queued", error: null, attemptsLeft: MAX_ATTEMPTS })
      .where(
        and(
          eq(job.id, jobId),
          eq(job.userId, userId),
          inArray(job.status, RETRYABLE)
        )
      )
      .returning({ id: job.id });
    if (requeued.length > 0) {
      await tx
        .update(clip)
        .set({ status: "pending", error: null })
        .where(and(eq(clip.jobId, jobId), eq(clip.status, "failed")));
    }
  });
  return getJob(db, userId, jobId);
}

/**
 * Deletes the job at any status, with its transcript, clips and versions,
 * and leaves its upload and its clip and version folders in media_trash for
 * the worker to remove. A worker still holding the job loses its lease at
 * the next heartbeat. False when not found or not owned.
 */
export async function deleteJob(
  db: Database,
  userId: string,
  jobId: string
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    // The job row lock waits out a worker write, so no clip lands after this read.
    const [owned] = await tx
      .select({ sourcePath: job.sourcePath })
      .from(job)
      .where(and(eq(job.id, jobId), eq(job.userId, userId)))
      .for("update");
    if (!owned) {
      return false;
    }
    const clips = await tx
      .select({ id: clip.id })
      .from(clip)
      .where(eq(clip.jobId, jobId));
    const paths = [
      owned.sourcePath,
      `clips/${jobId}`,
      ...clips.map(({ id }) => `versions/${id}`),
    ];
    await tx
      .insert(mediaTrash)
      .values(paths.map((path) => ({ path })))
      .onConflictDoNothing();
    await tx.delete(job).where(eq(job.id, jobId));
    return true;
  });
}

/** The ready clip's file, only for its owner. Null otherwise, so the route answers 404 either way. */
export async function getClipFile(
  db: Database,
  userId: string,
  clipId: string
): Promise<ClipFile | null> {
  const [row] = await db
    .select({ file: clip.file, title: clip.title, rank: clip.rank })
    .from(clip)
    .innerJoin(job, eq(job.id, clip.jobId))
    .where(
      and(eq(clip.id, clipId), eq(job.userId, userId), eq(clip.status, "ready"))
    );
  return row?.file
    ? { file: row.file, title: row.title, rank: row.rank }
    : null;
}

/** The job's uploaded video, only for its owner, for the editor's source preview. Null otherwise. */
export async function getSourceFile(
  db: Database,
  userId: string,
  jobId: string
): Promise<{ file: string; sourceName: string } | null> {
  const [row] = await db
    .select({ file: job.sourcePath, sourceName: job.sourceName })
    .from(job)
    .where(and(eq(job.id, jobId), eq(job.userId, userId)));
  return row ?? null;
}

/**
 * Claims the oldest queued job, or a running job whose lease expired, and
 * starts heartbeating. Null when there is nothing to do. `signal` is the
 * worker's shutdown signal and is folded into the lease's signal.
 */
export async function claimJob(
  db: Database,
  options: { signal: AbortSignal }
): Promise<Lease | null> {
  const claimed = await db.transaction(claimNext);
  return claimed ? startLease(db, claimed, options.signal) : null;
}

/** Job and attempt pairs a worker may still be writing scratch files for. */
export async function runningAttempts(
  db: Database
): Promise<{ jobId: string; attempt: number }[]> {
  return await db
    .select({ jobId: job.id, attempt: job.attempt })
    .from(job)
    .where(inArray(job.status, RUNNING));
}

type Owner = Pick<ClaimedJob, "id" | "attempt">;
type ClaimRow = Pick<
  typeof job.$inferSelect,
  "id" | "attempt" | "attemptsLeft" | "sourcePath" | "clipCount" | "language"
> & { status: RunningStatus };

const owns = (owner: Owner) =>
  and(
    eq(job.id, owner.id),
    eq(job.attempt, owner.attempt),
    inArray(job.status, RUNNING),
    gt(job.leaseExpiresAt, sql`now()`)
  );

async function lockOwned(tx: Tx, owner: Owner): Promise<JobStatus | undefined> {
  const [row] = await tx
    .select({ status: job.status })
    .from(job)
    .where(owns(owner))
    .for("update");
  return row?.status;
}

async function claimNext(tx: Tx): Promise<ClaimedJob | null> {
  const {
    rows: [row],
  } = await tx.execute<ClaimRow>(sql`
    with next as (
      select id from job
      where status = 'queued' or (${inArray(job.status, RUNNING)} and lease_expires_at < now())
      order by created_at
      limit 1
      for update skip locked
    )
    update job set
      attempt = job.attempt + 1,
      attempts_left = job.attempts_left - 1,
      lease_expires_at = ${leaseEnd},
      status = case
        when exists (select 1 from clip where clip.job_id = job.id) then 'rendering'::job_status
        when exists (select 1 from transcript where transcript.job_id = job.id) then 'selecting'::job_status
        else 'transcribing'::job_status
      end
    from next
    where job.id = next.id
    returning job.id, job.attempt, job.attempts_left as "attemptsLeft", job.status,
      job.source_path as "sourcePath", job.clip_count as "clipCount", job.language`);
  if (!row) {
    return null;
  }
  if (row.attemptsLeft < 0) {
    await finishAttempt(tx, row, ABANDONED);
    return claimNext(tx);
  }

  const base = {
    id: row.id,
    attempt: row.attempt,
    sourcePath: row.sourcePath,
    clipCount: row.clipCount,
    language: row.language,
  };
  if (row.status === "transcribing") {
    return { ...base, stage: row.status };
  }
  const [saved] = await tx
    .select({
      language: transcript.language,
      durationSeconds: transcript.durationSeconds,
      segments: transcript.segments,
    })
    .from(transcript)
    .where(eq(transcript.jobId, row.id));
  if (!saved) {
    throw new Error(`Job ${row.id} is ${row.status} but has no transcript.`);
  }
  if (row.status === "selecting") {
    return { ...base, stage: row.status, transcript: saved };
  }
  const clips = await tx
    .select({
      id: clip.id,
      rank: clip.rank,
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
    })
    .from(clip)
    .where(and(eq(clip.jobId, row.id), eq(clip.status, "pending")))
    .orderBy(asc(clip.rank));
  return { ...base, stage: row.status, transcript: saved, clips };
}

function startLease(
  db: Database,
  claimed: ClaimedJob,
  shutdown: AbortSignal
): Lease {
  const { signal, lose, stop } = startHeartbeat(
    `job ${claimed.id}, attempt ${claimed.attempt}`,
    async () =>
      (
        await db
          .update(job)
          .set({ leaseExpiresAt: leaseEnd })
          .where(owns(claimed))
          .returning({ id: job.id })
      ).length > 0,
    shutdown
  );

  const guarded = <T>(
    stage: RunningStatus,
    write: (tx: Tx) => Promise<T>
  ): Promise<T> =>
    db.transaction(async (tx) => {
      const status = await lockOwned(tx, claimed);
      if (status === undefined) {
        throw lose(NOT_HELD);
      }
      if (status !== stage) {
        throw new Error(`Job ${claimed.id} is ${status}, not ${stage}.`);
      }
      return write(tx);
    });

  const settleClip = async (
    tx: Tx,
    clipId: string,
    values:
      | { status: "ready"; file: string }
      | { status: "failed"; error: string }
  ) => {
    const settled = await tx
      .update(clip)
      .set(values)
      .where(
        and(
          eq(clip.id, clipId),
          eq(clip.jobId, claimed.id),
          eq(clip.status, "pending")
        )
      )
      .returning({ id: clip.id });
    if (settled.length === 0) {
      throw new Error(
        `Clip ${clipId} is not a pending clip of job ${claimed.id}.`
      );
    }
  };

  return {
    job: claimed,
    signal,
    saveTranscript: (heard) =>
      guarded("transcribing", async (tx) => {
        await tx
          .update(job)
          .set({ status: "selecting" })
          .where(eq(job.id, claimed.id));
        await tx.insert(transcript).values({ jobId: claimed.id, ...heard });
      }),
    saveMoments: (moments) =>
      guarded("selecting", async (tx) => {
        await tx
          .update(job)
          .set({ status: "rendering" })
          .where(eq(job.id, claimed.id));
        const ranked = moments.toSorted((a, b) => b.score - a.score);
        const inserted = await tx
          .insert(clip)
          .values(
            ranked.map((moment, i) => ({
              ...moment,
              jobId: claimed.id,
              rank: i + 1,
            }))
          )
          .returning({
            id: clip.id,
            rank: clip.rank,
            startSeconds: clip.startSeconds,
            endSeconds: clip.endSeconds,
          });
        return inserted.toSorted((a, b) => a.rank - b.rank);
      }),
    publishClip: (clipId, file) =>
      guarded("rendering", (tx) =>
        settleClip(tx, clipId, { status: "ready", file })
      ),
    failClip: (clipId, error) =>
      guarded("rendering", (tx) =>
        settleClip(tx, clipId, { status: "failed", error: truncate(error) })
      ),
    finish: async (error) => {
      stop();
      if (!(await db.transaction((tx) => finishAttempt(tx, claimed, error)))) {
        throw lose(NOT_HELD);
      }
    },
    release: async () => {
      stop();
      const refund = shutdown.aborted ? 1 : 0;
      await db
        .update(job)
        .set({
          leaseExpiresAt: sql`now()`,
          attemptsLeft: sql`${job.attemptsLeft} + ${refund}`,
        })
        .where(owns(claimed));
    },
  };
}

async function finishAttempt(
  tx: Tx,
  owner: Owner,
  error: string | undefined
): Promise<boolean> {
  if ((await lockOwned(tx, owner)) === undefined) {
    return false;
  }
  const message = error ? truncate(error) : null;
  await tx
    .update(clip)
    .set({ status: "failed", error: message ?? NOT_RENDERED })
    .where(and(eq(clip.jobId, owner.id), eq(clip.status, "pending")));
  await tx
    .update(job)
    .set({
      status: sql`(select case
          when count(*) filter (where ${clip.status} = 'ready') = 0 then 'failed'
          when count(*) filter (where ${clip.status} = 'failed') = 0 then 'completed'
          else 'partial' end
        from ${clip} where ${clip.jobId} = ${owner.id})::job_status`,
      error: message,
      leaseExpiresAt: null,
    })
    .where(eq(job.id, owner.id));
  return true;
}

type SpanRow = Pick<
  typeof clip.$inferSelect,
  "id" | "rank" | "startSeconds" | "endSeconds" | "status"
>;

function toSpan(c: SpanRow): ClipSpan {
  return {
    id: c.id,
    rank: c.rank,
    startSeconds: c.startSeconds,
    durationSeconds: c.endSeconds - c.startSeconds,
    status: c.status,
  };
}

function toSummary(
  row: Pick<
    typeof job.$inferSelect,
    "id" | "sourceName" | "status" | "createdAt" | "clipCount" | "language"
  > & {
    clips: SpanRow[];
    transcript: Pick<
      typeof transcript.$inferSelect,
      "language" | "durationSeconds"
    > | null;
  }
): JobSummary {
  return {
    id: row.id,
    sourceName: row.sourceName,
    status: row.status,
    active:
      row.status === "queued" ||
      RUNNING.some((status) => status === row.status),
    createdAt: row.createdAt.toISOString(),
    clipCount: row.clipCount,
    language: row.transcript?.language ?? row.language,
    durationSeconds: row.transcript?.durationSeconds ?? null,
    readyCount: row.clips.filter((c) => c.status === "ready").length,
    totalCount: row.clips.length,
    clips: row.clips.map(toSpan),
  };
}

/**
 * A step is done once its output is saved. A finished job stopped at its
 * first step that is not done: the transcript, the moments, or the renders.
 */
function stepStates(
  status: JobStatus,
  saved: { transcript: boolean; clips: boolean }
): Record<Step, StepState> {
  const done: Record<Step, boolean> = {
    queued: status !== "queued",
    transcribing: saved.transcript,
    selecting: saved.clips,
    rendering: status === "completed",
  };
  const stopped = status === "failed" || status === "partial" ? status : null;
  const stoppedAt = STEPS.find((step) => !done[step]);
  const state = (step: Step): StepState => {
    if (step === status) {
      return "running";
    }
    if (done[step]) {
      return "done";
    }
    return stopped && step === stoppedAt ? stopped : "waiting";
  };
  return {
    queued: state("queued"),
    transcribing: state("transcribing"),
    selecting: state("selecting"),
    rendering: state("rendering"),
  };
}
