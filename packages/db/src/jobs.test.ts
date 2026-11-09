import "varlock/auto-load";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, afterEach, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { ENV } from "./env";
import { createDb } from "./index";
import {
  claimJob,
  createJob,
  deleteJob,
  getClipFile,
  getJob,
  type Lease,
  listJobs,
  type Moment,
  retryJob,
  type Transcript,
} from "./jobs";
import { clearTrash, mediaReferences, trashedBefore } from "./media";
import { user } from "./schema/auth";
import { job } from "./schema/job";

const db = createDb(ENV);
const userId = `jobs-test-${randomUUID()}`;
const shutdown = new AbortController();
const leases: Lease[] = [];
const HEARTBEAT_WAIT_MS = 20_000;
const ABANDONED_ERROR = /worker stopped/u;

const talk: Transcript = {
  language: "en",
  durationSeconds: 120,
  segments: [
    {
      start: 0,
      end: 2,
      text: "hello world",
      words: [
        { start: 0, end: 1, text: "hello" },
        { start: 1, end: 2, text: "world" },
      ],
    },
  ],
};

const moments: Moment[] = [
  {
    startSeconds: 0,
    endSeconds: 20,
    title: "Third by score",
    reason: "hook",
    score: 7,
  },
  {
    startSeconds: 30,
    endSeconds: 50,
    title: "First by score",
    reason: "hook",
    score: 9,
  },
  {
    startSeconds: 60,
    endSeconds: 80,
    title: "Second by score",
    reason: "hook",
    score: 8,
  },
];

before(async () => {
  await db.insert(user).values({
    id: userId,
    name: "jobs.test.ts",
    email: `${userId}@example.invalid`,
  });
});

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  await db.delete(job).where(eq(job.userId, userId));
});

after(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await db.$client.end();
});

async function queueJob(createdAt = new Date(0)): Promise<string> {
  const id = await createJob(db, {
    userId,
    sourceName: "talk.mp4",
    sourcePath: `sources/${randomUUID()}`,
    clipCount: moments.length,
    language: null,
  });
  await db.update(job).set({ createdAt }).where(eq(job.id, id));
  return id;
}

async function claim(signal = shutdown.signal): Promise<Lease> {
  const lease = await claimJob(db, { signal });
  assert.ok(lease, "a job was claimed");
  leases.push(lease);
  return lease;
}

const expire = (jobId: string) =>
  db
    .update(job)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(eq(job.id, jobId));

const snapshot = (jobId: string) =>
  db.query.job.findFirst({
    where: { id: jobId },
    with: { clips: { orderBy: { rank: "asc" } }, transcript: true },
  });

async function claimToRendering() {
  const jobId = await queueJob();
  const lease = await claim();
  await lease.saveTranscript(talk);
  const [first, second, third] = await lease.saveMoments(moments);
  assert.ok(first && second && third, "every moment became a clip");
  return { jobId, lease, clips: [first, second, third] as const };
}

const staleWrites: [
  string,
  (lease: Lease, clipId: string) => Promise<unknown>,
][] = [
  ["saveTranscript", (lease) => lease.saveTranscript(talk)],
  ["saveMoments", (lease) => lease.saveMoments(moments)],
  [
    "publishClip",
    (lease, clipId) => lease.publishClip(clipId, "clips/stale.mp4"),
  ],
  ["failClip", (lease, clipId) => lease.failClip(clipId, "stale")],
  ["finish", (lease) => lease.finish("stale")],
];

for (const [method, write] of staleWrites) {
  test(`${method} from a reclaimed lease writes nothing and aborts its signal`, async () => {
    const {
      jobId,
      lease: stale,
      clips: [first],
    } = await claimToRendering();
    await expire(jobId);
    const fresh = await claim();
    assert.equal(fresh.job.id, jobId);
    const untouched = await snapshot(jobId);

    await assert.rejects(
      write(stale, first.id),
      (error) => error === stale.signal.reason
    );
    assert.equal(stale.signal.aborted, true);
    assert.deepEqual(await snapshot(jobId), untouched);

    await fresh.publishClip(first.id, "clips/fresh.mp4");
    assert.equal(fresh.signal.aborted, false);
  });
}

test("a heartbeat after the lease expired does not revive it", {
  timeout: HEARTBEAT_WAIT_MS + 10_000,
}, async () => {
  const jobId = await queueJob();
  const lease = await claim();
  await expire(jobId);
  const expired = await snapshot(jobId);

  await once(
    AbortSignal.any([lease.signal, AbortSignal.timeout(HEARTBEAT_WAIT_MS)]),
    "abort"
  );
  assert.equal(
    lease.signal.aborted,
    true,
    "the next heartbeat gave the lease up"
  );
  assert.deepEqual(
    await snapshot(jobId),
    expired,
    "the heartbeat left the lease expired"
  );

  const next = await claim();
  assert.equal(next.job.id, jobId);
  assert.equal(next.job.attempt, lease.job.attempt + 1);
});

