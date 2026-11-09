/**
 * Three clocks:
 * - a segment's start/end and its caption timing are seconds in its source;
 * - text, image, audio, effect, and watermark start/end are output seconds;
 * - timeline.ts's schedule() turns segments into integer output frames.
 */
import { z } from "zod";

import { canonicalEdits, captionRows } from "./captions";
import { CANVASES, CAPTION, cleanLines, cleanText, lineFits } from "./rules";
import { sameSource, schedule } from "./timeline";

export type DeliveryStage = 1 | 2 | 3 | 4;
export type SourceRef = { kind: "job" } | { kind: "asset"; id: string };
export interface Range {
  end: number;
  start: number;
}
/** Whisper's word, renamed. `text` has no surrounding spaces. */
export interface Word extends Range {
  text: string;
}
// biome-ignore lint/performance/noBarrelFile: the one catalogue that lives elsewhere, kept importable with the rest.
export { CANVASES } from "./rules";
export type Aspect = keyof typeof CANVASES;
export const FPS = [24, 30, 60] as const;
export type Fps = (typeof FPS)[number];
export const CRF = { high: 18, medium: 23, low: 28 } as const;
export type Quality = keyof typeof CRF;
export const FONT_FAMILIES = {
  sans: "DejaVu Sans",
  serif: "DejaVu Serif",
  mono: "DejaVu Sans Mono",
  display: "DejaVu Sans",
} as const;
export type Font = keyof typeof FONT_FAMILIES;
export const EFFECT_PRESETS = [
  "cinematic",
  "vivid",
  "vintage",
  "blackwhite",
  "softglow",
] as const;
export type EffectPreset = (typeof EFFECT_PRESETS)[number];
export const TRANSITIONS = ["fade", "slide", "zoom"] as const;
export type Transition =
  | { kind: "cut" }
  | { kind: (typeof TRANSITIONS)[number]; duration: number };

/** Word indices always name wordsOf(the whole enclosing job transcript). */
export type CaptionAnchor =
  | { kind: "words"; first: number; last: number }
  | ({ kind: "cue"; id: string } & Range);
/**
 * A word edit pins typed lines to transcript words, optionally at its own
 * source time. A cue edit adds a caption at a source time. `lines: []` hides.
 */
export type CaptionEdit =
  | {
      anchor: Extract<CaptionAnchor, { kind: "words" }>;
      timing: Range | null;
      lines: string[];
    }
  | { anchor: Extract<CaptionAnchor, { kind: "cue" }>; lines: string[] };

