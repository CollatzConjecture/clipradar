import { type Cue, captionStyle } from "@clipradar/db/captions";
import { type Aspect, CANVASES, CRF } from "@clipradar/db/editor";
import { type RenderPlan, sameSource } from "@clipradar/db/timeline";
import { z } from "zod";

export interface ProbeFacts {
  audioCodec: string | null;
  audioStart: number | null;
  channels: number | null;
  duration: number;
  fps: number | null;
  frames: number | null;
  hasAudio: boolean;
  height: number;
  kind: "video" | "image" | "audio";
  pixelFormat: string | null;
  rotation: number;
  sampleAspectRatio: number;
  sampleRate: number | null;
  sizeBytes: number;
  videoCodec: string | null;
  videoStart: number | null;
  width: number;
}
export type InputFacts = ReadonlyMap<string, ProbeFacts>;
export interface RenderProgram {
  expected: {
    width: number;
    height: number;
    fps: number;
    duration: number;
    frames: number;
  };
  graph: string;
  inputs: readonly { file: string; options: readonly string[] }[];
  outputArgs: readonly string[];
  /** Bare file names, written next to the output, so the graph needs no path escaping. */
  sidecars: readonly { name: string; contents: string }[];
}

const SAMPLE_RATE = 48_000;
/** Read a little past the trim so a stream that ends a frame early still fills the last frame. */
const READ_MARGIN_SECONDS = 1;
const DURATION_TOLERANCE_SECONDS = 0.3;
const FPS_TOLERANCE = 0.01;
const RATIO = /^(?<top>\d+)[:/](?<bottom>\d+)$/u;
const STILL_FORMAT = /image2|_pipe/u;
const CONTROL = /\p{Cc}/gu;

const number = z.coerce.number();
const probeJson = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      pix_fmt: z.string().optional(),
      avg_frame_rate: z.string().optional(),
      r_frame_rate: z.string().optional(),
      sample_rate: number.optional(),
      channels: z.number().optional(),
      start_time: number.optional(),
      nb_frames: number.optional(),
      sample_aspect_ratio: z.string().optional(),
      disposition: z.object({ attached_pic: z.number().optional() }).optional(),
      side_data_list: z
        .array(z.object({ rotation: z.number().optional() }))
        .optional(),
    })
  ),
  format: z.object({
    format_name: z.string(),
    duration: number.optional(),
    size: number.optional(),
  }),
});

/** ffprobe reports attached cover art as a video stream; it is not video. */
export function parseProbe(value: unknown): ProbeFacts {
  const { streams, format } = probeJson.parse(value);
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" && stream.disposition?.attached_pic !== 1
  );
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (!(video || audio)) {
    throw new Error("No video or audio stream in this file.");
  }
  const duration = format.duration ?? 0;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("This file has no usable duration.");
  }
  let kind: ProbeFacts["kind"] = "audio";
  if (video) {
    const still =
      (video.codec_name === "png" || video.codec_name === "mjpeg") &&
      STILL_FORMAT.test(format.format_name);
    kind = still ? "image" : "video";
  }
  return {
    kind,
    duration,
    sizeBytes: format.size ?? 0,
    ...videoFacts(video),
    ...audioFacts(audio),
  };
}

