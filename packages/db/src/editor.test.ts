import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assetIdsOf,
  capabilitiesFor,
  type DeliveryStage,
  type EditDraft,
  issuesFor,
  parseDocument,
  parseSettings,
  type Segment,
  SettingsError,
  type SourceCatalog,
} from "./editor";

const SEGMENT_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";
const LAYER_ID = "00000000-0000-4000-8000-000000000003";
const VIDEO_ID = "00000000-0000-4000-8000-0000000000a1";
const IMAGE_ID = "00000000-0000-4000-8000-0000000000a2";
const AUDIO_ID = "00000000-0000-4000-8000-0000000000a3";
const STAGES: DeliveryStage[] = [1, 2, 3, 4];

const sources: SourceCatalog = [
  {
    ref: { kind: "job" },
    kind: "video",
    duration: 600,
    words: Array.from({ length: 40 }, (_, i) => ({
      start: i,
      end: i + 0.5,
      text: `word${i}`,
    })),
  },
  ...(
    [
      [VIDEO_ID, "video"],
      [IMAGE_ID, "image"],
      [AUDIO_ID, "audio"],
    ] as const
  ).map(([id, kind]) => ({
    ref: { kind: "asset" as const, id },
    kind,
    duration: 60,
    width: 1920,
    height: 1080,
    hasAudio: kind !== "image",
  })),
];

const stageOne = (): EditDraft => ({
  version: 2,
  name: "A useful moment",
  segments: [
    {
      id: SEGMENT_ID,
      source: { kind: "job" },
      start: 2,
      end: 22,
      cropX: 0.1,
      cropY: 0.5,
      volume: 1,
      transition: { kind: "cut" },
      captions: [
        {
          anchor: { kind: "words", first: 3, last: 4 },
          timing: null,
          lines: ["Edited", "twice"],
        },
        {
          anchor: { kind: "words", first: 9, last: 9 },
          timing: null,
          lines: [],
        },
      ],
    },
  ],
  aspectRatio: "9:16",
  fps: 30,
  quality: "high",
  captionsEnabled: false,
  texts: [],
  images: [],
  audio: null,
  effect: null,
  watermark: null,
});

const second = (doc: EditDraft): Segment => {
  const [first] = doc.segments;
  assert.ok(first);
  return {
    ...structuredClone(first),
    id: SECOND_ID,
    start: 30,
    end: 40,
    captions: [],
  };
};

const refusal = (doc: unknown, stage: DeliveryStage) => {
  try {
    parseSettings(doc, sources, stage);
    return null;
  } catch (error) {
    assert.ok(error instanceof SettingsError, String(error));
    return error;
  }
};

test("a stage-1 document parses unchanged under every stage's policy", () => {
  for (const stage of STAGES) {
    assert.deepEqual(parseSettings(stageOne(), sources, stage), stageOne());
  }
});

