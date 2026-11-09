import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type CaptionRow,
  type Cue,
  captionRows,
  captionStyle,
  clipCues,
  editCaption,
  segmentCues,
} from "./captions";
import type { CaptionEdit, Range, Word } from "./editor";

const sentence =
  "the quick brown fox jumps over the lazy dog and then it runs far away into the deep dark woods";
const words: Word[] = sentence
  .split(" ")
  .map((text, i) => ({ start: 10 + i * 0.3, end: 10 + i * 0.3 + 0.25, text }));

type WordSet = "whisper" | "wide" | "edge";
const golden: {
  words: Record<WordSet, Word[]>;
  cases: {
    words: WordSet;
    range: { startSeconds: number; endSeconds: number };
    cues: { start: number; end: number; lines: string[] }[];
  }[];
} = JSON.parse(
  readFileSync(new URL("captions.golden.json", import.meta.url), "utf8")
);

let seed = 11;
const random = () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const { whisper } = golden.words;
const randomRange = (): Range => {
  const start = random() * 100;
  return { start, end: start + 1 + random() * 60 };
};
const pin = (
  first: number,
  last: number,
  lines: string[],
  timing: Range | null = null
): CaptionEdit => ({ anchor: { kind: "words", first, last }, timing, lines });
const added = (id: string, start: number, end: number, lines: string[]) => ({
  anchor: { kind: "cue" as const, id, start, end },
  lines,
});
const randomEdits = (count: number): CaptionEdit[] => {
  const edits: CaptionEdit[] = [];
  let first = Math.floor(random() * 20);
  for (let i = 0; i < count && first < whisper.length; i += 1) {
    const last = first + Math.floor(random() * 6);
    edits.push(pin(first, last, random() < 0.2 ? [] : [`edit ${i}`]));
    first = last + 1 + Math.floor(random() * 30);
  }
  return edits;
};
const rows = (
  spoken: readonly Word[],
  range: Range,
  captions: CaptionEdit[] = []
) => captionRows(spoken, { ...range, captions });
const cues = (
  spoken: readonly Word[],
  range: Range,
  captions: CaptionEdit[] = []
) => segmentCues(rows(spoken, range, captions), range, range.end - range.start);
const anchorOf = (row: CaptionRow) =>
  row.anchor.kind === "words" ? [row.anchor.first, row.anchor.last] : [];

test("clipCues burns in the centiseconds and lines the worker captured before the move", () => {
  assert.ok(golden.cases.length > 20, "the golden covers many trims");
  for (const { words: name, range, cues: expected } of golden.cases) {
    const captured: Cue[] = expected.map((cue) => ({
      startCs: Math.round(cue.start * 100),
      endCs: Math.round(cue.end * 100),
      lines: cue.lines as Cue["lines"],
    }));
    assert.equal(
      JSON.stringify(
        clipCues(golden.words[name], {
          start: range.startSeconds,
          end: range.endSeconds,
        })
      ),
      JSON.stringify(captured),
      `${name} ${range.startSeconds}..${range.endSeconds}`
    );
  }
});

test("a segment with no edits burns in what the job render does for the same range", () => {
  for (const { words: name, range } of golden.cases) {
    const trim = { start: range.startSeconds, end: range.endSeconds };
    assert.deepEqual(
      cues(golden.words[name], trim),
      clipCues(golden.words[name], trim)
    );
  }
});

test("captions show every word in order, at most two short lines each, inside the clip, never overlapping", () => {
  const shown = clipCues(words, { start: 10, end: 30 });
  assert.ok(shown.length > 1);
  assert.equal(shown.flatMap((cue) => cue.lines).join(" "), sentence);
  let previousEnd = 0;
  for (const cue of shown) {
    assert.ok(cue.lines.length <= 2);
    for (const text of cue.lines) {
      assert.ok(text.length > 0 && text.length <= 18);
    }
    assert.ok(cue.startCs >= previousEnd);
    assert.ok(cue.endCs > cue.startCs);
    assert.ok(cue.endCs <= 2000);
    previousEnd = cue.endCs;
  }
});

