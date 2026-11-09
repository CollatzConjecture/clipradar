import type {
  Aspect,
  CaptionAnchor,
  CaptionEdit,
  Range,
  Segment,
  Word,
} from "./editor";
import { CANVASES, CAPTION, cleanLines, units } from "./rules";

export type Lines = [string] | [string, string];

/**
 * One row of the editor's caption list. Times are source seconds. The
 * anchor is the row's edit identity, not its position in the list.
 */
export interface CaptionRow extends Range {
  anchor: CaptionAnchor;
  edited: boolean;
  /** The transcript's own text for the anchored words. Empty for an added caption. */
  heard: string;
  /** As shown. `[]` when hidden. */
  lines: readonly string[];
}

export interface Cue {
  endCs: number;
  lines: Lines;
  /** Integer centiseconds from the start of the rendered segment, as .ass times are. */
  startCs: number;
}

/** The burned-in look, in output pixels. CSS and the .ass style both read it. */
export interface CaptionStyle {
  bold: boolean;
  /** libass sizes a font by its line height, CSS by its em. DejaVu Sans's line is about 1.16 em. */
  cssEmScale: number;
  font: string;
  height: number;
  marginBottom: number;
  marginX: number;
  outline: number;
  size: number;
  width: number;
}

type WordEdit = Extract<CaptionEdit, { anchor: { kind: "words" } }>;
type CueEdit = Extract<CaptionEdit, { anchor: { kind: "cue" } }>;
type Captioned = Pick<Segment, "start" | "end" | "captions">;

const MAX_PAUSE_SECONDS = 0.7;
const LINGER_SECONDS = 0.4;
/** libass would flash a shorter cue for a single frame. */
const MIN_CUE_SECONDS = 0.1;
const STYLE_HEIGHT = 1280;
const STYLE_MARGIN_BOTTOM = 300;
const CSS_EM_SCALE = 0.86;
const SENTENCE_END = /[.!?…。！？]$/u;
const ENDS_UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}　-〿！-｠]$/u;
const STARTS_UNSPACED =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}　-〿！-｠]/u;

interface Draft {
  bottom: string | null;
  end: number;
  first: number;
  last: number;
  pin: WordEdit | null;
  start: number;
  top: string;
}

interface LocalRow {
  anchor: CaptionAnchor;
  edited: boolean;
  end: number;
  heard: string;
  lines: string[];
  start: number;
}

/**
 * The word index space every word anchor points into. Every caller goes
 * through it, so an index names the same word in the browser and the worker.
 */
export function wordsOf(
  transcript: readonly { words: readonly Word[] }[]
): readonly Word[] {
  return transcript.flatMap((segment) => segment.words);
}

/**
 * The segment's captions in source seconds, sorted by time, hidden rows
 * included so the editor can restore them. An invalid draft still lays out;
 * parseSettings refuses a retimed or added caption that overlaps another row.
 */
export function captionRows(
  words: readonly Word[],
  segment: Captioned
): readonly CaptionRow[] {
  return compose(words, segment).map((row) => ({
    ...row,
    start: row.start + segment.start,
    end: row.end + segment.start,
  }));
}

/**
 * The visible rows inside `sourceRange`, from its start, clamped to the
 * rendered length and quantized to centiseconds once. A row that rounds to
 * nothing drops on its own; no captions at all is a valid answer.
 */
export function segmentCues(
  rows: readonly CaptionRow[],
  sourceRange: Range,
  lengthSeconds: number
): readonly Cue[] {
  return rows.flatMap((row) =>
    toCue(
      Math.max(row.start, sourceRange.start) - sourceRange.start,
      Math.min(row.end, sourceRange.end) - sourceRange.start,
      lengthSeconds,
      row.lines
    )
  );
}

/**
 * The job render's captions for a clip: its words, no edits. Quantized from
 * the same arithmetic the worker used before versions existed, so original
 * clips burn in exactly what they always did.
 */
export function clipCues(words: readonly Word[], range: Range): readonly Cue[] {
  return compose(words, { ...range, captions: [] }).flatMap((row) =>
    toCue(row.start, row.end, range.end - range.start, row.lines)
  );
}

export function captionStyle(aspect: Aspect): CaptionStyle {
  const [width, height] = CANVASES[aspect];
  return {
    width,
    height,
    font: "DejaVu Sans",
    size: 56,
    bold: true,
    outline: 4,
    marginX: 50,
    marginBottom: Math.round((STYLE_MARGIN_BOTTOM * height) / STYLE_HEIGHT),
    cssEmScale: CSS_EM_SCALE,
  };
}

