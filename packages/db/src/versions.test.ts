import "varlock/auto-load";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, afterEach, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";
import type { EditDraft, Segment } from "./editor";
import { ENV } from "./env";
import { createDb } from "./index";
import { claimJob, createJob, getSourceFile, type Transcript } from "./jobs";
import { user } from "./schema/auth";
import { clipVersion } from "./schema/job";
import {
  claimVersion,
  createVersion,
  getClipEditor,
  getVersionFile,
  listVersions,
  type VersionLease,
  type VersionView,
} from "./versions";

const db = createDb(ENV);
const userId = `versions-test-${randomUUID()}`;
const shutdown = new AbortController();
const leases: VersionLease[] = [];
const HEARTBEAT_WAIT_MS = 20_000;
const ABANDONED_ERROR = /worker stopped 3 times/u;
const REFUSED_ERROR = /can't render these settings/u;

const word = (i: number) => ({ start: i, end: i + 0.5, text: `word${i}` });
const talk: Transcript = {
  language: "en",
  durationSeconds: 120,
  segments: [
    {
      start: 0,
      end: 20,
      text: "",
      words: Array.from({ length: 20 }, (_, i) => word(i)),
    },
    {
      start: 20,
      end: 40,
      text: "",
      words: Array.from({ length: 20 }, (_, i) => word(20 + i)),
    },
  ],
};

let jobId = "";
let readyClipId = "";
let failedClipId = "";

const segment = (overrides: Partial<Segment> = {}): Segment => ({
  id: "00000000-0000-4000-8000-000000000001",
  source: { kind: "job" },
  start: 5,
  end: 25,
  cropX: 0.2,
  cropY: 0.5,
  volume: 1,
  transition: { kind: "cut" },
  captions: [],
  ...overrides,
});
const settings = (
  overrides: Partial<EditDraft> = {},
  segmentOverrides: Partial<Segment> = {}
): EditDraft => ({
  version: 2,
  name: "Version",
  segments: [segment(segmentOverrides)],
  aspectRatio: "9:16",
  fps: 30,
  quality: "high",
  captionsEnabled: true,
  texts: [],
  images: [],
  audio: null,
  effect: null,
  watermark: null,
  ...overrides,
});
const pin = (first: number, last: number, lines: string[]) => ({
  anchor: { kind: "words" as const, first, last },
  timing: null,
  lines,
});

before(async () => {
  await db.insert(user).values({
    id: userId,
    name: "versions.test.ts",
    email: `${userId}@example.invalid`,
  });
  jobId = await createJob(db, {
    userId,
    sourceName: "talk.mp4",
    sourcePath: "sources/talk",
    clipCount: 2,
    language: null,
  });
  const lease = await claimJob(db, { signal: shutdown.signal });
  assert.equal(lease?.job.id, jobId, "the seeded job was claimed");
  await lease.saveTranscript(talk);
  const [ready, failed] = await lease.saveMoments([
    {
      startSeconds: 0,
      endSeconds: 20,
      title: "Ready clip",
      reason: "r",
      score: 9,
    },
    {
      startSeconds: 30,
      endSeconds: 50,
      title: "Failed clip",
      reason: "r",
      score: 8,
    },
  ]);
  assert.ok(ready && failed, "both moments became clips");
  await lease.publishClip(ready.id, "clips/ready.mp4");
  await lease.failClip(failed.id, "ffmpeg exited with code 1");
  await lease.finish();
  readyClipId = ready.id;
  failedClipId = failed.id;
});

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  await db.delete(clipVersion).where(eq(clipVersion.clipId, readyClipId));
});

after(async () => {
  await db.delete(user).where(eq(user.id, userId));
  await db.$client.end();
});

async function create(
  edit: EditDraft = settings(),
  requestId: string = randomUUID()
): Promise<VersionView> {
  const result = await createVersion(db, userId, {
    clipId: readyClipId,
    requestId,
    settings: edit,
  });
  assert.ok(result.ok, `created: ${result.ok ? "" : result.message}`);
  return result.version;
}

async function claim(signal = shutdown.signal): Promise<VersionLease> {
  const lease = await claimVersion(db, { signal });
  assert.ok(lease, "a version was claimed");
  leases.push(lease);
  return lease;
}

const byNumber = (number: number) =>
  and(eq(clipVersion.clipId, readyClipId), eq(clipVersion.number, number));

const expire = (number: number) =>
  db
    .update(clipVersion)
    .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
    .where(byNumber(number));

const snapshot = async (number: number) =>
  (await db.select().from(clipVersion).where(byNumber(number)))[0];

