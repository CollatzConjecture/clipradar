import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRange } from "./byte-range";

const SIZE = 1000;

test("serves the whole file when there is no usable single range", () => {
  for (const header of [null, "", "items=0-1", "bytes=-", "bytes=0-1,5-6"]) {
    assert.equal(parseRange(header, SIZE), null, String(header));
  }
});

test("reads open, closed, and suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=0-", SIZE), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=0-1", SIZE), { start: 0, end: 1 });
  assert.deepEqual(parseRange("bytes=900-5000", SIZE), {
    start: 900,
    end: 999,
  });
  assert.deepEqual(parseRange("bytes=-500", SIZE), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-5000", SIZE), { start: 0, end: 999 });
});

test("rejects ranges outside the file", () => {
  for (const header of ["bytes=1000-", "bytes=5-2", "bytes=-0"]) {
    assert.equal(parseRange(header, SIZE), "unsatisfiable", header);
  }
  assert.equal(parseRange("bytes=0-", 0), "unsatisfiable");
});
