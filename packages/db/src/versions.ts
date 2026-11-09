/**
 * The version queue, and the only module that writes clip_version, as
 * jobs.ts is for job, clip and transcript. The web app calls the first
 * block. The worker's version lane calls claimVersion and drives the lease.
 *
 *   createVersion ──▶ queued ──claimVersion──▶ rendering ──publish──▶ ready
 *                       ▲                          │ └───────fail──────▶ failed
 *                       └── lease lapses, release ─┘
 *
 * Fencing is jobs.ts's, through queue.ts: a worker write changes the row
 * only while id, attempt, status = 'rendering' and lease_expires_at > now()
 * still match. Otherwise it writes nothing and aborts the lease's signal.
 */
import { isDeepStrictEqual } from "node:util";

import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";

import type { AssetView } from "./assets";
import { wordsOf } from "./captions";
import {
  assetIdsOf,
  type Capabilities,
  capabilitiesFor,
  DEFAULTS,
  type DeliveryStage,
  type EditDraft,
  type EditSettings,
  type Issue,
  parseDocument,
  parseSettings,
  type Range,
  SettingsError,
  type SourceCatalog,
} from "./editor";
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
  clip,
  clipVersion,
  job,
  type Segment,
  transcript,
  type VersionStatus,
} from "./schema/job";
import { type RenderPlan, resolvePlan, schedule } from "./timeline";

export type { VersionStatus } from "./schema/job";

const STAGE: DeliveryStage = 1;
const MAX_NUMBER = 2_147_483_647;
const ABANDONED = `The worker stopped ${MAX_ATTEMPTS} times while rendering this version. Check \`docker compose logs worker\`, then export again.`;

export interface ClipEditorView {
  assets: readonly AssetView[];
  capabilities: Capabilities;
  clipId: string;
  jobId: string;
  jobPreviewUrl: string;
  /** The settings that reproduce the job's own render of this clip. */
  original: EditSettings;
  presets: readonly { clipId: string; title: string; range: Range }[];
  rank: number;
  sources: SourceCatalog;
  title: string;
}

/** Timestamps are ISO strings because this tRPC setup has no transformer. */
export interface VersionView {
  /** Queued or rendering. The editor polls while any version is. */
  active: boolean;
  createdAt: string;
  /** Output seconds, from the frame schedule. */
  duration: number;
  error: string | null;
  missingAssetIds: readonly string[];
  number: number;
  settings: EditSettings;
  status: VersionStatus;
}

export type CreateVersionResult =
  | { ok: true; version: VersionView }
  | {
      ok: false;
      /**
       * not-found: no such ready clip for this user. request-reused: same
       * requestId, other settings. deleted: that request's version was
       * deleted. invalid-settings and unsupported-feature come with issues.
       */
      reason:
        | "not-found"
        | "request-reused"
        | "deleted"
        | "invalid-settings"
        | "media-unavailable"
        | "unsupported-feature";
      message: string;
      /** Each refused value's path, so the editor can focus it. Empty for the other reasons. */
      issues: readonly Issue[];
    };

/** Null when the clip does not exist, is not ready, or belongs to someone else. */
export async function getClipEditor(
  db: Database,
  userId: string,
  clipId: string
): Promise<ClipEditorView | null> {
  const [row] = await db
    .select({
      clipId: clip.id,
      jobId: clip.jobId,
      rank: clip.rank,
      title: clip.title,
      start: clip.startSeconds,
      end: clip.endSeconds,
      durationSeconds: transcript.durationSeconds,
      segments: transcript.segments,
    })
    .from(clip)
    .innerJoin(job, eq(job.id, clip.jobId))
    .innerJoin(transcript, eq(transcript.jobId, clip.jobId))
    .where(ownedReadyClip(userId, clipId));
  if (!row) {
    return null;
  }
  const presets = await db
    .select({
      clipId: clip.id,
      title: clip.title,
      start: clip.startSeconds,
      end: clip.endSeconds,
    })
    .from(clip)
    .where(and(eq(clip.jobId, row.jobId), eq(clip.status, "ready")))
    .orderBy(asc(clip.rank));
  const sources = jobSources(row);
  return {
    clipId: row.clipId,
    jobId: row.jobId,
    rank: row.rank,
    title: row.title,
    original: parseSettings(original(row), sources, STAGE),
    sources,
    jobPreviewUrl: `/api/jobs/${row.jobId}/source`,
    presets: presets.map(({ start, end, ...preset }) => ({
      ...preset,
      range: { start, end },
    })),
    assets: [],
    capabilities: capabilitiesFor(STAGE, false),
  };
}