type Mutation = [
  string,
  (doc: EditDraft) => void,
  (string | number)[],
  DeliveryStage,
];
const futureValues: Mutation[] = [
  [
    "a second segment",
    (doc) => doc.segments.push(second(doc)),
    ["segments"],
    2,
  ],
  [
    "a version over 180 seconds",
    (doc) => Object.assign(doc.segments[0] ?? {}, { start: 0, end: 200 }),
    ["segments"],
    2,
  ],
  [
    "a transition",
    (doc) =>
      doc.segments.push({
        ...second(doc),
        transition: { kind: "fade", duration: 0.5 },
      }),
    ["segments", 1, "transition"],
    2,
  ],
  [
    "a retimed caption",
    (doc) =>
      doc.segments[0]?.captions.splice(0, 1, {
        anchor: { kind: "words", first: 3, last: 4 },
        timing: { start: 3, end: 4.4 },
        lines: ["Moved"],
      }),
    ["segments", 0, "captions", 0, "timing"],
    2,
  ],
  [
    "an added caption",
    (doc) =>
      doc.segments[0]?.captions.push({
        anchor: { kind: "cue", id: LAYER_ID, start: 9, end: 9.9 },
        lines: ["Added"],
      }),
    ["segments", 0, "captions", 2, "anchor"],
    2,
  ],
  [
    "a segment volume",
    (doc) => Object.assign(doc.segments[0] ?? {}, { volume: 0.8 }),
    ["segments", 0, "volume"],
    3,
  ],
  [
    "moving the crop vertically",
    (doc) => Object.assign(doc.segments[0] ?? {}, { cropY: 0.3 }),
    ["segments", 0, "cropY"],
    3,
  ],
  [
    "16:9",
    (doc) => Object.assign(doc, { aspectRatio: "16:9" }),
    ["aspectRatio"],
    3,
  ],
  ["24 fps", (doc) => Object.assign(doc, { fps: 24 }), ["fps"], 3],
  [
    "medium quality",
    (doc) => Object.assign(doc, { quality: "medium" }),
    ["quality"],
    3,
  ],
  [
    "a text",
    (doc) =>
      doc.texts.push({
        id: LAYER_ID,
        start: 1,
        end: 3,
        text: "Hello",
        x: 0.1,
        y: 0.1,
        size: 48,
        color: "#ffcc00",
        font: "sans",
        bold: true,
        italic: false,
        underline: false,
      }),
    ["texts"],
    3,
  ],
  [
    "an image overlay",
    (doc) =>
      doc.images.push({
        id: LAYER_ID,
        source: { kind: "asset", id: IMAGE_ID },
        start: 0,
        end: 5,
        x: 0.5,
        y: 0.5,
        width: 0.3,
        opacity: 1,
      }),
    ["images"],
    3,
  ],
  [
    "music",
    (doc) =>
      Object.assign(doc, {
        audio: {
          source: { kind: "asset", id: AUDIO_ID },
          start: 0,
          end: 10,
          offset: 5,
          volume: 0.5,
        },
      }),
    ["audio"],
    3,
  ],
  [
    "an effect",
    (doc) =>
      Object.assign(doc, { effect: { preset: "vivid", start: 0, end: 5 } }),
    ["effect"],
    3,
  ],
  [
    "watermark removal",
    (doc) =>
      Object.assign(doc, {
        watermark: {
          start: 0,
          end: 5,
          x: 0.1,
          y: 0.1,
          width: 0.2,
          height: 0.1,
        },
      }),
    ["watermark"],
    3,
  ],
  [
    "an uploaded video segment",
    (doc) =>
      Object.assign(doc.segments[0] ?? {}, {
        source: { kind: "asset", id: VIDEO_ID },
        start: 0,
        end: 20,
        captions: [],
      }),
    ["segments", 0, "source"],
    4,
  ],
];

for (const [label, mutate, path, allowedAt] of futureValues) {
  test(`${label} is refused, naming the field, until stage ${allowedAt}`, () => {
    const doc = stageOne();
    mutate(doc);
    for (const stage of STAGES) {
      const error = refusal(doc, stage);
      if (stage >= allowedAt) {
        assert.equal(
          error,
          null,
          `accepted at stage ${stage}: ${error?.message}`
        );
        continue;
      }
      assert.equal(error?.reason, "unsupported-feature", `stage ${stage}`);
      const issue = error?.issues.find(
        (found) => JSON.stringify(found.path) === JSON.stringify(path)
      );
      assert.ok(issue, `stage ${stage} names ${path.join(".")}`);
      assert.match(
        issue.message,
        new RegExp(`available in stage ${allowedAt}`, "u")
      );
    }
  });
}