test("a new cue starts after a pause or a sentence end, and words outside the clip drop", () => {
  const spoken: Word[] = [
    { start: 0, end: 0.4, text: "before" },
    { start: 10.1, end: 10.4, text: "Hello" },
    { start: 12, end: 12.3, text: "again." },
    { start: 12.4, end: 12.7, text: "Done" },
    { start: 25.2, end: 25.5, text: "after" },
  ];
  assert.deepEqual(
    clipCues(spoken, { start: 10, end: 25 }).map((cue) => cue.lines),
    [["Hello"], ["again."], ["Done"]]
  );
});

test("a cue too short to see drops instead of flashing at the clip's end", () => {
  const edge: Word[] = [
    { start: 5, end: 5.3, text: "kept" },
    { start: 14.97, end: 15.02, text: "edge" },
  ];
  assert.deepEqual(clipCues(edge, { start: 0, end: 15 }), [
    { startCs: 500, endCs: 570, lines: ["kept"] },
  ]);
});

test("CJK words join without spaces and count double width", () => {
  const cjk: Word[] = Array.from({ length: 12 }, (_, i) => ({
    start: i * 0.3,
    end: i * 0.3 + 0.25,
    text: "你好",
  }));
  assert.deepEqual(clipCues(cjk, { start: 0, end: 15 })[0]?.lines, [
    "你好你好你好你好",
    "你好你好你好你好",
  ]);
});

test("a range with no speech has no cues", () => {
  assert.deepEqual(clipCues(words, { start: 100, end: 130 }), []);
});

test("a pinned run shows its typed lines over its own words while the captions around it reflow with the trim", () => {
  const edit = pin(6, 8, ["  THE LAZY ", "dog"]);
  for (const range of [
    { start: 10, end: 30 },
    { start: 11.4, end: 14 },
    { start: 12.05, end: 20 },
  ]) {
    const row = rows(words, range, [edit]).find((r) => r.edited);
    assert.deepEqual(row && [...anchorOf(row), row.lines, row.heard], [
      6,
      8,
      ["THE LAZY", "dog"],
      "the lazy dog",
    ]);
  }
  const before = (range: Range) =>
    rows(words, range, [edit])
      .filter((row) => (anchorOf(row)[1] ?? 0) < 6)
      .map((row) => row.lines);
  assert.deepEqual(before({ start: 10, end: 30 }), [
    ["the quick brown", "fox jumps over"],
  ]);
  assert.deepEqual(before({ start: 11.2, end: 30 }), [["jumps over"]]);
});

test("rows are in source seconds and a pinned run that straddles the trim keeps its whole span and full text", () => {
  const [row] = rows(words, { start: 11, end: 20 }, [
    pin(0, 4, ["The quick brown fox", "jumps"]),
  ]);
  assert.deepEqual(row && [...anchorOf(row), row.start, row.lines], [
    0,
    4,
    11,
    ["The quick brown fox", "jumps"],
  ]);
});

test("a hidden run burns in nothing and stops the caption before it from lingering over it", () => {
  const spoken: Word[] = [
    { start: 0, end: 0.3, text: "So." },
    { start: 0.5, end: 0.6, text: "um" },
    { start: 1.5, end: 1.8, text: "yes" },
  ];
  const range = { start: 0, end: 5 };
  const hide = [pin(1, 1, [])];
  assert.deepEqual(
    rows(spoken, range, hide).map((row) => [row.lines, row.edited]),
    [
      [["So."], false],
      [[], true],
      [["yes"], false],
    ]
  );
  assert.deepEqual(cues(spoken, range, hide), [
    { startCs: 0, endCs: 50, lines: ["So."] },
    { startCs: 150, endCs: 220, lines: ["yes"] },
  ]);
});

test("words Whisper timed out of order at a pin's boundary still belong to the pin by index", () => {
  const spoken: Word[] = [
    { start: 1, end: 1.5, text: "first" },
    { start: 1.4, end: 1.6, text: "second" },
    { start: 1.3, end: 1.45, text: "third" },
    { start: 1.7, end: 2, text: "fourth" },
  ];
  assert.deepEqual(
    rows(spoken, { start: 0, end: 5 }, [pin(1, 2, ["2 and 3"])]).map((row) => [
      ...anchorOf(row),
      row.lines,
    ]),
    [
      [0, 0, ["first"]],
      [1, 2, ["2 and 3"]],
      [3, 3, ["fourth"]],
    ]
  );
});