/** Newest first, deleted versions left out. Null when the clip is not the user's; an owned clip with no versions is []. */
export async function listVersions(
  db: Database,
  userId: string,
  clipId: string
): Promise<readonly VersionView[] | null> {
  const [owned] = await db
    .select({ id: clip.id })
    .from(clip)
    .innerJoin(job, eq(job.id, clip.jobId))
    .where(and(eq(clip.id, clipId), eq(job.userId, userId)));
  if (!owned) {
    return null;
  }
  const rows = await db
    .select()
    .from(clipVersion)
    .where(and(eq(clipVersion.clipId, clipId), isNull(clipVersion.deletedAt)))
    .orderBy(desc(clipVersion.number));
  return rows.map(toView);
}

/**
 * Queues the next numbered version of a ready clip. Idempotent per
 * (clip, requestId): the same id with canonically equal settings returns the
 * existing version whatever its status, and with other settings it is
 * refused, so a retry can never attach new settings to an old number. The
 * replay check comes before the stage and media checks, so a replay answers
 * the same even if those would now refuse it.
 */
export async function createVersion(
  db: Database,
  userId: string,
  input: { clipId: string; requestId: string; settings: EditDraft }
): Promise<CreateVersionResult> {
  let document: EditDraft;
  try {
    document = parseDocument(input.settings);
  } catch (error) {
    return refused(error);
  }
  return await db.transaction(async (tx) => {
    // Locking the clip hands out numbers one at a time per clip. jobs.ts never writes a ready clip, so the lock never waits on a worker.
    const [owned] = await tx
      .select({
        durationSeconds: transcript.durationSeconds,
        segments: transcript.segments,
      })
      .from(clip)
      .innerJoin(job, eq(job.id, clip.jobId))
      .innerJoin(transcript, eq(transcript.jobId, clip.jobId))
      .where(ownedReadyClip(userId, input.clipId))
      .for("no key update", { of: clip });
    if (!owned) {
      return failure("not-found", "Clip not found.");
    }
    const [existing] = await tx
      .select()
      .from(clipVersion)
      .where(
        and(
          eq(clipVersion.clipId, input.clipId),
          eq(clipVersion.requestId, input.requestId)
        )
      );
    if (existing) {
      return replay(existing, document);
    }
    let settings: EditSettings;
    try {
      settings = parseSettings(document, jobSources(owned), STAGE);
    } catch (error) {
      return refused(error);
    }
    const [next] = await tx
      .select({
        number:
          sql<number>`coalesce(max(${clipVersion.number}), 0) + 1`.mapWith(
            Number
          ),
      })
      .from(clipVersion)
      .where(eq(clipVersion.clipId, input.clipId));
    const [row] = await tx
      .insert(clipVersion)
      .values({
        clipId: input.clipId,
        requestId: input.requestId,
        number: next?.number ?? 1,
        settings,
        attemptsLeft: MAX_ATTEMPTS,
      })
      .returning();
    if (!row) {
      throw new Error("Inserting the version returned no row.");
    }
    return { ok: true, version: toView(row) };
  });
}

/** A ready version's file, only for its owner, for GET /api/clips/:clipId?v=N. `name` is the settings' name, for the download's file name. */
export async function getVersionFile(
  db: Database,
  userId: string,
  clipId: string,
  number: number
): Promise<{ file: string; number: number; name: string } | null> {
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) {
    return null;
  }
  const [row] = await db
    .select({
      file: clipVersion.file,
      name: sql<string>`${clipVersion.settings} ->> 'name'`,
    })
    .from(clipVersion)
    .innerJoin(clip, eq(clip.id, clipVersion.clipId))
    .innerJoin(job, eq(job.id, clip.jobId))
    .where(
      and(
        eq(clipVersion.clipId, clipId),
        eq(clipVersion.number, number),
        eq(clipVersion.status, "ready"),
        isNull(clipVersion.deletedAt),
        eq(job.userId, userId)
      )
    );
  return row?.file ? { file: row.file, number, name: row.name } : null;
}

export interface ClaimedVersion {
  attempt: number;
  clipId: string;
  id: string;
  number: number;
  plan: RenderPlan;
}