test("the structure is exact at every level, and a bad value names its path and segment", () => {
  const cases: [
    string,
    (doc: Record<string, unknown> & EditDraft) => void,
    (string | number)[],
  ][] = [
    ["unknown top-level key", (doc) => Object.assign(doc, { extra: 1 }), []],
    [
      "missing key",
      (doc) => Reflect.deleteProperty(doc, "watermark"),
      ["watermark"],
    ],
    [
      "unknown segment key",
      (doc) => Object.assign(doc.segments[0] ?? {}, { speed: 2 }),
      ["segments", 0],
    ],
    [
      "unknown anchor key",
      (doc) =>
        Object.assign(doc.segments[0]?.captions[0]?.anchor ?? {}, { x: 1 }),
      ["segments", 0, "captions", 0, "anchor"],
    ],
    [
      "NaN crop",
      (doc) => Object.assign(doc.segments[0] ?? {}, { cropX: Number.NaN }),
      ["segments", 0, "cropX"],
    ],
    [
      "crop past the edge",
      (doc) => Object.assign(doc.segments[0] ?? {}, { cropX: 1.01 }),
      ["segments", 0, "cropX"],
    ],
    [
      "negative start",
      (doc) => Object.assign(doc.segments[0] ?? {}, { start: -1 }),
      ["segments", 0, "start"],
    ],
    [
      "segment under 0.25 s",
      (doc) => Object.assign(doc.segments[0] ?? {}, { end: 2.2 }),
      ["segments", 0, "end"],
    ],
    [
      "not a uuid",
      (doc) => Object.assign(doc.segments[0] ?? {}, { id: "seg-1" }),
      ["segments", 0, "id"],
    ],
    [
      "fps outside the catalogue",
      (doc) => Object.assign(doc, { fps: 25 }),
      ["fps"],
    ],
    ["version 1", (doc) => Object.assign(doc, { version: 1 }), ["version"]],
    ["an empty name", (doc) => Object.assign(doc, { name: " \t " }), ["name"]],
    [
      "a caption line too wide",
      (doc) =>
        Object.assign(doc.segments[0]?.captions[0] ?? {}, {
          lines: ["nineteen chars, no!"],
        }),
      ["segments", 0, "captions", 0, "lines"],
    ],
    [
      "overlapping word edits",
      (doc) =>
        doc.segments[0]?.captions.push({
          anchor: { kind: "words", first: 4, last: 5 },
          timing: null,
          lines: ["x"],
        }),
      ["segments", 0, "captions"],
    ],
    [
      "a first segment that opens with a fade",
      (doc) =>
        Object.assign(doc.segments[0] ?? {}, {
          transition: { kind: "fade", duration: 0.5 },
        }),
      ["segments", 0, "transition"],
    ],
    [
      "two segments with one id",
      (doc) => doc.segments.push({ ...second(doc), id: SEGMENT_ID }),
      ["segments", 1, "id"],
    ],
  ];
  for (const [label, mutate, path] of cases) {
    const doc = stageOne() as Record<string, unknown> & EditDraft;
    mutate(doc);
    for (const stage of [1, 4] as const) {
      const error = refusal(doc, stage);
      assert.equal(
        error?.reason,
        "invalid-settings",
        `${label} at stage ${stage}`
      );
      assert.deepEqual(error?.issues[0]?.path, path, label);
      const index = path[0] === "segments" ? path[1] : undefined;
      assert.equal(
        error?.issues[0]?.targetId,
        typeof index === "number" ? (doc.segments[index]?.id ?? null) : null,
        `${label} targets the segment as the draft names it`
      );
    }
  }
});

test("parseDocument cleans text and puts caption edits in canonical order without other changes", () => {
  const doc = stageOne();
  doc.name = "  A \t useful\nmoment ";
  doc.segments[0]?.captions.reverse();
  doc.segments[0]?.captions.push({
    anchor: { kind: "cue", id: LAYER_ID, start: 20, end: 21 },
    lines: ["  {\\b1}  hi "],
  });
  doc.segments[0]?.captions.unshift({
    anchor: { kind: "cue", id: SECOND_ID, start: 15, end: 16 },
    lines: ["second"],
  });
  const parsed = parseDocument(doc);
  assert.equal(parsed.name, "A useful moment");
  assert.deepEqual(
    parsed.segments[0]?.captions.map((edit) =>
      edit.anchor.kind === "words" ? edit.anchor.first : edit.anchor.id
    ),
    [3, 9, SECOND_ID, LAYER_ID]
  );
  assert.deepEqual(parsed.segments[0]?.captions.at(-1)?.lines, ["｛＼b1｝ hi"]);
  assert.deepEqual(parseDocument(parsed), parsed, "parsing is idempotent");
});

