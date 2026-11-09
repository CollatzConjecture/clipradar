import { expect, test } from "bun:test";

import { ORPHAN_AGE_MS, orphans, trashTarget } from "./sweep";

const now = Date.now();
const old = now - ORPHAN_AGE_MS - 1;
const refs = {
  jobIds: new Set(["job-1"]),
  clipIds: new Set(["clip-1"]),
  files: new Set(["clips/job-1/clip-1-2.mp4", "versions/clip-1/v-1.mp4"]),
};

test("an old file no row names, in a folder whose row exists, is an orphan", () => {
  expect(
    orphans(
      [
        { path: "clips/job-1/clip-1-1.mp4", mtimeMs: old },
        { path: "versions/clip-1/v-1-1.mp4", mtimeMs: old },
      ],
      refs,
      now
    )
  ).toEqual(["clips/job-1/clip-1-1.mp4", "versions/clip-1/v-1-1.mp4"]);
});

test("named, recent, or parentless files stay", () => {
  expect(
    orphans(
      [
        { path: "clips/job-1/clip-1-2.mp4", mtimeMs: old },
        { path: "versions/clip-1/v-1.mp4", mtimeMs: old },
        { path: "clips/job-1/just-renamed.mp4", mtimeMs: now - 1000 },
        { path: "clips/unknown-job/clip.mp4", mtimeMs: old },
        { path: "versions/unknown-clip/v.mp4", mtimeMs: old },
        { path: "sources/upload", mtimeMs: old },
      ],
      refs,
      now
    )
  ).toEqual([]);
});

test("trashed paths resolve only inside a media folder", () => {
  expect(trashTarget("/data", "clips/job-1")).toBe("/data/clips/job-1");
  expect(trashTarget("/data", "sources/upload")).toBe("/data/sources/upload");
  expect(trashTarget("/data", "clips")).toBeNull();
  expect(trashTarget("/data", "scratch/x")).toBeNull();
  expect(trashTarget("/data", "../etc/passwd")).toBeNull();
  expect(trashTarget("/data", "/etc/passwd")).toBeNull();
  expect(trashTarget("/data", "clips/../../etc")).toBeNull();
});