test("retrying a partial job claims it at rendering with only the failed clips pending", async () => {
  const {
    jobId,
    lease,
    clips: [ready, failed, unrendered],
  } = await claimToRendering();
  await lease.publishClip(ready.id, "clips/ready.mp4");
  await assert.rejects(
    lease.publishClip(ready.id, "clips/other.mp4"),
    "a ready clip is final"
  );
  await lease.failClip(failed.id, "ffmpeg exited with code 1");
  await lease.finish();

  const partial = await getJob(db, userId, jobId);
  assert.equal(partial?.status, "partial");
  assert.equal(partial.canRetry, true);
  assert.deepEqual(
    partial.clips.map((c) => [c.title, c.status]),
    [
      ["First by score", "ready"],
      ["Second by score", "failed"],
      ["Third by score", "failed"],
    ]
  );
  const [summary] = await listJobs(db, userId);
  assert.deepEqual(
    [summary?.id, summary?.status, summary?.readyCount, summary?.totalCount],
    [jobId, "partial", 1, 3]
  );
  assert.equal(
    (await getClipFile(db, userId, ready.id))?.file,
    "clips/ready.mp4"
  );
  assert.equal(await getClipFile(db, userId, failed.id), null);
  assert.equal(await getClipFile(db, "someone-else", ready.id), null);

  const readyClip = async () =>
    (await snapshot(jobId))?.clips.find((c) => c.id === ready.id);
  const readyBefore = await readyClip();
  const queued = await retryJob(db, userId, jobId);
  assert.equal(queued?.status, "queued");
  assert.deepEqual(
    await retryJob(db, userId, jobId),
    queued,
    "a second retry changes nothing"
  );

  const resumed = (await claim()).job;
  assert.equal(resumed.id, jobId);
  assert.ok(
    resumed.stage === "rendering",
    "a partial job resumes at rendering"
  );
  assert.deepEqual(
    resumed.clips.map((c) => c.id),
    [failed.id, unrendered.id]
  );
  assert.deepEqual(resumed.transcript, talk);
  assert.deepEqual(
    await readyClip(),
    readyBefore,
    "the ready clip is untouched"
  );
});

test("concurrent claims never return the same job", async () => {
  const jobIds = await Promise.all(Array.from({ length: 8 }, () => queueJob()));
  const claimed = await Promise.all(jobIds.map(() => claim()));
  assert.deepEqual(
    new Set(claimed.map((lease) => lease.job.id)),
    new Set(jobIds)
  );
});

test("release hands the job back and refunds the attempt only on shutdown", async () => {
  const jobId = await queueJob();
  const attemptsLeft = async () => (await snapshot(jobId))?.attemptsLeft;

  await (await claim()).release();
  assert.equal(
    await attemptsLeft(),
    2,
    "a release without shutdown spends the attempt"
  );

  const stopping = new AbortController();
  const lease = await claim(stopping.signal);
  assert.equal(lease.job.id, jobId, "the released job was claimable at once");
  stopping.abort();
  await lease.release();
  assert.equal(
    await attemptsLeft(),
    2,
    "a release on shutdown refunds the attempt"
  );
});

test("a job whose worker stopped three times fails and the claim moves on", async () => {
  const abandoned = await queueJob();
  const next = await queueJob(new Date(1000));
  await claim();
  await expire(abandoned);
  await claim();
  await expire(abandoned);
  await claim();
  await expire(abandoned);

  assert.equal((await claim()).job.id, next);
  const view = await getJob(db, userId, abandoned);
  assert.equal(view?.status, "failed");
  assert.match(view.error ?? "", ABANDONED_ERROR);
});

