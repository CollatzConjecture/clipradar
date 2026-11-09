import "varlock/auto-load";

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createDb, type Database } from "@clipradar/db";
import { clipCues, wordsOf } from "@clipradar/db/captions";
import { DEFAULTS } from "@clipradar/db/editor";
import {
  claimJob,
  type Lease,
  type PendingClip,
  runningAttempts,
  type Transcript,
  type Word,
} from "@clipradar/db/jobs";
import {
  clearTrash,
  mediaReferences,
  trashedBefore,
} from "@clipradar/db/media";
import {
  claimVersion,
  runningVersions,
  type VersionLease,
} from "@clipradar/db/versions";

import { ENV } from "./env";
import { extractAudio, renderClip, renderTimeline } from "./ffmpeg";
import { type LlmConfig, selectMoments } from "./select";
import { type MediaFile, orphans, trashTarget } from "./sweep";
import { transcribe } from "./whisper";

const IDLE_POLL_MS = 2000;
const SWEEP_EVERY_MS = 10 * 60_000;
/** Many heartbeats, so a worker rendering a deleted job has stopped writing to its folders. */
const TRASH_WAIT_SECONDS = 120;
const NO_MOMENTS =
  "No 15 to 60 second moment in this video stood on its own as a short. Videos with more continuous speech work better. Retry to ask the LLM again.";
const NO_SPEECH =
  "No speech in this clip's time range, so captions can't be made.";

const dataDir = resolve(ENV.DATA_DIR);
const llm: LlmConfig = {
  baseUrl: ENV.LLM_BASE_URL,
  apiKey: ENV.LLM_API_KEY || null,
  model: ENV.LLM_MODEL,
  maxTranscriptChars: ENV.LLM_MAX_TRANSCRIPT_CHARS,
};

/**
 * One lane per queue, each working one item at a time, so a long
 * transcription never delays an export and exports never delay a job.
 */
async function main(): Promise<void> {
  const db = createDb(ENV);
  const shutdown = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => shutdown.abort());
  }
  log(`worker started, media in ${dataDir}`);
  await Promise.all([
    lane(
      shutdown.signal,
      () => claimJob(db, { signal: shutdown.signal }),
      processJob
    ),
    lane(
      shutdown.signal,
      () => claimVersion(db, { signal: shutdown.signal }),
      renderVersion
    ),
    sweeper(db, shutdown.signal),
  ]);
  await db.$client.end();
  log("worker stopped");
}

async function lane<L extends { release: () => Promise<void> }>(
  shutdown: AbortSignal,
  claim: () => Promise<L | null>,
  work: (lease: L) => Promise<void>
): Promise<void> {
  // ponytail: polls every 2 s. LISTEN/NOTIFY on insert if idle queries ever matter.
  while (!shutdown.aborted) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one item at a time per lane is the design
      const lease = await claim();
      if (lease) {
        try {
          await work(lease);
        } finally {
          await lease.release();
        }
        continue;
      }
    } catch (error) {
      log(`error: ${errorMessage(error)}`);
    }
    await sleep(IDLE_POLL_MS, undefined, { signal: shutdown }).catch(
      () => undefined
    );
  }
}