export interface Segment extends Range {
  /** Source-time edits, including off-trim ones; never compiled cues. */
  captions: CaptionEdit[];
  cropX: number;
  cropY: number;
  id: string;
  source: SourceRef;
  /** Incoming join. The first segment's is always a cut. */
  transition: Transition;
  volume: number;
}
export interface TextOverlay extends Range {
  bold: boolean;
  color: string;
  font: Font;
  id: string;
  italic: boolean;
  size: number;
  text: string;
  underline: boolean;
  x: number;
  y: number;
}
export interface ImageOverlay extends Range {
  id: string;
  opacity: number;
  source: Extract<SourceRef, { kind: "asset" }>;
  width: number;
  x: number;
  y: number;
}
export interface AudioTrack extends Range {
  /** Source seconds; start/end are output seconds. */
  offset: number;
  source: Extract<SourceRef, { kind: "asset" }>;
  volume: number;
}
export interface Effect extends Range {
  preset: EffectPreset;
}
export interface Watermark extends Range {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface EditDraft {
  aspectRatio: Aspect;
  audio: AudioTrack | null;
  captionsEnabled: boolean;
  effect: Effect | null;
  fps: Fps;
  images: ImageOverlay[];
  name: string;
  quality: Quality;
  segments: Segment[];
  texts: TextOverlay[];
  version: 2;
  watermark: Watermark | null;
}
declare const checked: unique symbol;
/** Same JSON as EditDraft, after parseSettings. The marker is type-only and never serialized. */
export type EditSettings = EditDraft & { readonly [checked]: true };

export type SourceFacts =
  | {
      ref: { kind: "job" };
      kind: "video";
      duration: number;
      words: readonly Word[];
    }
  | {
      ref: { kind: "asset"; id: string };
      kind: "video" | "image" | "audio";
      duration: number;
      width: number;
      height: number;
      hasAudio: boolean;
    };
export type SourceCatalog = readonly SourceFacts[];
export interface Issue {
  message: string;
  path: readonly (string | number)[];
  /** The segment, text, or image the path points into, so the editor can select it. */
  targetId: string | null;
}
export type Capability =
  | "trim"
  | "cropX"
  | "captions"
  | "timeline"
  | "captionTiming"
  | "transitions"
  | "compositing"
  | "output"
  | "imageAudioUpload"
  | "mediaTimeline"
  | "videoUpload"
  | "detection";
export interface Capabilities {
  enabled: readonly Capability[];
  /** The policy issuesFor needs. The server picks it; the browser only reads it. */
  stage: DeliveryStage;
  stock: boolean;
}

export const LIMITS = {
  segments: 20,
  minSegmentSeconds: 0.25,
  minSeconds: 1,
  maxSeconds: 300,
  stageOneMaxSeconds: 180,
  captionEdits: 400,
  captionRows: 400,
  texts: 20,
  images: 20,
  requestBytes: 4 * 1024 * 1024,
  maxAssetBytes: 100 * 1024 * 1024,
  assetSlots: 100,
  nameChars: 160,
  textChars: 400,
  minTextSize: 12,
  maxTextSize: 120,
  minTransitionSeconds: 0.05,
  maxTransitionSeconds: 2,
  maxVolume: 2,
  minCueSeconds: 0.1,
  minLayerSeconds: 0.05,
  minImageWidth: 0.02,
  /** ffmpeg's delogo fails when its box touches the frame edge. */
  watermarkMin: 0.01,
  watermarkMax: 0.95,
  maxImageSeconds: 300,
} as const;

export const DEFAULTS = {
  cropX: 0.5,
  cropY: 0.5,
  volume: 1,
  aspectRatio: "9:16",
  fps: 30,
  quality: "high",
} as const satisfies Partial<Segment> & Partial<EditDraft>;

/** A refused document. `reason` tells a malformed value from one a later stage allows. */
export class SettingsError extends Error {
  readonly issues: readonly Issue[];
  readonly reason: "invalid-settings" | "unsupported-feature";

  constructor(
    reason: SettingsError["reason"],
    issues: readonly [Issue, ...Issue[]]
  ) {
    super(issues[0].message);
    this.name = "SettingsError";
    this.reason = reason;
    this.issues = issues;
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

const keysOf = <T extends object>(object: T) =>
  Object.keys(object) as [keyof T & string, ...(keyof T & string)[]];
type Refinement<T> = [
  (value: T) => boolean,
  { message: string; path: string[] },
];
const lasts = (minimum: number, what: string): Refinement<Range> => [
  (value) => value.end - value.start >= minimum,
  { message: `${what} lasts at least ${minimum} seconds.`, path: ["end"] },
];

const seconds = z.number().min(0, "A time can't be negative.");
const fraction = z.number().min(0).max(1);
const id = z.uuid();
const assetRef = z.strictObject({ kind: z.literal("asset"), id });
const sourceRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("job") }),
  assetRef,
]);
const volume = z.number().min(0).max(LIMITS.maxVolume);
const captionLines = z
  .array(z.string().max(CAPTION.maxLineChars))
  .max(CAPTION.maxLines)
  .transform(cleanLines)
  .refine((lines) => lines.every(lineFits), {
    message: `A caption line fits ${CAPTION.lineUnits} characters. Press Enter to break it, or shorten it.`,
  });
