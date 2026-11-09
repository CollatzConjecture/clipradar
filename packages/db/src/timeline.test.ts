import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type EditDraft,
  type Fps,
  parseSettings,
  type Segment,
  type SourceCatalog,
  type Transition,
} from "./editor";
import {
  frameAt,
  type LocalInput,
  outputTime,
  resolvePlan,
  schedule,
} from "./timeline";

const segment = (
  id: string,
  start: number,
  end: number,
  transition: Transition = { kind: "cut" },
  volume = 1
): Segment => ({
  id,
  source: { kind: "job" },
  start,
  end,
  cropX: 0.5,
  cropY: 0.5,
  volume,
  transition,
  captions: [],
});

const draft = (segments: Segment[], fps: Fps = 30): EditDraft => ({
  version: 2,
  name: "t",
  segments,
  aspectRatio: "9:16",
  fps,
  quality: "high",
  captionsEnabled: true,
  texts: [],
  images: [],
  audio: null,
  effect: null,
  watermark: null,
});

const fade = (duration: number): Transition => ({ kind: "fade", duration });

test("a half-second fade between [10,14] and [30,34] starts the second at 3.5 s and totals 7.5 s", () => {
  const doc = draft([segment("a", 10, 14), segment("b", 30, 34, fade(0.5))]);
  const { spans, totalFrames } = schedule(doc);
  assert.deepEqual(
    spans.map((span) => [span.startFrame, span.endFrame, span.overlapFrames]),
    [
      [0, 120, 0],
      [105, 225, 15],
    ]
  );
  assert.equal(totalFrames / 30, 7.5);
  assert.equal(outputTime(doc, "b", 31), 4.5, "source 31 s plays at 4.5 s");
  assert.equal(
    outputTime(doc, "b", 50),
    7.5,
    "past the trim clamps to its end"
  );
  assert.throws(() => outputTime(doc, "missing", 31));
});

test("lengths and overlaps round to whole frames once, at 24, 30 and 60 fps", () => {
  const doc = (fps: Fps) =>
    draft(
      [
        segment("a", 0, 1.01),
        segment("b", 5, 6.02, fade(0.05)),
        segment("c", 9, 9.33),
        segment("d", 2, 3, { kind: "zoom", duration: 0.26 }),
      ],
      fps
    );
  const frames = (fps: Fps) =>
    schedule(doc(fps)).spans.map((span) => [
      span.startFrame,
      span.lengthFrames,
      span.overlapFrames,
    ]);
  assert.deepEqual(frames(24), [
    [0, 24, 0],
    [23, 24, 1],
    [47, 8, 0],
    [49, 24, 6],
  ]);
  assert.deepEqual(frames(30), [
    [0, 30, 0],
    [28, 31, 2],
    [59, 10, 0],
    [61, 30, 8],
  ]);
  assert.deepEqual(frames(60), [
    [0, 61, 0],
    [58, 61, 3],
    [119, 20, 0],
    [123, 60, 16],
  ]);
  assert.equal(schedule(doc(30)).totalFrames, 91);
});

test("the first segment never overlaps, even if a draft gives it a transition", () => {
  const { spans } = schedule(draft([segment("a", 0, 2, fade(1))]));
  assert.deepEqual([spans[0]?.startFrame, spans[0]?.overlapFrames], [0, 0]);
});

test("frameAt shows one layer on a cut and two during a fade, the incoming one gaining linearly", () => {
  const doc = draft([segment("a", 10, 14), segment("b", 30, 34, fade(0.5), 2)]);
  const before = frameAt(doc, 1);
  assert.deepEqual(
    [before.frame, before.transition, before.progress, before.layers.length],
    [30, "cut", 0, 1]
  );
  assert.deepEqual(before.layers[0], {
    segmentId: "a",
    source: { kind: "job" },
    sourceTime: 11,
    localFrame: 30,
    incoming: false,
    gain: 1,
  });

  const middle = frameAt(doc, 3.75);
  assert.deepEqual(
    [middle.frame, middle.transition, middle.layers.map((l) => l.segmentId)],
    [112, "fade", ["a", "b"]]
  );
  const progress = 7 / 15;
  assert.equal(middle.progress, progress);
  assert.deepEqual(
    middle.layers.map((layer) => [
      layer.incoming,
      layer.gain,
      layer.localFrame,
    ]),
    [
      [false, 1 - progress, 112],
      [true, 2 * progress, 7],
    ]
  );

  const after = frameAt(doc, 7);
  assert.deepEqual(
    after.layers.map((layer) => [layer.segmentId, layer.sourceTime]),
    [["b", 33.5]]
  );
  assert.equal(frameAt(doc, 99).frame, 224, "clamps to the last frame");
  assert.equal(frameAt(doc, -1).frame, 0);
  assert.equal(
    frameAt(doc, 113 / 30).frame,
    113,
    "a time made from a frame lands on it"
  );
});

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

test("resolvePlan gives each segment its cues from its own start, with the edit, and none when captions are off", () => {
  const doc = draft([
    {
      ...segment(SEGMENT_ID, 4.5, 14.51),
      captions: [
        {
          anchor: { kind: "words", first: 6, last: 7 },
          timing: null,
          lines: ["Six", "seven"],
        },
      ],
    },
  ]);
  const plan = resolvePlan(parseSettings(doc, sources, 1), sources, [job]);
  assert.equal(plan.schedule.totalFrames, 300);
  assert.deepEqual(plan.inputs, [job]);
  const [entry] = plan.captions;
  assert.equal(entry?.segmentId, SEGMENT_ID);
  assert.deepEqual(
    entry?.cues.find((cue) => cue.lines[0] === "Six"),
    { startCs: 150, endCs: 340, lines: ["Six", "seven"] }
  );
  assert.ok(
    entry?.cues.every((cue) => cue.endCs <= 1000),
    "inside the 300 frames"
  );

  const off = parseSettings({ ...doc, captionsEnabled: false }, sources, 1);
  const quiet = resolvePlan(off, sources, [job]);
  assert.deepEqual(quiet.captions, [{ segmentId: SEGMENT_ID, cues: [] }]);
  assert.equal(quiet.settings.segments[0]?.captions.length, 1, "edits kept");
});

test("resolvePlan refuses a missing, doubled, or unused input binding", () => {
  const settings = parseSettings(
    draft([segment(SEGMENT_ID, 0, 10)]),
    sources,
    1
  );
  assert.throws(() => resolvePlan(settings, sources, []));
  assert.throws(() => resolvePlan(settings, sources, [job, job]));
  assert.throws(() =>
    resolvePlan(settings, sources, [
      job,
      { ...job, ref: { kind: "asset", id: SEGMENT_ID }, file: "assets/x" },
    ])
  );
});