async function processJob(lease: Lease): Promise<void> {
  const { job, signal } = lease;
  const source = join(dataDir, job.sourcePath);
  const scratch = join(dataDir, "scratch", `${job.id}-${job.attempt}`);
  const tag = `job=${job.id} attempt=${job.attempt}`;
  log(`${tag} stage=${job.stage} claimed`);
  await mkdir(scratch, { recursive: true });
  try {
    const transcript = await ensureTranscript(lease, source, scratch);
    const clips = await ensureClips(lease, transcript);
    if (clips === null) {
      log(`${tag} failed: no moments`);
      await lease.finish(NO_MOMENTS);
      return;
    }
    const words = wordsOf(transcript.segments);
    for (const clip of clips) {
      // biome-ignore lint/performance/noAwaitInLoops: rank order, so the best clip is ready first
      await renderAndPublish(lease, clip, source, words, scratch);
    }
    await lease.finish();
    log(`${tag} finished`);
  } catch (error) {
    if (signal.aborted) {
      log(`${tag} stopped: ${errorMessage(signal.reason)}`);
      return;
    }
    log(`${tag} failed: ${errorMessage(error)}`);
    await lease.finish(errorMessage(error));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function ensureTranscript(
  lease: Lease,
  source: string,
  scratch: string
): Promise<Transcript> {
  const { job, signal } = lease;
  if (job.stage !== "transcribing") {
    return job.transcript;
  }
  const audio = join(scratch, "audio.ogg");
  await extractAudio(source, audio, signal);
  const transcript = await transcribe({
    url: ENV.WHISPER_URL,
    audioFile: audio,
    language: job.language,
    timeoutMinutes: ENV.WHISPER_TIMEOUT_MINUTES,
    signal,
  });
  await lease.saveTranscript(transcript);
  log(
    `job=${job.id} transcribed ${transcript.segments.length} segments (${transcript.language})`
  );
  return transcript;
}

async function ensureClips(
  lease: Lease,
  transcript: Transcript
): Promise<PendingClip[] | null> {
  const { job, signal } = lease;
  if (job.stage === "rendering") {
    return job.clips;
  }
  const moments = await selectMoments(transcript, job.clipCount, llm, signal);
  if (moments.length === 0) {
    return null;
  }
  const clips = await lease.saveMoments(moments);
  log(`job=${job.id} selected ${clips.length} moments`);
  return clips;
}

async function renderAndPublish(
  lease: Lease,
  clip: PendingClip,
  source: string,
  words: readonly Word[],
  scratch: string
): Promise<void> {
  const tag = `job=${lease.job.id} clip=${clip.rank}`;
  const rendered = join(scratch, `clip-${clip.rank}.mp4`);
  try {
    const cues = clipCues(words, {
      start: clip.startSeconds,
      end: clip.endSeconds,
    });
    if (cues.length === 0) {
      throw new Error(NO_SPEECH);
    }
    await renderClip(
      {
        source,
        out: rendered,
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        cropX: DEFAULTS.cropX,
        cues,
      },
      lease.signal
    );
  } catch (error) {
    if (lease.signal.aborted) {
      throw error;
    }
    log(`${tag} failed: ${errorMessage(error)}`);
    await lease.failClip(clip.id, errorMessage(error));
    return;
  }
  const file = join(
    "clips",
    lease.job.id,
    `${clip.id}-${lease.job.attempt}.mp4`
  );
  const absolute = join(dataDir, file);
  await mkdir(dirname(absolute), { recursive: true });
  await rename(rendered, absolute);
  await lease.publishClip(clip.id, file);
  log(`${tag} ready`);
}

/**
 * Renders into attempt-specific scratch, renames the file into versions/,
 * then publishes under the fence. A lost lease writes nothing, and a file
 * whose publish never committed is left for the media sweep, as clips are.
 */
async function renderVersion(lease: VersionLease): Promise<void> {
  const { version, signal } = lease;
  const tag = `version=${version.id} attempt=${version.attempt} clip=${version.clipId} v${version.number}`;
  log(`${tag} claimed`);
  const scratch = join(dataDir, "scratch", `${version.id}-${version.attempt}`);
  await mkdir(scratch, { recursive: true });
  try {
    const rendered = await renderTimeline(version.plan, {
      dataDir,
      scratch,
      signal,
    });
    const file = join(
      "versions",
      version.clipId,
      `${version.id}-${version.attempt}.mp4`
    );
    const absolute = join(dataDir, file);
    await mkdir(dirname(absolute), { recursive: true });
    await rename(rendered, absolute);
    await lease.publish(file);
    log(`${tag} ready`);
  } catch (error) {
    if (signal.aborted) {
      log(`${tag} stopped: ${errorMessage(signal.reason)}`);
      return;
    }
    log(`${tag} failed: ${errorMessage(error)}`);
    await lease.fail(errorMessage(error));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Its own loop, so a long job never holds up the sweeps. Each sweep only
 * removes what no running attempt can still be writing.
 */
async function sweeper(db: Database, shutdown: AbortSignal): Promise<void> {
  while (!shutdown.aborted) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one sweep at a time, every SWEEP_EVERY_MS
      await sweepScratch(db);
      await sweepMedia(db);
    } catch (error) {
      log(`sweep error: ${errorMessage(error)}`);
    }
    await sleep(SWEEP_EVERY_MS, undefined, { signal: shutdown }).catch(
      () => undefined
    );
  }
}

async function sweepScratch(db: Database): Promise<void> {
  const dir = join(dataDir, "scratch");
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.length === 0) {
    return;
  }
  const [jobs, versions] = await Promise.all([
    runningAttempts(db),
    runningVersions(db),
  ]);
  const live = new Set([
    ...jobs.map(({ jobId, attempt }) => `${jobId}-${attempt}`),
    ...versions.map(({ id, attempt }) => `${id}-${attempt}`),
  ]);
  const stale = names.filter((name) => !live.has(name));
  await Promise.all(
    stale.map((name) => rm(join(dir, name), { recursive: true, force: true }))
  );
  if (stale.length > 0) {
    log(`swept ${stale.length} stale scratch directories`);
  }
}

/** Removes what deletes trashed, then files in live folders that no row names. */
async function sweepMedia(db: Database): Promise<void> {
  const trashed = await trashedBefore(db, TRASH_WAIT_SECONDS);
  await Promise.all(
    trashed.map(async (path) => {
      const target = trashTarget(dataDir, path);
      if (target) {
        await rm(target, { recursive: true, force: true });
      } else {
        log(`dropped trash entry outside the media folders: ${path}`);
      }
    })
  );
  await clearTrash(db, trashed);
  const refs = await mediaReferences(db);
  const files = await Promise.all(["clips", "versions"].map(listMedia));
  const stale = orphans(files.flat(), refs, Date.now());
  await Promise.all(
    stale.map((path) => rm(join(dataDir, path), { force: true }))
  );
  if (trashed.length + stale.length > 0) {
    log(
      `swept ${trashed.length} deleted paths and ${stale.length} orphan files`
    );
  }
}

/** Every file in the folders one level under a media folder. */
async function listMedia(top: string): Promise<MediaFile[]> {
  const list = (dir: string) =>
    readdir(join(dataDir, dir)).catch(() => [] as string[]);
  const parents = await list(top);
  const files = await Promise.all(
    parents.map(async (parent) => {
      const names = await list(join(top, parent));
      return Promise.all(
        names.map(async (name) => {
          const path = join(top, parent, name);
          const info = await stat(join(dataDir, path)).catch(() => null);
          return info?.isFile() ? { path, mtimeMs: info.mtimeMs } : null;
        })
      );
    })
  );
  return files.flat().filter((file) => file !== null);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

await main();