test("steps and the rendering clip follow what is saved", async () => {
  const jobId = await queueJob();
  const view = async () => {
    const found = await getJob(db, userId, jobId);
    assert.ok(found, "the job is readable");
    return found;
  };
  const steps = async () => Object.values((await view()).steps);

  assert.deepEqual(await steps(), ["running", "waiting", "waiting", "waiting"]);
  const lease = await claim();
  assert.deepEqual(await steps(), ["done", "running", "waiting", "waiting"]);
  await lease.saveTranscript(talk);
  assert.deepEqual(await steps(), ["done", "done", "running", "waiting"]);
  const [first, second, third] = await lease.saveMoments(moments);
  assert.ok(first && second && third, "every moment became a clip");
  assert.deepEqual(await steps(), ["done", "done", "done", "running"]);
  assert.equal((await view()).renderingClipId, first.id);

  await lease.publishClip(first.id, "clips/first.mp4");
  assert.equal(
    (await view()).renderingClipId,
    second.id,
    "the next pending clip by rank renders next"
  );
  await lease.failClip(second.id, "ffmpeg exited with code 1");
  await lease.finish();
  assert.deepEqual(await steps(), ["done", "done", "done", "partial"]);
  assert.equal((await view()).renderingClipId, null);

  await retryJob(db, userId, jobId);
  assert.deepEqual(
    await steps(),
    ["running", "done", "done", "waiting"],
    "a retried job keeps its transcript and moments"
  );
  const [summary] = await listJobs(db, userId);
  assert.deepEqual(
    summary?.clips.map((c) => [c.rank, c.startSeconds, c.durationSeconds]),
    [
      [1, 30, 20],
      [2, 60, 20],
      [3, 0, 20],
    ]
  );
  assert.equal(summary.durationSeconds, talk.durationSeconds);
  assert.equal(summary.language, talk.language);
});

test("a failed job stops at its first step with nothing saved", async () => {
  const jobId = await queueJob();
  const lease = await claim();
  await lease.saveTranscript(talk);
  await lease.finish("The LLM rejected the API key.");
  const failed = await getJob(db, userId, jobId);
  assert.deepEqual(failed?.steps, {
    queued: "done",
    transcribing: "done",
    selecting: "failed",
    rendering: "waiting",
  });
});

/** Deletes the job at rendering and returns the paths its delete must have trashed. */
async function deleteRendering() {
  const { jobId, lease, clips } = await claimToRendering();
  const saved = await snapshot(jobId);
  assert.ok(saved, "the job exists");
  assert.equal(await deleteJob(db, userId, jobId), true);
  const trashed = [
    saved.sourcePath,
    `clips/${jobId}`,
    ...clips.map(({ id }) => `versions/${id}`),
  ];
  return { jobId, lease, clips, trashed };
}

test("only the owner deletes a job", async () => {
  const jobId = await queueJob();
  assert.equal(await deleteJob(db, `${userId}-someone-else`, jobId), false);
  assert.ok(
    await getJob(db, userId, jobId),
    "someone else's delete keeps the job"
  );
});

test("a deleted job's upload and folders wait in the trash until cleared", async () => {
  const { jobId, trashed } = await deleteRendering();
  const ours = (paths: string[]) =>
    paths.filter((path) => trashed.includes(path));
  try {
    assert.equal(await getJob(db, userId, jobId), null);
    assert.equal(
      await deleteJob(db, userId, jobId),
      false,
      "a second delete finds nothing"
    );
    assert.deepEqual(
      ours(await trashedBefore(db, 60)),
      [],
      "nothing has waited a minute yet"
    );
    assert.deepEqual(
      new Set(ours(await trashedBefore(db, 0))),
      new Set(trashed)
    );
  } finally {
    await clearTrash(db, trashed);
  }
  assert.deepEqual(
    ours(await trashedBefore(db, 0)),
    [],
    "cleared paths are forgotten"
  );
});

test("a worker holding a deleted job loses its lease at the next heartbeat", {
  timeout: HEARTBEAT_WAIT_MS + 10_000,
}, async () => {
  const { jobId, lease, clips, trashed } = await deleteRendering();
  try {
    await once(
      AbortSignal.any([lease.signal, AbortSignal.timeout(HEARTBEAT_WAIT_MS)]),
      "abort"
    );
    assert.equal(
      lease.signal.aborted,
      true,
      "the heartbeat found no job to hold"
    );
    await assert.rejects(
      lease.publishClip(clips[0].id, `clips/${jobId}/late.mp4`),
      (error) => error === lease.signal.reason
    );
  } finally {
    await clearTrash(db, trashed);
  }
});

test("media references name the folders and files rows still point at", async () => {
  const {
    jobId,
    lease,
    clips: [first, second],
  } = await claimToRendering();
  const file = `clips/${jobId}/${first.id}-1.mp4`;
  await lease.publishClip(first.id, file);

  const refs = await mediaReferences(db);
  assert.ok(refs.jobIds.has(jobId));
  assert.ok(refs.clipIds.has(first.id) && refs.clipIds.has(second.id));
  assert.ok(refs.files.has(file));
  assert.ok(
    !refs.files.has(`clips/${jobId}/${second.id}-1.mp4`),
    "a pending clip names no file"
  );
});