test("checks that need the media name the field: source end, transcript words, overlaps, transitions, length", () => {
  const cases: [
    string,
    (doc: EditDraft) => void,
    (string | number)[],
    DeliveryStage,
  ][] = [
    [
      "a trim past the source",
      (doc) => Object.assign(doc.segments[0] ?? {}, { start: 590, end: 600.5 }),
      ["segments", 0, "end"],
      1,
    ],
    [
      "a pin past the last word",
      (doc) =>
        doc.segments[0]?.captions.push({
          anchor: { kind: "words", first: 39, last: 40 },
          timing: null,
          lines: ["x"],
        }),
      ["segments", 0, "captions", 2, "anchor"],
      1,
    ],
    [
      "a version under a second",
      (doc) => Object.assign(doc.segments[0] ?? {}, { start: 2, end: 2.9 }),
      ["segments"],
      1,
    ],
    [
      "a retimed caption over the next row",
      (doc) =>
        doc.segments[0]?.captions.splice(0, 1, {
          anchor: { kind: "words", first: 3, last: 4 },
          timing: { start: 5.2, end: 6.4 },
          lines: ["Moved"],
        }),
      ["segments", 0, "captions", 0],
      2,
    ],
    [
      "a transition longer than half a segment",
      (doc) =>
        doc.segments.push({
          ...second(doc),
          start: 30,
          end: 32,
          transition: { kind: "zoom", duration: 1.5 },
        }),
      ["segments", 1, "transition", "duration"],
      2,
    ],
    [
      "music that runs past its file",
      (doc) =>
        Object.assign(doc, {
          audio: {
            source: { kind: "asset", id: AUDIO_ID },
            start: 0,
            end: 15,
            offset: 50,
            volume: 1,
          },
        }),
      ["audio", "offset"],
      3,
    ],
    [
      "text that ends after the video",
      (doc) =>
        doc.texts.push({
          id: LAYER_ID,
          start: 10,
          end: 25,
          text: "Late",
          x: 0,
          y: 0,
          size: 40,
          color: "#FFFFFF",
          font: "mono",
          bold: false,
          italic: false,
          underline: false,
        }),
      ["texts", 0, "end"],
      3,
    ],
    [
      "an image overlay from an audio file",
      (doc) =>
        doc.images.push({
          id: LAYER_ID,
          source: { kind: "asset", id: AUDIO_ID },
          start: 0,
          end: 5,
          x: 0,
          y: 0,
          width: 0.5,
          opacity: 0.5,
        }),
      ["images", 0, "source"],
      3,
    ],
  ];
  for (const [label, mutate, path, stage] of cases) {
    const doc = stageOne();
    mutate(doc);
    const error = refusal(doc, stage);
    assert.equal(error?.reason, "invalid-settings", label);
    assert.ok(
      error?.issues.some(
        (issue) => JSON.stringify(issue.path) === JSON.stringify(path)
      ),
      `${label}: ${JSON.stringify(error?.issues)}`
    );
  }
});

test("issuesFor reports parseSettings' issues for a draft and none for a valid one", () => {
  assert.deepEqual(issuesFor(stageOne(), sources, 1), []);
  const doc = stageOne();
  Object.assign(doc.segments[0] ?? {}, { cropY: 0.2 });
  assert.deepEqual(issuesFor(doc, sources, 1), [
    {
      targetId: SEGMENT_ID,
      path: ["segments", 0, "cropY"],
      message: "Moving the crop up or down is available in stage 3.",
    },
  ]);
});

test("capabilities come from the same stage policy, and stock needs both a key and stage 4", () => {
  assert.deepEqual(capabilitiesFor(1, true), {
    stage: 1,
    enabled: ["trim", "cropX", "captions"],
    stock: false,
  });
  assert.deepEqual(capabilitiesFor(2, false).enabled, [
    "trim",
    "cropX",
    "captions",
    "timeline",
    "captionTiming",
    "transitions",
  ]);
  assert.equal(capabilitiesFor(4, true).stock, true);
  assert.equal(capabilitiesFor(4, false).stock, false);
  assert.equal(capabilitiesFor(4, false).enabled.length, 12);
});

test("assetIdsOf lists every segment, image and music asset once, sorted", () => {
  const doc = stageOne();
  doc.segments.push({
    ...second(doc),
    source: { kind: "asset", id: VIDEO_ID },
  });
  doc.images.push(
    ...[IMAGE_ID, VIDEO_ID].map((assetId) => ({
      id: LAYER_ID,
      source: { kind: "asset" as const, id: assetId },
      start: 0,
      end: 1,
      x: 0,
      y: 0,
      width: 0.5,
      opacity: 1,
    }))
  );
  doc.audio = {
    source: { kind: "asset", id: AUDIO_ID },
    start: 0,
    end: 1,
    offset: 0,
    volume: 1,
  };
  assert.deepEqual(assetIdsOf(doc), [VIDEO_ID, IMAGE_ID, AUDIO_ID]);
  assert.deepEqual(assetIdsOf(stageOne()), []);
});
