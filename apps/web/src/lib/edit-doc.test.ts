import assert from "node:assert/strict";
import { test } from "node:test";

import { capabilitiesFor, type EditDraft } from "@clipradar/db/editor";

import {
  change,
  draftKey,
  type History,
  newestDraft,
  open,
  redo,
  stageFor,
  undo,
  updateSegment,
  uuid,
} from "./edit-doc";

const SEGMENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORIGINAL: EditDraft = {
  version: 2,
  name: "A useful moment",
  segments: [
    {
      id: SEGMENT_ID,
      source: { kind: "job" },
      start: 42,
      end: 62,
      cropX: 0.5,
      cropY: 0.5,
      volume: 1,
      transition: { kind: "cut" },
      captions: [],
    },
  ],
  aspectRatio: "9:16",
  fps: 30,
  quality: "high",
  captionsEnabled: true,
  texts: [],
  images: [],
  audio: null,
  effect: null,
  watermark: null,
};

const trimmed = (end: number) => updateSegment(ORIGINAL, SEGMENT_ID, { end });

function steps(
  edits: { doc: EditDraft; key: string | null; at: number }[]
): History {
  return edits.reduce(
    (history, { doc, key, at }) => change(history, doc, key, at),
    open(ORIGINAL)
  );
}

test("a burst on one target is one undo step, another target starts a new one", () => {
  const history = steps([
    { doc: trimmed(61), key: "trim", at: 0 },
    { doc: trimmed(60), key: "trim", at: 200 },
    { doc: trimmed(59), key: "trim", at: 400 },
    { doc: { ...trimmed(59), name: "Renamed" }, key: "name", at: 500 },
  ]);
  assert.equal(history.past.length, 2);
  assert.equal(undo(history).present.name, "A useful moment");
  assert.equal(undo(undo(history)).present, ORIGINAL);
});

test("the same target after a pause is a new undo step", () => {
  const history = steps([
    { doc: trimmed(61), key: "trim", at: 0 },
    { doc: trimmed(60), key: "trim", at: 1000 },
  ]);
  assert.equal(history.past.length, 2);
});

test("undo and redo walk the steps and a new edit drops the redo branch", () => {
  const history = steps([
    { doc: trimmed(61), key: null, at: 0 },
    { doc: trimmed(60), key: null, at: 1 },
  ]);
  const back = undo(history);
  assert.equal(back.present.segments[0]?.end, 61);
  assert.equal(redo(back).present.segments[0]?.end, 60);
  const branched = change(back, trimmed(50), null, 2);
  assert.equal(branched.future.length, 0);
  assert.equal(redo(branched), branched);
});

test("an edit that changes nothing is not a step, and history keeps 40", () => {
  const same = change(open(ORIGINAL), structuredClone(ORIGINAL), null, 0);
  assert.equal(same.past.length, 0);
  const many = steps(
    Array.from({ length: 50 }, (_, i) => ({
      doc: trimmed(61 - i * 0.1),
      key: null,
      at: i,
    }))
  );
  assert.equal(many.past.length, 40);
});

function memoryStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

test("reopening restores the most recently edited valid draft from any tab", () => {
  const owner = { userId: "u", jobId: "j", clipId: "c" };
  const storage = memoryStorage({
    [draftKey(owner, "old")]: JSON.stringify({ touched: 1, doc: trimmed(61) }),
    [draftKey(owner, "new")]: JSON.stringify({ touched: 3, doc: trimmed(55) }),
    [draftKey(owner, "corrupt")]: "{not json",
    [draftKey(owner, "invalid")]: JSON.stringify({
      touched: 9,
      doc: { version: 1 },
    }),
    [draftKey({ ...owner, clipId: "other" }, "x")]: JSON.stringify({
      touched: 99,
      doc: trimmed(44),
    }),
  });
  const draft = newestDraft(storage, owner);
  assert.equal(draft?.touched, 3);
  assert.equal(draft?.doc.segments[0]?.end, 55);
  assert.equal(storage.map.has(draftKey(owner, "corrupt")), false);
  assert.equal(storage.map.has(draftKey(owner, "invalid")), false);
  assert.equal(storage.length, 3);
});

test("old drafts beyond the newest five are dropped", () => {
  const owner = { userId: "u", jobId: "j", clipId: "c" };
  const storage = memoryStorage(
    Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [
        draftKey(owner, `tab${i}`),
        JSON.stringify({ touched: i, doc: ORIGINAL }),
      ])
    )
  );
  assert.equal(newestDraft(storage, owner)?.touched, 7);
  assert.equal(storage.length, 5);
  assert.equal(storage.map.has(draftKey(owner, "tab2")), false);
});

test("a capability's stage comes from the server's own policy", () => {
  for (const stage of [1, 2, 3, 4] as const) {
    for (const capability of capabilitiesFor(stage, false).enabled) {
      assert.ok(stageFor(capability) <= stage);
    }
  }
  assert.equal(stageFor("trim"), 1);
  assert.equal(stageFor("captions"), 1);
  assert.equal(stageFor("timeline"), 2);
});

test("request ids are version 4 UUIDs without a secure context", () => {
  assert.match(uuid(), UUID_V4);
});
