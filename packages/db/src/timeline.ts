import { type Cue, captionRows, segmentCues } from "./captions";
import type {
  EditDraft,
  EditSettings,
  Fps,
  SourceCatalog,
  SourceRef,
} from "./editor";

export interface Span {
  endFrame: number;
  index: number;
  lengthFrames: number;
  /** Frames shared with the previous segment. 0 for a cut. */
  overlapFrames: number;
  segmentId: string;
  startFrame: number;
}
export interface Schedule {
  fps: Fps;
  spans: readonly Span[];
  totalFrames: number;
}
export interface PreviewLayer {
  /** Linear, as acrossfade's default curve, times the segment's volume. */
  gain: number;
  /** The later of two layers during a transition. Its video drives the clock. */
  incoming: boolean;
  localFrame: number;
  segmentId: string;
  source: SourceRef;
  sourceTime: number;
}
export interface PreviewFrame {
  frame: number;
  /** Outgoing layer first. Two layers only during a transition. */
  layers: readonly PreviewLayer[];
  /** 0 to 1 through the transition, 0 outside one. */
  progress: number;
  transition: "cut" | "fade" | "slide" | "zoom";
}

export interface LocalInput {
  duration: number;
  /** Relative to DATA_DIR, resolved by the owner from its own records. Never from the browser. */
  file: string;
  kind: "video" | "image" | "audio";
  ref: SourceRef;
}
export interface RenderPlan {
  /** One entry per segment, in order. Empty when captions are off; the edits stay in settings. */
  captions: readonly { segmentId: string; cues: readonly Cue[] }[];
  /** One per media the settings use; the compiler decides input occurrences. */
  inputs: readonly LocalInput[];
  schedule: Schedule;
  settings: EditSettings;
}

/**
 * Never throws, so the editor can lay out a draft with impossible overlaps.
 * parseSettings refuses those, from these same spans.
 */
export function schedule(
  settings: Pick<EditDraft, "segments" | "fps">
): Schedule {
  const spans: Span[] = [];
  for (const [index, segment] of settings.segments.entries()) {
    const previous = spans.at(-1);
    const lengthFrames = Math.round(
      (segment.end - segment.start) * settings.fps
    );
    const overlapFrames =
      previous && segment.transition.kind !== "cut"
        ? Math.round(segment.transition.duration * settings.fps)
        : 0;
    const startFrame = previous ? previous.endFrame - overlapFrames : 0;
    spans.push({
      segmentId: segment.id,
      index,
      startFrame,
      lengthFrames,
      endFrame: startFrame + lengthFrames,
      overlapFrames,
    });
  }
  return {
    fps: settings.fps,
    spans,
    totalFrames: Math.max(0, ...spans.map((span) => span.endFrame)),
  };
}

/** The frame showing at output second `at`, clamped to the timeline. */
export function frameAt(settings: EditDraft, at: number): PreviewFrame {
  const { fps, spans, totalFrames } = schedule(settings);
  const frame = Math.min(
    Math.max(Math.floor(at * fps + FRAME_EPSILON), 0),
    Math.max(totalFrames - 1, 0)
  );
  const active = spans.filter(
    (span) => span.startFrame <= frame && frame < span.endFrame
  );
  const incoming = active.length > 1 ? active.at(-1) : undefined;
  const progress = incoming
    ? (frame - incoming.startFrame) / incoming.overlapFrames
    : 0;
  const layers = active.flatMap((span): PreviewLayer[] => {
    const segment = settings.segments[span.index];
    if (!segment) {
      return [];
    }
    const localFrame = frame - span.startFrame;
    const isIncoming = span === incoming;
    let fade = 1;
    if (incoming) {
      fade = isIncoming ? progress : 1 - progress;
    }
    return [
      {
        segmentId: span.segmentId,
        source: segment.source,
        sourceTime: segment.start + localFrame / fps,
        localFrame,
        incoming: isIncoming,
        gain: segment.volume * fade,
      },
    ];
  });
  const transition = incoming
    ? (settings.segments[incoming.index]?.transition.kind ?? "cut")
    : "cut";
  return { frame, layers, progress, transition };
}

/**
 * Where source second `sourceTime` of a segment plays in the output, for
 * transcript clicks. A time outside the segment's trim clamps to its edge.
 */
export function outputTime(
  settings: EditDraft,
  segmentId: string,
  sourceTime: number
): number {
  const { fps, spans } = schedule(settings);
  const index = settings.segments.findIndex((item) => item.id === segmentId);
  const segment = settings.segments[index];
  const span = spans[index];
  if (!(segment && span)) {
    throw new Error(`No segment ${segmentId} in this timeline.`);
  }
  const local = Math.min(
    Math.max(sourceTime - segment.start, 0),
    span.lengthFrames / fps
  );
  return span.startFrame / fps + local;
}

/**
 * The plan for parsed settings: the schedule, each segment's cues, and the
 * inputs bound to exactly the media the settings use. Throws when a binding
 * is missing, doubled, or unused. No probing or I/O.
 */
export function resolvePlan(
  settings: EditSettings,
  sources: SourceCatalog,
  inputs: readonly LocalInput[]
): RenderPlan {
  const timeline = schedule(settings);
  const used = [
    ...settings.segments.map((segment) => segment.source),
    ...settings.images.map((image) => image.source),
    ...(settings.audio ? [settings.audio.source] : []),
  ];
  for (const ref of used) {
    if (inputs.filter((input) => sameSource(input.ref, ref)).length !== 1) {
      throw new Error(`Exactly one input must bind ${JSON.stringify(ref)}.`);
    }
  }
  for (const input of inputs) {
    if (!used.some((ref) => sameSource(ref, input.ref))) {
      throw new Error(
        `Input ${input.file} binds media these settings never use.`
      );
    }
  }
  const captions = settings.segments.map((segment, index) => {
    const fact = sources.find((source) =>
      sameSource(source.ref, segment.source)
    );
    const words = fact && "words" in fact ? fact.words : [];
    const lengthSeconds =
      (timeline.spans[index]?.lengthFrames ?? 0) / timeline.fps;
    return {
      segmentId: segment.id,
      cues: settings.captionsEnabled
        ? segmentCues(captionRows(words, segment), segment, lengthSeconds)
        : [],
    };
  });
  return { settings, schedule: timeline, inputs, captions };
}

export function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.kind === "job"
    ? b.kind === "job"
    : b.kind === "asset" && b.id === a.id;
}

const FRAME_EPSILON = 1e-6;