test("rows never overlap, pinned rows span exactly their run, and unpinned rows show their kept words once, in order", () => {
  for (let i = 0; i < 300; i += 1) {
    const range = randomRange();
    const edits = randomEdits(1 + Math.floor(random() * 6));
    const kept = (index: number) => {
      const word = whisper[index];
      const middle = word ? (word.start + word.end) / 2 : -1;
      return middle >= range.start && middle < range.end;
    };
    const laid = rows(whisper, range, edits);
    let previousLast = -1;
    for (const row of laid) {
      const [first = -1, last = -1] = anchorOf(row);
      assert.ok(previousLast < first, "ordered, disjoint");
      previousLast = last;
      const covering = edits.find(
        (edit) =>
          edit.anchor.kind === "words" &&
          edit.anchor.first <= last &&
          first <= edit.anchor.last
      );
      if (row.edited) {
        assert.deepEqual(row.anchor, covering?.anchor);
        continue;
      }
      assert.equal(
        covering,
        undefined,
        "an unpinned row covers no pinned word"
      );
      const text = whisper
        .slice(first, last + 1)
        .filter((_, offset) => kept(first + offset))
        .map((word) => word.text)
        .join(" ");
      assert.equal(row.lines.join(" "), text);
    }
  }
});

test("a pinned run whose words all fall outside the trim still splits the rows around it", () => {
  const spoken: Word[] = [
    { start: 1, end: 1.2, text: "one" },
    { start: 1.3, end: 1.5, text: "two" },
    { start: 9, end: 9.1, text: "glitch" },
    { start: 1.6, end: 1.8, text: "three" },
  ];
  const range = { start: 0, end: 5 };
  assert.deepEqual(
    rows(spoken, range, [pin(2, 2, ["pinned"])]).map((row) => [
      ...anchorOf(row),
      row.lines,
    ]),
    [
      [0, 1, ["one two"]],
      [3, 3, ["three"]],
    ]
  );
  assert.deepEqual(
    rows(spoken, range).map(anchorOf),
    [[0, 3]],
    "without the pin the glitch word stays inside one row, as today"
  );
});

test("trimming outward restores unedited speech around an edit, and the edit keeps its words", () => {
  const edit = pin(6, 8, ["Lazy dog!"]);
  const narrow = rows(words, { start: 11.8, end: 12.8 }, [edit]);
  assert.deepEqual(
    narrow.map((row) => row.lines),
    [["Lazy dog!"]]
  );
  const wide = rows(words, { start: 10, end: 30 }, [edit]);
  assert.equal(
    wide
      .filter((row) => !row.edited)
      .flatMap((row) => row.lines)
      .join(" "),
    sentence.replace("the lazy dog ", ""),
    "every unedited word is back, drafted as if never trimmed"
  );
  assert.deepEqual(wide.find((row) => row.edited)?.lines, ["Lazy dog!"]);
});

test("a retimed pin hides its words and shows at its own time, even when its words are outside the trim", () => {
  const retimed = pin(0, 1, ["Moved"], { start: 14, end: 15 });
  const laid = rows(words, { start: 13, end: 20 }, [retimed]);
  const row = laid.find((r) => r.edited);
  assert.deepEqual(row && [row.start, row.end, row.lines, row.heard], [
    14,
    15,
    ["Moved"],
    "the quick",
  ]);
  const back = rows(words, { start: 10, end: 20 }, [retimed]);
  assert.ok(
    !back.some((r) => !r.edited && r.lines.join(" ").startsWith("the quick")),
    "the anchored words never draft, wherever the trim is"
  );
  const clipped = rows(words, { start: 14.5, end: 20 }, [retimed]).find(
    (r) => r.edited
  );
  assert.deepEqual(clipped && [clipped.start, clipped.end], [14.5, 15]);
});