/**
 * One attempt's hold on a version. Same contract as jobs.ts's Lease: every
 * method writes only while this attempt still holds the row. Otherwise it
 * writes nothing, aborts `signal`, and throws `signal.reason`.
 */
export interface VersionLease {
  /** rendering → failed. Ends the lease. */
  fail: (error: string) => Promise<void>;
  /** rendering → ready. `file` is relative to DATA_DIR and already in place. Ends the lease. */
  publish: (file: string) => Promise<void>;
  /**
   * Stops the heartbeat and, if this attempt still holds the row, hands it
   * straight back, refunding the attempt only on shutdown. A no-op after
   * publish, fail, or a lost lease. Always call it in `finally`.
   */
  release: () => Promise<void>;
  /** Aborts when the lease is lost or the worker shuts down. Pass it to every spawn. */
  readonly signal: AbortSignal;
  readonly version: ClaimedVersion;
}

/**
 * Claims the oldest queued version, or a rendering one whose lease lapsed,
 * and starts heartbeating. Null when there is nothing to do. `signal` is the
 * worker's shutdown signal and is folded into the lease's signal. A version
 * whose settings this release no longer accepts fails under the fence, and
 * the claim moves on.
 */
export async function claimVersion(
  db: Database,
  options: { signal: AbortSignal }
): Promise<VersionLease | null> {
  const claimed = await db.transaction(claimNext);
  return claimed ? startVersionLease(db, claimed, options.signal) : null;
}

/** Version and attempt pairs a worker may still be writing scratch files for. */
export async function runningVersions(
  db: Database
): Promise<readonly { id: string; attempt: number }[]> {
  return await db
    .select({ id: clipVersion.id, attempt: clipVersion.attempt })
    .from(clipVersion)
    .where(eq(clipVersion.status, "rendering"));
}

type Owner = Pick<ClaimedVersion, "id" | "attempt">;
type VersionRow = typeof clipVersion.$inferSelect;
type Settled =
  | { status: "ready"; file: string }
  | { status: "failed"; error: string };

const ownedReadyClip = (userId: string, clipId: string) =>
  and(eq(clip.id, clipId), eq(job.userId, userId), eq(clip.status, "ready"));

const owns = (owner: Owner) =>
  and(
    eq(clipVersion.id, owner.id),
    eq(clipVersion.attempt, owner.attempt),
    eq(clipVersion.status, "rendering"),
    gt(clipVersion.leaseExpiresAt, sql`now()`)
  );

async function claimNext(tx: Tx): Promise<ClaimedVersion | null> {
  const {
    rows: [row],
  } = await tx.execute<Owner & { attemptsLeft: number }>(sql`
    with next as (
      select id from clip_version
      where status = 'queued' or (status = 'rendering' and lease_expires_at < now())
      order by created_at
      limit 1
      for update skip locked
    )
    update clip_version set
      attempt = clip_version.attempt + 1,
      attempts_left = clip_version.attempts_left - 1,
      status = 'rendering',
      lease_expires_at = ${leaseEnd}
    from next
    where clip_version.id = next.id
    returning clip_version.id, clip_version.attempt, clip_version.attempts_left as "attemptsLeft"`);
  if (!row) {
    return null;
  }
  if (row.attemptsLeft < 0) {
    await settle(tx, row, { status: "failed", error: ABANDONED });
    return claimNext(tx);
  }
  const [found] = await tx
    .select({
      version: clipVersion,
      sourcePath: job.sourcePath,
      durationSeconds: transcript.durationSeconds,
      segments: transcript.segments,
    })
    .from(clipVersion)
    .innerJoin(clip, eq(clip.id, clipVersion.clipId))
    .innerJoin(job, eq(job.id, clip.jobId))
    .innerJoin(transcript, eq(transcript.jobId, clip.jobId))
    .where(eq(clipVersion.id, row.id));
  if (!found) {
    throw new Error(`Version ${row.id} has no transcript to caption from.`);
  }
  const { version, sourcePath, durationSeconds } = found;
  let plan: RenderPlan;
  try {
    const sources = jobSources(found);
    plan = resolvePlan(
      parseSettings(version.settings, sources, STAGE),
      sources,
      [
        {
          ref: { kind: "job" },
          file: sourcePath,
          kind: "video",
          duration: durationSeconds,
        },
      ]
    );
  } catch (error) {
    await settle(tx, row, {
      status: "failed",
      error: truncate(
        `This release can't render these settings: ${error instanceof Error ? error.message : String(error)}`
      ),
    });
    return claimNext(tx);
  }
  return {
    id: version.id,
    attempt: version.attempt,
    clipId: version.clipId,
    number: version.number,
    plan,
  };
}

