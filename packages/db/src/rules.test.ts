import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanLines, lineFits } from "./rules";

test("cleanLines cleans typed lines, drops empty ones, and turns ASS override characters into look-alikes", () => {
  assert.deepEqual(cleanLines(["  Kubernetes\tis ", "the  hard\npart"]), [
    "Kubernetes is",
    "the hard part",
  ]);
  assert.deepEqual(cleanLines([" ", ""]), [], "an emptied caption hides it");
  assert.deepEqual(cleanLines(["{\\b1}bold\\N"]), ["｛＼b1｝bold＼N"]);
});

test("a caption line fits 18 units, or is one word too long for any line", () => {
  assert.equal(lineFits("eighteen chars ok!"), true);
  assert.equal(lineFits("nineteen chars, no!"), false);
  assert.equal(lineFits("supercalifragilisticexpialidocious"), true);
  assert.equal(lineFits("你好你好你好你好你"), true);
  assert.equal(lineFits("你好你好你好你好你好"), false);
  assert.equal(lineFits("สวัสดีครับสวัสดีครับสวัสดีครับ"), false);
});