const captionEdit = z.union([
  z.strictObject({
    anchor: z
      .strictObject({
        kind: z.literal("words"),
        first: z.int().min(0),
        last: z.int().min(0),
      })
      .refine((anchor) => anchor.first <= anchor.last, {
        message: "A caption edit's words are reversed.",
        path: ["last"],
      }),
    timing: z
      .strictObject({ start: seconds, end: seconds })
      .refine(...lasts(LIMITS.minCueSeconds, "A caption"))
      .nullable(),
    lines: captionLines,
  }),
  z.strictObject({
    anchor: z
      .strictObject({
        kind: z.literal("cue"),
        id,
        start: seconds,
        end: seconds,
      })
      .refine(...lasts(LIMITS.minCueSeconds, "A caption")),
    lines: captionLines.refine((lines) => lines.length > 0, {
      message: "Type the caption, or remove it.",
    }),
  }),
]);
const captions = z
  .array(captionEdit)
  .max(LIMITS.captionEdits, {
    message: `A segment has at most ${LIMITS.captionEdits} caption edits.`,
  })
  .transform((edits) => canonicalEdits(edits))
  .superRefine((edits, context) => {
    let lastWord = -1;
    const cueIds = new Set<string>();
    for (const { anchor } of edits) {
      const clash =
        anchor.kind === "words"
          ? anchor.first <= lastWord
          : cueIds.has(anchor.id);
      if (clash) {
        context.addIssue({
          code: "custom",
          message: "Two caption edits pin the same words or share an id.",
        });
        return;
      }
      if (anchor.kind === "words") {
        lastWord = anchor.last;
      } else {
        cueIds.add(anchor.id);
      }
    }
  });
const segment = z
  .strictObject({
    id,
    source: sourceRef,
    start: seconds,
    end: seconds,
    cropX: fraction,
    cropY: fraction,
    volume,
    transition: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("cut") }),
      z.strictObject({
        kind: z.enum(TRANSITIONS),
        duration: z
          .number()
          .min(LIMITS.minTransitionSeconds)
          .max(LIMITS.maxTransitionSeconds),
      }),
    ]),
    captions,
  })
  .refine(...lasts(LIMITS.minSegmentSeconds, "A segment"));
const textOverlay = z
  .strictObject({
    id,
    start: seconds,
    end: seconds,
    text: z
      .string()
      .max(LIMITS.textChars)
      .transform((text) => cleanLines(text.split("\n")).join("\n"))
      .pipe(z.string().min(1, "Type the text, or remove it.")),
    x: fraction,
    y: fraction,
    size: z.int().min(LIMITS.minTextSize).max(LIMITS.maxTextSize),
    color: z
      .string()
      .regex(HEX_COLOR, "A color is #rrggbb.")
      .transform((color) => color.toLowerCase()),
    font: z.enum(keysOf(FONT_FAMILIES)),
    bold: z.boolean(),
    italic: z.boolean(),
    underline: z.boolean(),
  })
  .refine(...lasts(LIMITS.minLayerSeconds, "Text"));
const imageOverlay = z
  .strictObject({
    id,
    source: assetRef,
    start: seconds,
    end: seconds,
    x: fraction,
    y: fraction,
    width: z.number().min(LIMITS.minImageWidth).max(1),
    opacity: fraction,
  })
  .refine(...lasts(LIMITS.minLayerSeconds, "An image"));
const watermarkEdge = z
  .number()
  .min(LIMITS.watermarkMin)
  .max(LIMITS.watermarkMax);
const insideEdge = (axis: "width" | "height"): Refinement<Watermark> => [
  (box) =>
    (axis === "width" ? box.x : box.y) + box[axis] <= LIMITS.watermarkMax,
  {
    message: `The box stays ${Math.round((1 - LIMITS.watermarkMax) * 100)}% inside the frame's edge.`,
    path: [axis],
  },
];

