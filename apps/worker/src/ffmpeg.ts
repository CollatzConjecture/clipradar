import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Cue } from "@clipradar/db/captions";
import type { RenderPlan } from "@clipradar/db/timeline";
import { spawn, write } from "bun";

import {
  assertRendered,
  buildRenderProgram,
  captionAss,
  type ProbeFacts,
  parseProbe,
} from "./render";

const AUDIO_TIMEOUT_MINUTES = 30;
const RENDER_TIMEOUT_MINUTES = 15;
const PROBE_TIMEOUT_MS = 60_000;
const VERSION_FILE = "version.mp4";
const STDERR_TAIL_LINES = 4;
const NO_AUDIO = /matches no streams/u;
const MP4 = /\.mp4$/u;

export async function extractAudio(
  source: string,
  out: string,
  signal: AbortSignal
): Promise<void> {
  try {
    await ffmpeg(
      [
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libopus",
        "-b:a",
        "24k",
        "-application",
        "voip",
        out,
      ],
      { signal, timeoutMinutes: AUDIO_TIMEOUT_MINUTES }
    );
  } catch (error) {
    if (!(error instanceof FfmpegError)) {
      throw error;
    }
    if (NO_AUDIO.test(error.stderr)) {
      throw new Error("This video has no audio track.", { cause: error });
    }
    throw new Error(`Couldn't read this video. ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Renders [startSeconds, endSeconds) of the source as 720x1280 H.264 with the
 * 9:16 window at cropX and `cues` burned in, or no captions when `cues` is
 * empty. Writes the .ass next to `out` and runs ffmpeg in that directory, so
 * the ass filter gets a bare file name with nothing to escape.
 */
export async function renderClip(
  clip: {
    source: string;
    out: string;
    startSeconds: number;
    endSeconds: number;
    cropX: number;
    cues: readonly Cue[];
  },
  signal: AbortSignal
): Promise<void> {
  const filters = [
    "scale=720:1280:force_original_aspect_ratio=increase",
    // (iw-ow)*x is CSS object-position x on an object-fit: cover box, so the editor's frame shows these pixels. 0.5 is ffmpeg's default center.
    `crop=720:1280:(iw-ow)*${clip.cropX.toFixed(4)}:(ih-oh)/2`,
    "setsar=1",
    "setpts=PTS-STARTPTS",
  ];
  if (clip.cues.length > 0) {
    const ass = clip.out.replace(MP4, ".ass");
    await write(ass, captionAss(clip.cues, "9:16"));
    filters.push(`ass=${basename(ass)}`);
  }
  await ffmpeg(
    [
      "-ss",
      String(clip.startSeconds),
      "-i",
      clip.source,
      "-t",
      String(clip.endSeconds - clip.startSeconds),
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-vf",
      filters.join(","),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "22",
      "-pix_fmt",
      "yuv420p",
      // Also caps the filter graph's threads, so one render leaves cores for Whisper.
      "-threads",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      basename(clip.out),
    ],
    {
      signal,
      timeoutMinutes: RENDER_TIMEOUT_MINUTES,
      cwd: dirname(clip.out),
    }
  );
}

export async function renderTimeline(
  plan: RenderPlan,
  options: { dataDir: string; scratch: string; signal: AbortSignal }
): Promise<string> {
  const { dataDir, scratch, signal } = options;
  const paths = new Map(
    await Promise.all(
      plan.inputs.map(
        async (input) =>
          [input.file, await confine(dataDir, input.file)] as const
      )
    )
  );
  const facts = new Map(
    await Promise.all(
      [...paths].map(
        async ([file, path]) => [file, await probe(path, signal)] as const
      )
    )
  );
  const program = buildRenderProgram(plan, facts);
  await Promise.all(
    program.sidecars.map((sidecar) =>
      write(join(scratch, sidecar.name), sidecar.contents)
    )
  );
  await ffmpeg(
    [
      ...program.inputs.flatMap((input) => [
        ...input.options,
        "-i",
        bound(paths, input.file),
      ]),
      "-filter_complex",
      program.graph,
      ...program.outputArgs,
      VERSION_FILE,
    ],
    { signal, timeoutMinutes: RENDER_TIMEOUT_MINUTES, cwd: scratch }
  );
  const out = join(scratch, VERSION_FILE);
  assertRendered(await probe(out, signal), program.expected);
  return out;
}

async function confine(dataDir: string, file: string): Promise<string> {
  const root = await realpath(dataDir);
  const path = await realpath(resolve(root, file));
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error("A version's media must live in the data directory.");
  }
  return path;
}

function bound(paths: ReadonlyMap<string, string>, file: string): string {
  const path = paths.get(file);
  if (!path) {
    throw new Error(
      `The render program uses ${file}, which the plan never bound.`
    );
  }
  return path;
}

async function probe(file: string, signal: AbortSignal): Promise<ProbeFacts> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const child = spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.any([signal, timeout]),
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (signal.aborted) {
    throw signal.reason;
  }
  if (code !== 0) {
    throw new Error(
      `ffprobe couldn't read ${basename(file)}: ${stderr.trim().slice(0, 300)}`
    );
  }
  return parseProbe(JSON.parse(stdout));
}

class FfmpegError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

async function ffmpeg(
  args: readonly string[],
  options: { signal: AbortSignal; timeoutMinutes: number; cwd?: string }
): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMinutes * 60_000);
  const child = spawn(
    ["ffmpeg", "-nostdin", "-hide_banner", "-v", "error", "-y", ...args],
    {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: AbortSignal.any([options.signal, timeout]),
    }
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (options.signal.aborted) {
    throw options.signal.reason;
  }
  if (code === 0) {
    return;
  }
  const tail = stderr.trim().split("\n").slice(-STDERR_TAIL_LINES).join(" ");
  const message = timeout.aborted
    ? `ffmpeg took over ${options.timeoutMinutes} minutes.`
    : `ffmpeg failed: ${tail}`;
  throw new FfmpegError(message, stderr);
}