test("versions are numbered per clip and a resubmitted request returns its version, but not with other settings", async () => {
  const requestId = randomUUID();
  const draft = settings(
    {},
    { captions: [pin(6, 8, ["  Edited ", "caption"])] }
  );
  const first = await create(draft, requestId);
  assert.deepEqual(
    [first.number, first.status, first.active, first.error, first.duration],
    [1, "queued", true, null, 20]
  );
  assert.deepEqual(first.settings.segments[0]?.captions, [
    pin(6, 8, ["Edited", "caption"]),
  ]);
  assert.deepEqual(first.missingAssetIds, []);
  assert.deepEqual(
    await create(draft, requestId),
    first,
    "same request, same version"
  );
  assert.deepEqual(
    await create(
      settings({}, { captions: [pin(6, 8, ["Edited", "caption"])] }),
      requestId
    ),
    first,
    "settings that clean to the same document are the same request"
  );

  const reused = await createVersion(db, userId, {
    clipId: readyClipId,
    requestId,
    settings: settings({}, { cropX: 0.8 }),
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.ok || reused.reason, "request-reused");

  const second = await create(settings({ captionsEnabled: false }));
  assert.equal(second.number, 2);
  assert.deepEqual(
    (await listVersions(db, userId, readyClipId))?.map((v) => v.number),
    [2, 1],
    "newest first"
  );
});

test("concurrent exports get numbers 1 to 5, and concurrent resubmits share one version", async () => {
  const numbers = await Promise.all(
    Array.from({ length: 5 }, async () => (await create()).number)
  );
  assert.deepEqual(
    numbers.toSorted((a, b) => a - b),
    [1, 2, 3, 4, 5]
  );

  const requestId = randomUUID();
  const resubmits = await Promise.all(
    Array.from(
      { length: 3 },
      async () => (await create(settings(), requestId)).number
    )
  );
  assert.deepEqual(resubmits, [6, 6, 6]);
  assert.equal((await listVersions(db, userId, readyClipId))?.length, 6);
});

test("only the owner's ready clips get versions, only inside the source and its words, and only what this stage allows", async () => {
  const refused = async (clipId: string, edit: unknown, owner = userId) => {
    const result = await createVersion(db, owner, {
      clipId,
      requestId: randomUUID(),
      settings: edit as EditDraft,
    });
    return result.ok ? "created" : result.reason;
  };
  assert.equal(await refused(failedClipId, settings()), "not-found");
  assert.equal(
    await refused(readyClipId, settings(), "someone-else"),
    "not-found"
  );
  assert.equal(await refused(randomUUID(), settings()), "not-found");
  assert.equal(
    await refused(readyClipId, settings({}, { start: 100, end: 120.01 })),
    "invalid-settings"
  );
  assert.equal(
    await refused(
      readyClipId,
      settings({}, { captions: [pin(39, 40, ["x"])] })
    ),
    "invalid-settings"
  );
  assert.equal(
    await refused(
      readyClipId,
      settings(
        {},
        { start: 0, end: 120, captions: [pin(39, 39, ["last word"])] }
      )
    ),
    "created",
    "a trim far past the original clip, up to the source's end, is fine"
  );
  assert.equal(
    await refused(readyClipId, { ...settings(), extra: true }),
    "invalid-settings",
    "settings that skip the schema never reach the table"
  );
  const unsupported = await createVersion(db, userId, {
    clipId: readyClipId,
    requestId: randomUUID(),
    settings: settings({ quality: "low" }, { cropY: 0.4 }),
  });
  assert.deepEqual(
    unsupported.ok
      ? null
      : [unsupported.reason, unsupported.issues.map((issue) => issue.path)],
    ["unsupported-feature", [["quality"], ["segments", 0, "cropY"]]]
  );
});

test("the editor's reads answer only the clip's owner", async () => {
  const editor = await getClipEditor(db, userId, readyClipId);
  const job = editor?.sources[0];
  assert.deepEqual(editor && { ...editor, sources: editor.sources.length }, {
    clipId: readyClipId,
    jobId,
    rank: 1,
    title: "Ready clip",
    original: {
      version: 2,
      name: "Ready clip",
      segments: [
        {
          id: readyClipId,
          source: { kind: "job" },
          start: 0,
          end: 20,
          cropX: 0.5,
          cropY: 0.5,
          volume: 1,
          transition: { kind: "cut" },
          captions: [],
        },
      ],
      aspectRatio: "9:16",
      fps: 30,
      quality: "high",
      captionsEnabled: true,
      texts: [],
      images: [],
      audio: null,
      effect: null,
      watermark: null,
    },
    sources: 1,
    jobPreviewUrl: `/api/jobs/${jobId}/source`,
    presets: [
      {
        clipId: readyClipId,
        title: "Ready clip",
        range: { start: 0, end: 20 },
      },
    ],
    assets: [],
    capabilities: {
      stage: 1,
      enabled: ["trim", "cropX", "captions"],
      stock: false,
    },
  });
  assert.deepEqual(
    job && "words" in job
      ? [job.duration, job.words.length, job.words[20]]
      : null,
    [120, 40, word(20)],
    "words of every segment, in one index space"
  );
  assert.equal(await getClipEditor(db, "someone-else", readyClipId), null);
  assert.equal(await getClipEditor(db, userId, failedClipId), null);

  assert.equal(await listVersions(db, "someone-else", readyClipId), null);
  assert.deepEqual(await listVersions(db, userId, failedClipId), []);

  assert.deepEqual(await getSourceFile(db, userId, jobId), {
    file: "sources/talk",
    sourceName: "talk.mp4",
  });
  assert.equal(await getSourceFile(db, "someone-else", jobId), null);

  const { number } = await create(settings({ name: "My cut" }));
  assert.equal(
    await getVersionFile(db, userId, readyClipId, number),
    null,
    "not ready yet"
  );
  const lease = await claim();
  await lease.publish("versions/ready-v1.mp4");
  assert.deepEqual(await getVersionFile(db, userId, readyClipId, number), {
    file: "versions/ready-v1.mp4",
    number,
    name: "My cut",
  });
  assert.equal(
    await getVersionFile(db, "someone-else", readyClipId, number),
    null
  );
  assert.deepEqual(
    await Promise.all(
      [0, 2, 40_000, 1.5, 2 ** 31].map((missing) =>
        getVersionFile(db, userId, readyClipId, missing)
      )
    ),
    [null, null, null, null, null]
  );
});

test("a deleted version vanishes from reads, keeps its number, and its request never makes another", async () => {
  const requestId = randomUUID();
  const { number } = await create(settings(), requestId);
  const lease = await claim();
  await lease.publish("versions/gone.mp4");
  await db
    .update(clipVersion)
    .set({ deletedAt: new Date() })
    .where(byNumber(number));
  assert.deepEqual(await listVersions(db, userId, readyClipId), []);
  assert.equal(await getVersionFile(db, userId, readyClipId, number), null);
  const replayed = await createVersion(db, userId, {
    clipId: readyClipId,
    requestId,
    settings: settings(),
  });
  assert.equal(replayed.ok || replayed.reason, "deleted");
  assert.equal((await create()).number, number + 1, "the number is not reused");
});

test("a claim hands the worker a plan: the stored settings, their schedule, the job source, and the segment's cues", async () => {
  await create(settings({}, { captions: [pin(6, 8, ["Edited", "caption"])] }));
  const { version } = await claim();
  const { plan } = version;
  assert.deepEqual(
    plan.settings,
    settings({}, { captions: [pin(6, 8, ["Edited", "caption"])] })
  );
  assert.deepEqual(plan.inputs, [
    {
      ref: { kind: "job" },
      file: "sources/talk",
      kind: "video",
      duration: 120,
    },
  ]);
  assert.equal(plan.schedule.totalFrames, 600);
  const cues = plan.captions[0]?.cues ?? [];
  assert.deepEqual(
    cues.find((cue) => cue.lines[0] === "Edited"),
    { startCs: 100, endCs: 390, lines: ["Edited", "caption"] },
    "the edit covers words 6 to 8, one second after the trim starts"
  );
  assert.ok(
    cues.every((cue) => cue.endCs <= 2000),
    "cues stay inside the trim"
  );
  assert.deepEqual(
    [version.number, version.attempt, version.clipId],
    [1, 1, readyClipId]
  );

  await create(settings({ captionsEnabled: false }));
  const quiet = (await claim()).version.plan;
  assert.deepEqual(quiet.captions[0]?.cues, [], "captions off renders none");
});

test("a stored version this release refuses fails under its fence, and the claim moves on", async () => {
  await db.insert(clipVersion).values({
    clipId: readyClipId,
    requestId: randomUUID(),
    number: 1,
    settings: { version: 2 },
    attemptsLeft: 3,
    createdAt: new Date(0),
  });
  const next = await create();
  assert.equal((await claim()).version.number, next.number);
  const failed = await snapshot(1);
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", REFUSED_ERROR);
});

const staleWrites: [string, (lease: VersionLease) => Promise<void>][] = [
  ["publish", (lease) => lease.publish("versions/stale.mp4")],
  ["fail", (lease) => lease.fail("stale")],
];

for (const [method, write] of staleWrites) {
  test(`${method} from a reclaimed lease writes nothing and aborts its signal`, async () => {
    const { number } = await create();
    const stale = await claim();
    await expire(number);
    const fresh = await claim();
    assert.equal(fresh.version.id, stale.version.id);
    assert.equal(fresh.version.attempt, stale.version.attempt + 1);
    const untouched = await snapshot(number);

    await assert.rejects(
      write(stale),
      (error) => error === stale.signal.reason
    );
    assert.equal(stale.signal.aborted, true);
    assert.deepEqual(await snapshot(number), untouched);

    await fresh.publish("versions/fresh.mp4");
    assert.equal(fresh.signal.aborted, false);
    assert.deepEqual(
      [(await snapshot(number))?.status, (await snapshot(number))?.file],
      ["ready", "versions/fresh.mp4"]
    );
  });
}

test("an expired lease cannot publish even before anyone reclaims it", async () => {
  const { number } = await create();
  const lease = await claim();
  await expire(number);
  await assert.rejects(lease.publish("versions/late.mp4"));
  assert.equal((await snapshot(number))?.status, "rendering");
});

test("a heartbeat after the lease expired does not revive it", {
  timeout: HEARTBEAT_WAIT_MS + 10_000,
}, async () => {
  const { number } = await create();
  const lease = await claim();
  await expire(number);
  const expired = await snapshot(number);

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
    await snapshot(number),
    expired,
    "the heartbeat left the lease expired"
  );

  const next = await claim();
  assert.equal(next.version.id, lease.version.id);
  assert.equal(next.version.attempt, lease.version.attempt + 1);
});