const documentSchema: z.ZodType<EditDraft> = z
  .strictObject({
    version: z.literal(2),
    name: z
      .string()
      .max(LIMITS.nameChars)
      .transform(cleanText)
      .pipe(z.string().min(1, "Name the version.")),
    segments: z
      .array(segment)
      .min(1, "A version has at least one segment.")
      .max(LIMITS.segments),
    aspectRatio: z.enum(keysOf(CANVASES)),
    fps: z.literal(FPS),
    quality: z.enum(keysOf(CRF)),
    captionsEnabled: z.boolean(),
    texts: z.array(textOverlay).max(LIMITS.texts),
    images: z.array(imageOverlay).max(LIMITS.images),
    audio: z
      .strictObject({
        source: assetRef,
        start: seconds,
        end: seconds,
        offset: seconds,
        volume,
      })
      .refine(...lasts(LIMITS.minLayerSeconds, "Music"))
      .nullable(),
    effect: z
      .strictObject({
        preset: z.enum(EFFECT_PRESETS),
        start: seconds,
        end: seconds,
      })
      .refine(...lasts(LIMITS.minLayerSeconds, "An effect"))
      .nullable(),
    watermark: z
      .strictObject({
        start: seconds,
        end: seconds,
        x: watermarkEdge,
        y: watermarkEdge,
        width: watermarkEdge,
        height: watermarkEdge,
      })
      .refine(...insideEdge("width"))
      .refine(...insideEdge("height"))
      .refine(...lasts(LIMITS.minLayerSeconds, "Watermark removal"))
      .nullable(),
  })
  .superRefine((draft, context) => {
    if (draft.segments[0]?.transition.kind !== "cut") {
      context.addIssue({
        code: "custom",
        message: "The first segment starts with a cut.",
        path: ["segments", 0, "transition"],
      });
    }
    for (const key of ["segments", "texts", "images"] as const) {
      const seen = new Set<string>();
      for (const [index, item] of draft[key].entries()) {
        if (seen.has(item.id)) {
          context.addIssue({
            code: "custom",
            message: "Two items share this id.",
            path: [key, index, "id"],
          });
        }
        seen.add(item.id);
      }
    }
  });

interface Refusal {
  path: (string | number)[];
  what: string;
}
interface Rule {
  capability: Capability;
  refuse?: (draft: EditDraft) => Refusal[];
  stage: DeliveryStage;
}
const when = (
  condition: boolean,
  path: Refusal["path"],
  what: string
): Refusal[] => (condition ? [{ path, what }] : []);
const outputSeconds = (draft: EditDraft) =>
  schedule(draft).totalFrames / draft.fps;