/**
 * The edits after one change to one row. Text on a word row pins its words
 * (or retypes the pin already there); timing retimes it. A cue row keeps its
 * id. Restore drops the row's own edit, which for an added caption removes it.
 */
export function editCaption(
  edits: readonly CaptionEdit[],
  row: CaptionRow,
  change:
    | { kind: "text"; text: string }
    | { kind: "timing"; range: Range }
    | { kind: "restore" }
): CaptionEdit[] {
  const { anchor } = row;
  if (anchor.kind === "cue") {
    const same = (edit: CaptionEdit): edit is CueEdit =>
      edit.anchor.kind === "cue" && edit.anchor.id === anchor.id;
    const rest = edits.filter((edit) => !same(edit));
    if (change.kind === "restore") {
      return rest;
    }
    const current: CueEdit = edits.find(same) ?? {
      anchor,
      lines: [...row.lines],
    };
    const next: CueEdit =
      change.kind === "text"
        ? { ...current, lines: toLines(change.text) }
        : {
            ...current,
            anchor: { ...current.anchor, ...rangeOf(change.range) },
          };
    return canonicalEdits([...rest, next]);
  }
  const covers = (edit: CaptionEdit): edit is WordEdit =>
    edit.anchor.kind === "words" &&
    edit.anchor.first <= anchor.last &&
    anchor.first <= edit.anchor.last;
  const rest = edits.filter((edit) => !covers(edit));
  if (change.kind === "restore") {
    return rest;
  }
  const current: WordEdit = edits.find(covers) ?? {
    anchor: { kind: "words", first: anchor.first, last: anchor.last },
    timing: null,
    lines: [...row.lines],
  };
  const next: WordEdit =
    change.kind === "text"
      ? { ...current, lines: toLines(change.text) }
      : { ...current, timing: rangeOf(change.range) };
  return canonicalEdits([...rest, next]);
}

/** Store order: word edits by first word, then added captions by id. */
export function canonicalEdits<T extends CaptionEdit>(
  edits: readonly T[]
): T[] {
  return edits.toSorted((a, b) => {
    if (a.anchor.kind === "words" && b.anchor.kind === "words") {
      return a.anchor.first - b.anchor.first;
    }
    if (a.anchor.kind === "cue" && b.anchor.kind === "cue") {
      return (
        Number(a.anchor.id > b.anchor.id) - Number(a.anchor.id < b.anchor.id)
      );
    }
    return a.anchor.kind === "words" ? -1 : 1;
  });
}

function compose(words: readonly Word[], segment: Captioned): LocalRow[] {
  const length = segment.end - segment.start;
  const shift = (seconds: number) =>
    Math.min(Math.max(seconds - segment.start, 0), length);
  const timed = timedRows(words, segment.captions, shift);
  // ponytail: script detection by regex, not Unicode line breaking. Enough for Latin, CJK, and Thai.
  const drafts = draftWords(words, segment, shift);
  const drafted = drafts.flatMap((draft, index): LocalRow[] => {
    const end = Math.min(
      draft.end + LINGER_SECONDS,
      drafts[index + 1]?.start ?? length,
      timed.find((row) => row.start >= draft.end)?.start ?? length
    );
    if (end - draft.start < MIN_CUE_SECONDS) {
      return [];
    }
    return [
      {
        start: draft.start,
        end,
        anchor: { kind: "words", first: draft.first, last: draft.last },
        lines: linesOf(draft),
        edited: draft.pin !== null,
        heard: joinRun(words.slice(draft.first, draft.last + 1)),
      },
    ];
  });
  return mergeByStart(drafted, timed);
}

function draftWords(
  words: readonly Word[],
  segment: Captioned,
  shift: (seconds: number) => number
): Draft[] {
  const pins = canonicalEdits(segment.captions).filter(
    (edit): edit is WordEdit => edit.anchor.kind === "words"
  );
  const drafts: Draft[] = [];
  let next = 0;
  for (const [index, word] of words.entries()) {
    if (!heardIn(word, segment)) {
      continue;
    }
    while ((pins[next]?.anchor.last ?? index) < index) {
      next += 1;
    }
    const run = pins[next];
    const pin = run && run.anchor.first <= index ? run : null;
    if (pin?.timing) {
      continue;
    }
    const start = shift(word.start);
    const end = shift(word.end);
    const draft = drafts.at(-1);
    if (pin && draft?.pin === pin) {
      draft.end = end;
    } else if (pin) {
      drafts.push({
        start,
        end,
        top: "",
        bottom: null,
        pin,
        first: pin.anchor.first,
        last: pin.anchor.last,
      });
    } else if (draft && continues(draft, pins[next - 1], start, word.text)) {
      draft.end = end;
      draft.last = index;
    } else {
      drafts.push({
        start,
        end,
        top: word.text,
        bottom: null,
        pin: null,
        first: index,
        last: index,
      });
    }
  }
  return drafts;
}

