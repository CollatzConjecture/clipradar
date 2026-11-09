import { z } from "zod";

/**
 * Product rules shared by the browser forms and the clip editor, the upload
 * route and the API, the worker, and the database check constraints in
 * schema/job.ts.
 * This file imports nothing but zod so the browser bundle can use it without
 * pulling in drizzle or pg. Nothing else may restate these numbers.
 */
export const CLIP_COUNT = { min: 1, max: 20, default: 10 } as const;
export const CLIP_SECONDS = { min: 15, max: 60 } as const;
export const SCORE = { min: 0, max: 10 } as const;
/** Output frame sizes by aspect ratio, in pixels. Every caption and overlay is laid out in these. */
export const CANVASES = {
  "9:16": [720, 1280],
  "16:9": [1280, 720],
  "1:1": [720, 720],
} as const;
/**
 * Caption layout. 18 units of 56 px DejaVu Sans Bold fill the 620 px between
 * the side margins of the 720 px frame, and libass never wraps (WrapStyle 2),
 * so a wider line runs off the frame.
 */
export const CAPTION = {
  lineUnits: 18,
  maxLines: 2,
  /** Raw characters per line before cleaning. Stops a paste bomb, not a layout rule. */
  maxLineChars: 200,
} as const;

const WHISPER_LANGUAGE = /^[a-z]{2,3}$/u;
const MAX_SOURCE_NAME = 200;
const WIDE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u;
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\u3000-\u303f\uff01-\uff60]/u;
const CONTROL = /\p{Cc}/gu;
const SPACES = /\s+/gu;
const SPACE = /\s/u;

/**
 * Options for a new job. The upload route parses them from the query string
 * of `POST /api/jobs`, whose body is the raw video.
 */
export const newJobOptions = z.object({
  clipCount: z.coerce
    .number()
    .int()
    .min(CLIP_COUNT.min)
    .max(CLIP_COUNT.max)
    .default(CLIP_COUNT.default),
  /** Whisper language code. Empty or missing means auto-detect. */
  language: z
    .union([z.literal(""), z.string().regex(WHISPER_LANGUAGE)])
    .default("")
    .transform((code) => code || null),
  /** Original file name, for display only. Never used to build a path. */
  name: z.string().trim().min(1).max(MAX_SOURCE_NAME).default("video"),
});

export type NewJobOptions = z.output<typeof newJobOptions>;

/** Display width of a caption line. Wide (CJK) characters count 2. */
export function units(text: string): number {
  let total = 0;
  for (const character of text) {
    total += WIDE.test(character) ? 2 : 1;
  }
  return total;
}

export function cleanText(text: string): string {
  return text.replace(CONTROL, " ").replace(SPACES, " ").trim();
}

/**
 * The one normalization of typed caption text, shared by the editor preview
 * and the render: cleanText, then the characters libass reads as override
 * tags become full-width look-alikes, and empty lines drop. `[]` hides the
 * caption.
 */
export function cleanLines(lines: readonly string[]): string[] {
  return lines
    .map((line) =>
      cleanText(line)
        .replaceAll("\\", "＼")
        .replaceAll("{", "｛")
        .replaceAll("}", "｝")
    )
    .filter(Boolean);
}

/**
 * A line fits in CAPTION.lineUnits, or is a single word too long for any
 * line, which caption drafting also gives a line of its own. A run of CJK or
 * Thai characters is not one word: those scripts write sentences unspaced.
 */
export function lineFits(line: string): boolean {
  return (
    units(line) <= CAPTION.lineUnits ||
    !(SPACE.test(line) || UNSPACED.test(line))
  );
}