const RULES: readonly Rule[] = [
  { capability: "trim", stage: 1 },
  { capability: "cropX", stage: 1 },
  { capability: "captions", stage: 1 },
  {
    capability: "timeline",
    stage: 2,
    refuse: (draft) => [
      ...when(draft.segments.length > 1, ["segments"], "More than one segment"),
      ...when(
        outputSeconds(draft) > LIMITS.stageOneMaxSeconds,
        ["segments"],
        `A version longer than ${LIMITS.stageOneMaxSeconds} seconds`
      ),
    ],
  },
  {
    capability: "captionTiming",
    stage: 2,
    refuse: (draft) =>
      draft.segments.flatMap((item, i) =>
        item.captions.flatMap((edit, j) =>
          "timing" in edit
            ? when(
                edit.timing !== null,
                ["segments", i, "captions", j, "timing"],
                "Retiming a caption"
              )
            : [
                {
                  path: ["segments", i, "captions", j, "anchor"],
                  what: "Adding a caption",
                },
              ]
        )
      ),
  },
  {
    capability: "transitions",
    stage: 2,
    refuse: (draft) =>
      draft.segments.flatMap((item, i) =>
        when(
          item.transition.kind !== "cut",
          ["segments", i, "transition"],
          "A transition"
        )
      ),
  },
  {
    capability: "compositing",
    stage: 3,
    refuse: (draft) => [
      ...when(draft.texts.length > 0, ["texts"], "Text"),
      ...when(draft.images.length > 0, ["images"], "An image overlay"),
      ...when(draft.audio !== null, ["audio"], "Music"),
      ...when(draft.effect !== null, ["effect"], "An effect"),
      ...when(draft.watermark !== null, ["watermark"], "Watermark removal"),
      ...draft.segments.flatMap((item, i) =>
        when(
          item.volume !== DEFAULTS.volume,
          ["segments", i, "volume"],
          "Changing a segment's volume"
        )
      ),
    ],
  },
  {
    capability: "output",
    stage: 3,
    refuse: (draft) => [
      ...when(
        draft.aspectRatio !== DEFAULTS.aspectRatio,
        ["aspectRatio"],
        `An aspect ratio other than ${DEFAULTS.aspectRatio}`
      ),
      ...when(
        draft.fps !== DEFAULTS.fps,
        ["fps"],
        `A frame rate other than ${DEFAULTS.fps} fps`
      ),
      ...when(
        draft.quality !== DEFAULTS.quality,
        ["quality"],
        `Quality other than ${DEFAULTS.quality}`
      ),
      ...draft.segments.flatMap((item, i) =>
        when(
          item.cropY !== DEFAULTS.cropY,
          ["segments", i, "cropY"],
          "Moving the crop up or down"
        )
      ),
    ],
  },
  { capability: "imageAudioUpload", stage: 3 },
  {
    capability: "mediaTimeline",
    stage: 4,
    refuse: (draft) =>
      draft.segments.flatMap((item, i) =>
        when(
          item.source.kind !== "job",
          ["segments", i, "source"],
          "Uploaded media on the timeline"
        )
      ),
  },
  { capability: "videoUpload", stage: 4 },
  { capability: "detection", stage: 4 },
];

/**
 * Exact structure and deterministic cleanup, nothing that needs the media:
 * every key present and no others, finite bounded numbers, unique ids,
 * cleaned caption text, and caption edits in canonical order. No defaults and
 * no generated ids. An equal request replays equal through this even after
 * its media is gone.
 */
export function parseDocument(value: unknown): EditDraft {
  const result = documentSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const [first, ...rest] = result.error.issues.map((issue) => {
    const path = issue.path.map((key) =>
      typeof key === "number" ? key : String(key)
    );
    return { targetId: targetOf(value, path), path, message: issue.message };
  });
  throw new SettingsError(
    "invalid-settings",
    first ? [first, ...rest] : [unknownIssue]
  );
}

/**
 * The whole boundary: parseDocument, then this stage's policy, then the
 * checks that need the media (sources, durations, transcript indices, frame
 * lengths, caption overlaps, layer windows). Throws SettingsError.
 */
export function parseSettings(
  value: unknown,
  sources: SourceCatalog,
  stage: DeliveryStage
): EditSettings {
  const draft = parseDocument(value);
  const [refused, ...more] = RULES.filter((rule) => rule.stage > stage).flatMap(
    (rule) =>
      (rule.refuse?.(draft) ?? []).map(
        ({ path, what }): Issue => ({
          targetId: targetOf(draft, path),
          path,
          message: `${what} is available in stage ${rule.stage}.`,
        })
      )
  );
  if (refused) {
    throw new SettingsError("unsupported-feature", [refused, ...more]);
  }
  const [invalid, ...others] = contextIssues(draft, sources);
  if (invalid) {
    throw new SettingsError("invalid-settings", [invalid, ...others]);
  }
  return draft as EditSettings;
}

/** parseSettings' issues for a draft, or none. The editor shows these; it never validates on its own. */
export function issuesFor(
  draft: EditDraft,
  sources: SourceCatalog,
  stage: DeliveryStage
): readonly Issue[] {
  try {
    parseSettings(draft, sources, stage);
    return [];
  } catch (error) {
    if (error instanceof SettingsError) {
      return error.issues;
    }
    throw error;
  }
}