test("concurrent claims never return the same version", async () => {
  const created = await Promise.all(Array.from({ length: 6 }, () => create()));
  const claimed = await Promise.all(created.map(() => claim()));
  assert.deepEqual(
    new Set(claimed.map((lease) => lease.version.number)),
    new Set(created.map((version) => version.number))
  );
  assert.equal(await claimVersion(db, { signal: shutdown.signal }), null);
});

test("release hands the version back and refunds the attempt only on shutdown", async () => {
  const { number } = await create();
  const attemptsLeft = async () => (await snapshot(number))?.attemptsLeft;

  await (await claim()).release();
  assert.equal(
    await attemptsLeft(),
    2,
    "a release without shutdown spends the attempt"
  );

  const stopping = new AbortController();
  const lease = await claim(stopping.signal);
  assert.equal(
    lease.version.number,
    number,
    "the released version was claimable at once"
  );
  stopping.abort();
  await lease.release();
  assert.equal(
    await attemptsLeft(),
    2,
    "a release on shutdown refunds the attempt"
  );

  const done = await claim();
  await done.publish("versions/done.mp4");
  await done.release();
  assert.equal(
    (await snapshot(number))?.status,
    "ready",
    "release after publish is a no-op"
  );
});

test("a version whose worker stopped three times fails and the claim moves on", async () => {
  const abandoned = await create();
  const next = await create();
  await db
    .update(clipVersion)
    .set({ createdAt: new Date(0) })
    .where(byNumber(abandoned.number));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each claim must see the previous lease expire
    await claim();
    await expire(abandoned.number);
  }
  assert.equal((await claim()).version.number, next.number);
  const failed = (await listVersions(db, userId, readyClipId))?.find(
    (v) => v.number === abandoned.number
  );
  assert.deepEqual([failed?.status, failed?.active], ["failed", false]);
  assert.match(failed?.error ?? "", ABANDONED_ERROR);
});