function timedRows(
  words: readonly Word[],
  edits: readonly CaptionEdit[],
  shift: (seconds: number) => number
): LocalRow[] {
  return edits
    .flatMap((edit): LocalRow[] => {
      const timing = isCue(edit) ? edit.anchor : edit.timing;
      if (!timing) {
        return [];
      }
      const start = shift(timing.start);
      const end = shift(timing.end);
      if (end <= start) {
        return [];
      }
      return [
        {
          start,
          end,
          anchor: edit.anchor,
          lines: cleanLines(edit.lines),
          edited: true,
          heard:
            edit.anchor.kind === "words"
              ? joinRun(words.slice(edit.anchor.first, edit.anchor.last + 1))
              : "",
        },
      ];
    })
    .sort((a, b) => a.start - b.start);
}

function mergeByStart(drafted: LocalRow[], timed: LocalRow[]): LocalRow[] {
  const merged: LocalRow[] = [];
  let t = 0;
  for (const row of drafted) {
    let early = timed[t];
    while (early && early.start < row.start) {
      merged.push(early);
      t += 1;
      early = timed[t];
    }
    merged.push(row);
  }
  return [...merged, ...timed.slice(t)];
}

function isCue(edit: CaptionEdit): edit is CueEdit {
  return edit.anchor.kind === "cue";
}

function toCue(
  start: number,
  end: number,
  lengthSeconds: number,
  lines: readonly string[]
): Cue[] {
  const [top, ...rest] = lines;
  const clamp = (seconds: number) =>
    Math.round(Math.min(Math.max(seconds, 0), lengthSeconds) * 100);
  const startCs = clamp(start);
  const endCs = clamp(end);
  if (top === undefined || endCs <= startCs) {
    return [];
  }
  return [
    { startCs, endCs, lines: rest.length > 0 ? [top, rest.join(" ")] : [top] },
  ];
}

function rangeOf({ start, end }: Range): Range {
  return { start, end };
}

function toLines(text: string): string[] {
  const parts = text.split("\n");
  const kept =
    parts.length > CAPTION.maxLines
      ? [
          ...parts.slice(0, CAPTION.maxLines - 1),
          parts.slice(CAPTION.maxLines - 1).join(" "),
        ]
      : parts;
  return kept.map((line) => line.slice(0, CAPTION.maxLineChars));
}

function linesOf(draft: Draft): string[] {
  if (draft.pin) {
    return cleanLines(draft.pin.lines);
  }
  return draft.bottom === null ? [draft.top] : [draft.top, draft.bottom];
}

function heardIn(word: Word, { start, end }: Range): boolean {
  const middle = (word.start + word.end) / 2;
  return middle >= start && middle < end;
}

function continues(
  draft: Draft,
  previousPin: WordEdit | undefined,
  start: number,
  text: string
): boolean {
  return (
    draft.pin === null &&
    (previousPin?.anchor.first ?? -1) <= draft.last &&
    start - draft.end <= MAX_PAUSE_SECONDS &&
    !SENTENCE_END.test(draft.bottom ?? draft.top) &&
    append(draft, text)
  );
}

function append(draft: Draft, text: string): boolean {
  if (draft.bottom === null) {
    const top = joinWords(draft.top, text);
    if (units(top) <= CAPTION.lineUnits) {
      draft.top = top;
    } else {
      draft.bottom = text;
    }
    return true;
  }
  const bottom = joinWords(draft.bottom, text);
  if (units(bottom) > CAPTION.lineUnits) {
    return false;
  }
  draft.bottom = bottom;
  return true;
}

function joinRun(run: readonly Word[]): string {
  const [head, ...rest] = run;
  return rest.reduce(
    (text, word) => joinWords(text, word.text),
    head?.text ?? ""
  );
}

function joinWords(left: string, right: string): string {
  const unspaced = ENDS_UNSPACED.test(left) && STARTS_UNSPACED.test(right);
  return unspaced ? `${left}${right}` : `${left} ${right}`;
}
