import { expect, test } from "bun:test";

import type { Moment, Segment } from "@clipradar/db/jobs";

import { captionAss } from "./render";
import { parseMoments, pickMoments, windows } from "./select";

const segments: Segment[] = Array.from({ length: 10 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: `line ${i}`,
  words: [{ start: i * 5, end: i * 5 + 1, text: `line${i}` }],
}));
const all = { from: 0, to: 9 };

const answer = (...clips: unknown[]) => JSON.stringify({ clips });
const good = {
  first: 0,
  last: 3,
  title: " Hook ",
  reason: "Complete idea",
  score: 8.26,
};

test("parseMoments maps indices to segment times, trims text, and rounds the score", () => {
  expect(parseMoments(answer(good), segments, all)).toEqual([
    {
      startSeconds: 0,
      endSeconds: 20,
      title: "Hook",
      reason: "Complete idea",
      score: 8.3,
    },
  ]);
});

test("parseMoments drops a clip whose score is missing or out of range, never defaulting it", () => {
  const { score: _, ...noScore } = good;
  const bad = [
    noScore,
    { ...good, score: 11 },
    { ...good, score: -1 },
    { ...good, score: "9" },
  ];
  expect(parseMoments(answer(...bad, good), segments, all)).toHaveLength(1);
  expect(parseMoments(answer(...bad), segments, all)).toEqual([]);
});

test("parseMoments drops spans outside 15 to 60 seconds, reversed spans, and indices outside the window", () => {
  const tooShort = { ...good, last: 1 };
  const reversed = { ...good, first: 3, last: 0 };
  const outside = { ...good, first: 2, last: 6 };
  const pastEnd = { ...good, first: 8, last: 12 };
  expect(
    parseMoments(answer(tooShort, reversed, outside, pastEnd), segments, {
      from: 0,
      to: 5,
    })
  ).toEqual([]);
});

test("parseMoments tolerates a reasoning preamble and code fences but throws on a non-JSON answer", () => {
  const wrapped = `<think>maybe {first: 1}?</think>\n\`\`\`json\n${answer(good)}\n\`\`\``;
  expect(parseMoments(wrapped, segments, all)).toHaveLength(1);
  expect(() =>
    parseMoments("I cannot help with that.", segments, all)
  ).toThrow();
  expect(() => parseMoments('{"moments": []}', segments, all)).toThrow();
});

test("pickMoments ranks by score, drops near-duplicates, and stops at the count", () => {
  const m = (start: number, end: number, score: number): Moment => ({
    startSeconds: start,
    endSeconds: end,
    title: "t",
    reason: "r",
    score,
  });
  const candidates = [m(0, 30, 6), m(1, 31, 9), m(100, 130, 7), m(200, 230, 5)];
  expect(pickMoments(candidates, 2).map((x) => x.score)).toEqual([9, 7]);
  expect(pickMoments(candidates, 10).map((x) => x.score)).toEqual([9, 7, 5]);
});

test("windows cover every segment and overlap by the longest clip so no moment is cut in half", () => {
  const long: Segment[] = Array.from({ length: 200 }, (_, i) => ({
    start: i * 5,
    end: i * 5 + 5,
    text: "x".repeat(40),
    words: [],
  }));
  const parts = windows(long, 1000);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts[0]?.from).toBe(0);
  expect(parts.at(-1)?.to).toBe(199);
  for (const [i, part] of parts.entries()) {
    const next = parts[i + 1];
    if (next) {
      expect(next.from).toBeGreaterThan(part.from);
      expect(next.from).toBeLessThanOrEqual(part.to);
      const overlap = (long[part.to]?.end ?? 0) - (long[next.from]?.start ?? 0);
      expect(overlap).toBeGreaterThanOrEqual(60);
    }
  }
  expect(windows(segments, 60_000)).toEqual([all]);
});

test("captionAss neutralizes override tags and line breaks in spoken text", () => {
  const ass = captionAss(
    [{ startCs: 0, endCs: 150, lines: ["{\\b1}hi", "two\nthree"] }],
    "9:16"
  );
  expect(ass).toContain(
    "Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,｛＼b1｝hi\\Ntwo three\n"
  );
});

test("captionAss writes today's style header at 9:16, so job renders look the same", () => {
  expect(
    captionAss([{ startCs: 6123, endCs: 372_550, lines: ["你好"] }], "9:16")
  ).toBe(
    "[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 1280\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,DejaVu Sans,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,50,50,300,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:01.23,1:02:05.50,Default,,0,0,0,,你好\n"
  );
});