export function capabilitiesFor(
  stage: DeliveryStage,
  stockConfigured: boolean
): Capabilities {
  const enabled = RULES.filter((rule) => rule.stage <= stage).map(
    (rule) => rule.capability
  );
  return {
    stage,
    enabled,
    stock: stockConfigured && enabled.includes("mediaTimeline"),
  };
}

/** Every asset a document uses, sorted and unique. */
export function assetIdsOf(settings: EditDraft): readonly string[] {
  const refs: SourceRef[] = [
    ...settings.segments.map((item) => item.source),
    ...settings.images.map((image) => image.source),
    ...(settings.audio ? [settings.audio.source] : []),
  ];
  const ids = refs.flatMap((ref) => (ref.kind === "asset" ? [ref.id] : []));
  return [...new Set(ids)].sort();
}

const unknownIssue: Issue = {
  targetId: null,
  path: [],
  message: "These settings aren't a version document.",
};

function targetOf(
  value: unknown,
  path: readonly (string | number)[]
): string | null {
  const [key, index] = path;
  if (
    !(key === "segments" || key === "texts" || key === "images") ||
    typeof index !== "number" ||
    typeof value !== "object" ||
    value === null
  ) {
    return null;
  }
  const items: unknown = (value as Record<string, unknown>)[key];
  const item: unknown = Array.isArray(items) ? items[index] : undefined;
  const itemId: unknown =
    typeof item === "object" && item !== null
      ? (item as Record<string, unknown>).id
      : undefined;
  return typeof itemId === "string" ? itemId : null;
}

function contextIssues(draft: EditDraft, sources: SourceCatalog): Issue[] {
  const plan = schedule(draft);
  const total = plan.totalFrames / draft.fps;
  const issues = draft.segments.flatMap((_, index) =>
    segmentIssues(draft, index, sources, plan.spans)
  );
  if (total < LIMITS.minSeconds || total > LIMITS.maxSeconds) {
    issues.push({
      targetId: null,
      path: ["segments"],
      message: `A version is ${LIMITS.minSeconds} to ${LIMITS.maxSeconds} seconds long.`,
    });
  }
  return [...issues, ...layerIssues(draft, total, sources)];
}

function segmentIssues(
  draft: EditDraft,
  index: number,
  sources: SourceCatalog,
  spans: ReturnType<typeof schedule>["spans"]
): Issue[] {
  const item = draft.segments[index];
  if (!item) {
    return [];
  }
  const at = ["segments", index];
  const issue = (path: (string | number)[], message: string): Issue => ({
    targetId: item.id,
    path: [...at, ...path],
    message,
  });
  const fact = sources.find((source) => sameSource(source.ref, item.source));
  if (!fact || fact.kind === "audio") {
    return [
      issue(
        ["source"],
        fact
          ? "A segment needs video or an image."
          : "This media isn't available."
      ),
    ];
  }
  const extent = fact.kind === "image" ? LIMITS.maxImageSeconds : fact.duration;
  const issues: Issue[] = [];
  if (item.end > extent) {
    issues.push(
      issue(
        ["end"],
        `The source is ${extent.toFixed(2)} seconds long, so a segment must end by then.`
      )
    );
  }
  const words = "words" in fact ? fact.words : [];
  for (const [j, edit] of item.captions.entries()) {
    const timing = "timing" in edit ? edit.timing : edit.anchor;
    if (edit.anchor.kind === "words" && edit.anchor.last >= words.length) {
      issues.push(
        issue(
          ["captions", j, "anchor"],
          "A caption edit points past the transcript's last word."
        )
      );
    }
    if (timing && timing.end > extent) {
      issues.push(
        issue(["captions", j], "A caption must end by the source's end.")
      );
    }
  }
  issues.push(...overlapIssues(item, words, issue));
  issues.push(...transitionIssues(draft, index, spans, issue));
  return issues;
}

