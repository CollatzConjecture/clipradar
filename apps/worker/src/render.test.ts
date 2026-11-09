import { expect, test } from "bun:test";

import {
  type EditDraft,
  parseSettings,
  type SourceCatalog,
} from "@clipradar/db/editor";
import { type LocalInput, resolvePlan } from "@clipradar/db/timeline";

import {
  assertRendered,
  buildRenderProgram,
  type ProbeFacts,
  parseProbe,
} from "./render";

const SEGMENT_ID = "00000000-0000-4000-8000-000000000001";
const words = Array.from({ length: 30 }, (_, i) => ({
  start: i,
  end: i + 0.5,
  text: `w${i}`,
}));
const sources: SourceCatalog = [
  { ref: { kind: "job" }, kind: "video", duration: 60, words },
];
const job: LocalInput = {
  ref: { kind: "job" },
  file: "sources/talk",
  kind: "video",
  duration: 60,
};
const source: ProbeFacts = {
  kind: "video",
  duration: 60,
  width: 1920,
  height: 1080,
  rotation: 0,
  sampleAspectRatio: 1,
  videoStart: 0,
  audioStart: 0,
  hasAudio: true,
  videoCodec: "h264",
  audioCodec: "aac",
  pixelFormat: "yuv420p",
  fps: 25,
  sampleRate: 44_100,
  channels: 2,
  sizeBytes: 1000,
  frames: 1500,
};

const doc = (overrides: Partial<EditDraft> = {}): EditDraft => ({
  version: 2,
  name: "v",
  segments: [
    {
      id: SEGMENT_ID,
      source: { kind: "job" },
      start: 4.5,
      end: 14.51,
      cropX: 0.05,
      cropY: 0.5,
      volume: 1,
      transition: { kind: "cut" },
      captions: [
        {
          anchor: { kind: "words", first: 6, last: 7 },
          timing: null,
          lines: ["Six {x}", "seven"],
        },
      ],
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
  ...overrides,
});

const program = (draft: EditDraft, facts: ProbeFacts = source) =>
  buildRenderProgram(
    resolvePlan(parseSettings(draft, sources, 4), sources, [job]),
    new Map([[job.file, facts]])
  );

test("one segment compiles to a seeked input, a cover crop, exact frames, burned captions and padded stereo audio", () => {
  const compiled = program(doc());
  expect(compiled.inputs).toEqual([
    {
      file: "sources/talk",
      options: [
        "-protocol_whitelist",
        "file",
        "-threads",
        "1",
        "-ss",
        "4.5",
        "-t",
        "11.01",
      ],
    },
  ]);
  expect(compiled.graph).toBe(
    "[0:v:0]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280:(iw-ow)*0.0500:(ih-oh)*0.5000,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=300,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p,ass=segment-0.ass[v];" +
      "[0:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0000,apad,atrim=end_sample=480000,asetpts=N/SR/TB[a]"
  );
  expect(compiled.outputArgs).toContain("18");
  expect(compiled.expected).toEqual({
    width: 720,
    height: 1280,
    fps: 30,
    duration: 10,
    frames: 300,
  });
  expect(compiled.sidecars.map((sidecar) => sidecar.name)).toEqual([
    "segment-0.ass",
  ]);
  expect(compiled.sidecars[0]?.contents).toContain(
    "Dialogue: 0,0:00:01.50,0:00:03.40,Default,,0,0,0,,Six ｛x｝\\Nseven\n"
  );
});

test("captions off burn nothing, and a silent source gets a silent stereo track of the same length", () => {
  const quiet = program(doc({ captionsEnabled: false }), {
    ...source,
    hasAudio: false,
  });
  expect(quiet.sidecars).toEqual([]);
  expect(quiet.graph).not.toContain("ass=");
  expect(quiet.graph).toEndWith(
    "[v];anullsrc=r=48000:cl=stereo,atrim=end_sample=480000,asetpts=N/SR/TB[a]"
  );
});

test("output settings follow the document: canvas, frame rate, quality, vertical crop, volume", () => {
  const wide = program(
    doc({
      aspectRatio: "16:9",
      fps: 24,
      quality: "low",
      segments: doc().segments.map((segment) => ({
        ...segment,
        cropY: 0.25,
        volume: 2,
      })),
    }),
    { ...source, sampleAspectRatio: 4 / 3 }
  );
  expect(wide.graph).toStartWith(
    "[0:v:0]scale=trunc(iw*sar/2)*2:ih,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720:(iw-ow)*0.0500:(ih-oh)*0.2500,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=240,"
  );
  expect(wide.graph).toContain("volume=2.0000");
  expect(wide.outputArgs.join(" ")).toContain("-crf 28");
  expect(wide.expected).toMatchObject({ width: 1280, height: 720, fps: 24 });
});

test("the compiler refuses what it cannot render instead of dropping it", () => {
  const second = {
    ...doc().segments[0],
    id: "00000000-0000-4000-8000-000000000002",
    start: 20,
    end: 25,
  };
  const settings = parseSettings(
    doc({
      segments: [...doc().segments, second as EditDraft["segments"][number]],
    }),
    sources,
    4
  );
  expect(() =>
    buildRenderProgram(
      resolvePlan(settings, sources, [job]),
      new Map([[job.file, source]])
    )
  ).toThrow("one segment");
  expect(() => program(doc(), { ...source, kind: "audio" })).toThrow(
    "probed video"
  );
});

test("parseProbe reads ffprobe's JSON and does not count a cover image as video", () => {
  const facts = parseProbe({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 720,
        height: 1280,
        pix_fmt: "yuv420p",
        avg_frame_rate: "30600/1019",
        r_frame_rate: "30/1",
        sample_aspect_ratio: "1:1",
        start_time: "0.000000",
        nb_frames: "300",
        side_data_list: [{ rotation: -90 }],
      },
      {
        codec_type: "audio",
        codec_name: "aac",
        sample_rate: "48000",
        channels: 2,
        start_time: "0.021333",
      },
    ],
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "10.010000",
      size: "123456",
    },
  });
  expect(facts).toEqual({
    kind: "video",
    duration: 10.01,
    width: 720,
    height: 1280,
    rotation: -90,
    sampleAspectRatio: 1,
    videoStart: 0,
    audioStart: 0.021_333,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    fps: 30,
    sampleRate: 48_000,
    channels: 2,
    sizeBytes: 123_456,
    frames: 300,
  });
  const song = parseProbe({
    streams: [
      {
        codec_type: "audio",
        codec_name: "mp3",
        sample_rate: "44100",
        channels: 2,
      },
      {
        codec_type: "video",
        codec_name: "mjpeg",
        disposition: { attached_pic: 1 },
      },
    ],
    format: { format_name: "mp3", duration: "180.5" },
  });
  expect([song.kind, song.width, song.videoCodec]).toEqual(["audio", 0, null]);
  expect(() =>
    parseProbe({ streams: [], format: { format_name: "mp4" } })
  ).toThrow();
});

test("assertRendered passes the expected output and names every mismatch", () => {
  const expected = {
    width: 720,
    height: 1280,
    fps: 30,
    duration: 10,
    frames: 300,
  };
  const rendered: ProbeFacts = {
    ...source,
    width: 720,
    height: 1280,
    fps: 30,
    duration: 10.02,
    sampleRate: 48_000,
    frames: 300,
  };
  expect(() => assertRendered(rendered, expected)).not.toThrow();
  expect(() =>
    assertRendered(
      { ...rendered, duration: 9.5, frames: 285, channels: 1 },
      expected
    )
  ).toThrow("9.5 s, not 10, 285 frames, not 300, audio 48000 Hz x1");
});