test("the table refuses rows outside the rules even from a buggy writer", async () => {
  const valid = {
    clipId: readyClipId,
    requestId: randomUUID(),
    number: 1,
    settings: settings(),
    attemptsLeft: 3,
  };
  const violations: [string, Record<string, unknown>][] = [
    ["clip_version_number", { number: 0 }],
    ["clip_version_settings", { settings: [] }],
    ["clip_version_settings", { settings: { ...settings(), version: 1 } }],
    ["clip_version_lease_iff_rendering", { status: "rendering" }],
    ["clip_version_lease_iff_rendering", { leaseExpiresAt: new Date() }],
    ["clip_version_file_iff_ready", { status: "ready" }],
    ["clip_version_file_iff_ready", { file: "versions/x.mp4" }],
    ["clip_version_deleted_when_done", { deletedAt: new Date() }],
    ["clip_version_purged_after_delete", { filePurgedAt: new Date() }],
  ];
  for (const [constraint, change] of violations) {
    // biome-ignore lint/performance/noAwaitInLoops: one insert per violated rule
    await assert.rejects(
      db
        .insert(clipVersion)
        .values({ ...valid, ...change } as typeof clipVersion.$inferInsert),
      (error: { cause?: { constraint?: string } }) =>
        error.cause?.constraint === constraint,
      constraint
    );
  }
  await db.insert(clipVersion).values({ ...valid, number: 2 ** 31 - 1 });
});