function transitionIssues(
  draft: EditDraft,
  index: number,
  spans: ReturnType<typeof schedule>["spans"],
  issue: (path: (string | number)[], message: string) => Issue
): Issue[] {
  const item = draft.segments[index];
  const previous = draft.segments[index - 1];
  const span = spans[index];
  const previousSpan = spans[index - 1];
  if (
    !(item && previous && span && previousSpan) ||
    item.transition.kind === "cut"
  ) {
    return [];
  }
  const half =
    Math.min(item.end - item.start, previous.end - previous.start) / 2;
  const halfFrames = Math.floor(
    Math.min(span.lengthFrames, previousSpan.lengthFrames) / 2
  );
  const fits =
    item.transition.duration <= half &&
    span.overlapFrames >= 1 &&
    span.overlapFrames <= halfFrames;
  return fits
    ? []
    : [
        issue(
          ["transition", "duration"],
          "A transition lasts at least a frame and at most half of each segment it joins."
        ),
      ];
}

function overlapIssues(
  item: Segment,
  words: readonly Word[],
  issue: (path: (string | number)[], message: string) => Issue
): Issue[] {
  const rows = captionRows(words, item);
  if (rows.length > LIMITS.captionRows) {
    return [
      issue(
        ["captions"],
        `A segment shows at most ${LIMITS.captionRows} captions.`
      ),
    ];
  }
  const cs = (time: number) => Math.round((time - item.start) * 100);
  const visible = rows.filter((row) => row.lines.length > 0);
  const issues: Issue[] = [];
  for (const [j, edit] of item.captions.entries()) {
    if ("timing" in edit && edit.timing === null) {
      continue;
    }
    const row = visible.find((candidate) =>
      sameAnchor(candidate.anchor, edit.anchor)
    );
    const clashes = visible.some(
      (other) =>
        other !== row &&
        row !== undefined &&
        cs(other.start) < cs(row.end) &&
        cs(row.start) < cs(other.end)
    );
    if (clashes) {
      issues.push(issue(["captions", j], "This caption overlaps another one."));
    }
  }
  return issues;
}

function sameAnchor(a: CaptionAnchor, b: CaptionAnchor): boolean {
  return a.kind === "cue"
    ? b.kind === "cue" && b.id === a.id
    : b.kind === "words" && b.first === a.first && b.last === a.last;
}

function layerIssues(
  draft: EditDraft,
  total: number,
  sources: SourceCatalog
): Issue[] {
  const issues: Issue[] = [];
  const late = (
    layer: Range,
    path: (string | number)[],
    targetId: string | null
  ) => {
    if (layer.end > total) {
      issues.push({
        targetId,
        path: [...path, "end"],
        message: "Ends after the video does.",
      });
    }
  };
  const factOf = (ref: SourceRef) =>
    sources.find((source) => sameSource(source.ref, ref));
  for (const [i, text] of draft.texts.entries()) {
    late(text, ["texts", i], text.id);
  }
  for (const [i, image] of draft.images.entries()) {
    late(image, ["images", i], image.id);
    if (factOf(image.source)?.kind !== "image") {
      issues.push({
        targetId: image.id,
        path: ["images", i, "source"],
        message: "An image overlay needs an image.",
      });
    }
  }
  for (const key of ["effect", "watermark"] as const) {
    const layer = draft[key];
    if (layer) {
      late(layer, [key], null);
    }
  }
  const { audio } = draft;
  if (audio) {
    late(audio, ["audio"], null);
    const fact = factOf(audio.source);
    if (fact?.kind !== "audio") {
      issues.push({
        targetId: null,
        path: ["audio", "source"],
        message: "Music needs an audio file.",
      });
    } else if (audio.offset + audio.end - audio.start > fact.duration) {
      issues.push({
        targetId: null,
        path: ["audio", "offset"],
        message: "The music file ends before this track does.",
      });
    }
  }
  return issues;
}
