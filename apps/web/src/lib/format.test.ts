import assert from "node:assert/strict";
import { test } from "node:test";

import { rulerStep, startedAgo, tenths, timecode } from "./format";

test("timecodes switch to hours past an hour", () => {
  assert.equal(timecode(0), "0:00");
  assert.equal(timecode(41.9), "0:41");
  assert.equal(timecode(2892), "48:12");
  assert.equal(timecode(10_812), "3:00:12");
});

test("trim points read to the tenth of a second", () => {
  assert.equal(tenths(0), "0:00.0");
  assert.equal(tenths(723.44), "12:03.4");
  assert.equal(tenths(59.96), "1:00.0");
  assert.equal(tenths(3600.3), "1:00:00.3");
});

test("rulers land on round steps with at most seven ticks", () => {
  assert.equal(rulerStep(92), 15);
  assert.equal(rulerStep(2892), 600);
  assert.equal(rulerStep(10_812), 1800);
  assert.equal(rulerStep(100_000), 14_400);
});

test("start times read as how long ago, then as a date", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  const ago = (seconds: number) =>
    startedAgo(new Date(now - seconds * 1000).toISOString(), now);
  assert.equal(ago(10), "Just now");
  assert.equal(ago(120), "2 minutes ago");
  assert.equal(ago(3600), "1 hour ago");
  assert.equal(ago(86_400), "Yesterday");
  assert.equal(ago(2 * 86_400), "2 days ago");
  assert.equal(ago(30 * 86_400), "Oct 9, 2026");
});