test("an added caption shows inside the trim, sorted by time, and the speech before it stops lingering at its start", () => {
  const spoken: Word[] = [
    { start: 1, end: 1.3, text: "hello" },
    { start: 3, end: 3.2, text: "world" },
  ];
  const cue = added("00000000-0000-4000-8000-000000000001", 1.5, 2.5, ["Note"]);
  const range = { start: 0, end: 5 };
  assert.deepEqual(
    rows(spoken, range, [cue]).map((row) => [row.start, row.end, row.lines]),
    [
      [1, 1.5, ["hello"]],
      [1.5, 2.5, ["Note"]],
      [3, 3.6, ["world"]],
    ]
  );
  assert.deepEqual(rows(spoken, { start: 2.6, end: 5 }, [cue]).length, 1);
});

test("segmentCues clamps to the rendered length and drops a row that rounds to nothing", () => {
  const laid: CaptionRow[] = [
    {
      start: 10,
      end: 10.004,
      anchor: { kind: "words", first: 0, last: 0 },
      lines: ["blink"],
      heard: "blink",
      edited: false,
    },
    {
      start: 11,
      end: 30,
      anchor: { kind: "words", first: 1, last: 1 },
      lines: ["a", "b", "c"],
      heard: "abc",
      edited: true,
    },
  ];
  assert.deepEqual(segmentCues(laid, { start: 10, end: 40 }, 12.34), [
    { startCs: 100, endCs: 1234, lines: ["a", "b c"] },
  ]);
});

test("editCaption pins an automatic row, retypes and retimes the pin in place, and restore drops only it", () => {
  const range = { start: 10, end: 30 };
  const first = rows(words, range)[0] as CaptionRow;
  const typed = editCaption([], first, {
    kind: "text",
    text: "One\ntwo\nthree",
  });
  assert.deepEqual(typed, [
    {
      anchor: { kind: "words", first: 0, last: 6 },
      timing: null,
      lines: ["One", "two three"],
    },
  ]);
  const other = pin(10, 11, ["later"]);
  const pinnedRow = rows(words, range, typed)[0] as CaptionRow;
  const retimed = editCaption([other, ...typed], pinnedRow, {
    kind: "timing",
    range: { start: 9, end: 11 },
  });
  assert.deepEqual(retimed, [
    {
      anchor: { kind: "words", first: 0, last: 6 },
      timing: { start: 9, end: 11 },
      lines: ["One", "two three"],
    },
    other,
  ]);
  assert.deepEqual(editCaption(retimed, pinnedRow, { kind: "restore" }), [
    other,
  ]);
});

test("editCaption keeps an added caption's id through text and timing changes, and restore removes it", () => {
  const id = "00000000-0000-4000-8000-000000000002";
  const cue = added(id, 12, 13, ["Hi"]);
  const row = rows(words, { start: 10, end: 30 }, [cue]).find(
    (r) => r.anchor.kind === "cue"
  ) as CaptionRow;
  const moved = editCaption([cue], row, {
    kind: "timing",
    range: { start: 20, end: 21 },
  });
  assert.deepEqual(moved, [added(id, 20, 21, ["Hi"])]);
  assert.deepEqual(editCaption([cue], row, { kind: "text", text: "Hey" }), [
    added(id, 12, 13, ["Hey"]),
  ]);
  assert.deepEqual(editCaption([cue], row, { kind: "restore" }), []);
});

test("captionStyle keeps the job render's look at 9:16 and its font size on every canvas", () => {
  assert.deepEqual(captionStyle("9:16"), {
    width: 720,
    height: 1280,
    font: "DejaVu Sans",
    size: 56,
    bold: true,
    outline: 4,
    marginX: 50,
    marginBottom: 300,
    cssEmScale: 0.86,
  });
  assert.deepEqual(
    [captionStyle("16:9"), captionStyle("1:1")].map((style) => [
      style.width,
      style.height,
      style.size,
      style.marginBottom,
    ]),
    [
      [1280, 720, 56, 169],
      [720, 720, 56, 169],
    ]
  );
});