export function buildRenderProgram(
  plan: RenderPlan,
  facts: InputFacts
): RenderProgram {
  const { settings, schedule } = plan;
  const [segment, ...others] = settings.segments;
  const [span] = schedule.spans;
  const layered =
    settings.texts.length > 0 ||
    settings.images.length > 0 ||
    settings.audio ||
    settings.effect ||
    settings.watermark;
  if (!(segment && span) || others.length > 0 || layered) {
    throw new Error(
      "This worker renders one segment without overlays, music, effects or watermarks."
    );
  }
  const input = plan.inputs.find((item) =>
    sameSource(item.ref, segment.source)
  );
  const fact = input && facts.get(input.file);
  if (!(input && fact) || fact.kind !== "video") {
    throw new Error("A segment's source must be a probed video.");
  }
  const [width, height] = CANVASES[settings.aspectRatio];
  const { fps } = settings;
  const frames = span.lengthFrames;
  const duration = frames / fps;
  const samples = Math.round(duration * SAMPLE_RATE);
  const cues = plan.captions[0]?.cues ?? [];
  const sidecars =
    cues.length > 0
      ? [
          {
            name: "segment-0.ass",
            contents: captionAss(cues, settings.aspectRatio),
          },
        ]
      : [];
  const video = [
    ...(fact.sampleAspectRatio === 1 ? [] : ["scale=trunc(iw*sar/2)*2:ih"]),
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}:(iw-ow)*${fixed(segment.cropX)}:(ih-oh)*${fixed(segment.cropY)}`,
    "setsar=1",
    `fps=${fps}`,
    `tpad=stop_mode=clone:stop_duration=${READ_MARGIN_SECONDS}`,
    `trim=end_frame=${frames}`,
    "settb=AVTB",
    "setpts=PTS-STARTPTS",
    "format=yuv420p",
    ...sidecars.map((sidecar) => `ass=${sidecar.name}`),
  ];
  const audio = fact.hasAudio
    ? `[0:a:0]aresample=${SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${fixed(segment.volume)},apad`
    : `anullsrc=r=${SAMPLE_RATE}:cl=stereo`;
  return {
    inputs: [
      {
        file: input.file,
        options: [
          "-protocol_whitelist",
          "file",
          "-threads",
          "1",
          "-ss",
          String(segment.start),
          "-t",
          String(segment.end - segment.start + READ_MARGIN_SECONDS),
        ],
      },
    ],
    graph: `[0:v:0]${video.join(",")}[v];${audio},atrim=end_sample=${samples},asetpts=N/SR/TB[a]`,
    sidecars,
    outputArgs: [
      "-filter_complex_threads",
      "1",
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(CRF[settings.quality]),
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "2",
      "-movflags",
      "+faststart",
    ],
    expected: { width, height, fps, duration, frames },
  };
}

export function assertRendered(
  actual: ProbeFacts,
  expected: RenderProgram["expected"]
): void {
  const checks: [boolean, string][] = [
    [actual.videoCodec === "h264", `video codec ${actual.videoCodec}`],
    [actual.pixelFormat === "yuv420p", `pixel format ${actual.pixelFormat}`],
    [
      actual.width === expected.width && actual.height === expected.height,
      `${actual.width}x${actual.height}, not ${expected.width}x${expected.height}`,
    ],
    [
      Math.abs((actual.fps ?? 0) - expected.fps) < FPS_TOLERANCE,
      `${actual.fps} fps, not ${expected.fps}`,
    ],
    [
      Math.abs(actual.duration - expected.duration) <=
        DURATION_TOLERANCE_SECONDS,
      `${actual.duration} s, not ${expected.duration}`,
    ],
    [
      actual.frames === null || actual.frames === expected.frames,
      `${actual.frames} frames, not ${expected.frames}`,
    ],
    [actual.audioCodec === "aac", `audio codec ${actual.audioCodec}`],
    [
      actual.sampleRate === SAMPLE_RATE && actual.channels === 2,
      `audio ${actual.sampleRate} Hz x${actual.channels}`,
    ],
    [actual.sizeBytes > 0 && actual.frames !== 0, "an empty file"],
  ];
  const wrong = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (wrong.length > 0) {
    throw new Error(`The render came out wrong: ${wrong.join(", ")}.`);
  }
}

/**
 * Captions as .ass, PlayRes the canvas so sizes are output pixels. WrapStyle
 * 2 turns off libass wrapping because the caption rows already chose the
 * lines. Bold white text with a black outline, high enough to clear the
 * TikTok and Reels caption chrome. fontconfig falls back to Noto CJK.
 */
export function captionAss(cues: readonly Cue[], aspect: Aspect): string {
  const style = captionStyle(aspect);
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.startCs)},${assTime(cue.endCs)},Default,,0,0,0,,${cue.lines.map(literal).join("\\N")}`
  );
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${style.width}
PlayResY: ${style.height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.font},${style.size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},0,2,${style.marginX},${style.marginX},${style.marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

/**
 * Caption text must never become ASS override tags or line breaks. Typed
 * lines arrive cleaned already; transcript words do not. Full-width
 * look-alikes render the same and mean nothing to libass.
 */
function literal(text: string): string {
  return text
    .replace(CONTROL, " ")
    .replaceAll("\\", "＼")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝");
}

function assTime(cs: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(cs / 360_000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

type Stream = z.infer<typeof probeJson>["streams"][number];

function videoFacts(video: Stream | undefined) {
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    rotation:
      video?.side_data_list?.find((data) => data.rotation)?.rotation ?? 0,
    sampleAspectRatio: ratio(video?.sample_aspect_ratio) ?? 1,
    videoStart: video?.start_time ?? null,
    videoCodec: video?.codec_name ?? null,
    pixelFormat: video?.pix_fmt ?? null,
    // The nominal rate. ffmpeg 7's MP4 reader leaves the last frame out of the duration, which skews avg_frame_rate.
    fps: ratio(video?.r_frame_rate) ?? ratio(video?.avg_frame_rate),
    frames: video?.nb_frames ?? null,
  };
}

function audioFacts(audio: Stream | undefined) {
  return {
    hasAudio: audio !== undefined,
    audioStart: audio?.start_time ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ?? null,
    channels: audio?.channels ?? null,
  };
}

function fixed(value: number): string {
  return value.toFixed(4);
}

function ratio(text: string | undefined): number | null {
  const groups = text ? RATIO.exec(text)?.groups : undefined;
  const value = groups
    ? Number(groups.top) / Number(groups.bottom)
    : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}