function startVersionLease(
  db: Database,
  claimed: ClaimedVersion,
  shutdown: AbortSignal
): VersionLease {
  const { signal, lose, stop } = startHeartbeat(
    `version ${claimed.id}, attempt ${claimed.attempt}`,
    async () =>
      (
        await db
          .update(clipVersion)
          .set({ leaseExpiresAt: leaseEnd })
          .where(owns(claimed))
          .returning({ id: clipVersion.id })
      ).length > 0,
    shutdown
  );
  const end = async (values: Settled) => {
    stop();
    if (!(await db.transaction((tx) => settle(tx, claimed, values)))) {
      throw lose(NOT_HELD);
    }
  };
  return {
    version: claimed,
    signal,
    publish: (file) => end({ status: "ready", file }),
    fail: (error) => end({ status: "failed", error: truncate(error) }),
    release: async () => {
      stop();
      const refund = shutdown.aborted ? 1 : 0;
      await db
        .update(clipVersion)
        .set({
          leaseExpiresAt: sql`now()`,
          attemptsLeft: sql`${clipVersion.attemptsLeft} + ${refund}`,
        })
        .where(owns(claimed));
    },
  };
}

/**
 * The one terminal write. A single fenced UPDATE, so the row lock and the
 * ownership check are one step, and status, file or error, and the cleared
 * lease change together. False when the attempt no longer owns the row.
 */
async function settle(tx: Tx, owner: Owner, values: Settled): Promise<boolean> {
  const settled = await tx
    .update(clipVersion)
    .set({ ...values, leaseExpiresAt: null })
    .where(owns(owner))
    .returning({ id: clipVersion.id });
  return settled.length > 0;
}

function jobSources(row: {
  durationSeconds: number;
  segments: Segment[];
}): SourceCatalog {
  return [
    {
      ref: { kind: "job" },
      kind: "video",
      duration: row.durationSeconds,
      words: wordsOf(row.segments),
    },
  ];
}

function original(row: {
  clipId: string;
  title: string;
  start: number;
  end: number;
}): EditDraft {
  return {
    version: 2,
    name: row.title,
    segments: [
      {
        id: row.clipId,
        source: { kind: "job" },
        start: row.start,
        end: row.end,
        cropX: DEFAULTS.cropX,
        cropY: DEFAULTS.cropY,
        volume: DEFAULTS.volume,
        transition: { kind: "cut" },
        captions: [],
      },
    ],
    aspectRatio: DEFAULTS.aspectRatio,
    fps: DEFAULTS.fps,
    quality: DEFAULTS.quality,
    captionsEnabled: true,
    texts: [],
    images: [],
    audio: null,
    effect: null,
    watermark: null,
  };
}

/** A replay compares JSON as stored, so key order and -0 cannot make equal settings differ. */
function replay(
  existing: VersionRow,
  document: EditDraft
): CreateVersionResult {
  if (existing.deletedAt) {
    return failure(
      "deleted",
      `This export request made version ${existing.number}, which was deleted.`
    );
  }
  return isDeepStrictEqual(
    existing.settings,
    JSON.parse(JSON.stringify(document))
  )
    ? { ok: true, version: toView(existing) }
    : failure(
        "request-reused",
        `This export request already made version ${existing.number} with other settings.`
      );
}

function refused(error: unknown): CreateVersionResult {
  if (!(error instanceof SettingsError)) {
    throw error;
  }
  return {
    ok: false,
    reason: error.reason,
    message: error.message,
    issues: error.issues,
  };
}

function failure(
  reason: "not-found" | "request-reused" | "deleted",
  message: string
): CreateVersionResult {
  return { ok: false, reason, message, issues: [] };
}

function toView(row: VersionRow): VersionView {
  const settings = parseDocument(row.settings) as EditSettings;
  return {
    number: row.number,
    status: row.status,
    active: row.status === "queued" || row.status === "rendering",
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    settings,
    duration: schedule(settings).totalFrames / settings.fps,
    missingAssetIds: assetIdsOf(settings),
  };
}
