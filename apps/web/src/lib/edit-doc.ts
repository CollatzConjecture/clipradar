import {
  type Capability,
  type CaptionAnchor,
  capabilitiesFor,
  type DeliveryStage,
  type EditDraft,
  parseDocument,
  type Segment,
} from "@clipradar/db/editor";

export type Selection =
  | { type: "segment"; id: string }
  | { type: "caption"; segmentId: string; anchor: CaptionAnchor };

export interface History {
  future: readonly EditDraft[];
  mark: { at: number; key: string } | null;
  past: readonly EditDraft[];
  present: EditDraft;
}

const MAX_STEPS = 40;
const MERGE_MS = 450;

export const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));
export const rounded = (value: number) => Math.round(value * 100) / 100;

export const open = (present: EditDraft): History => ({
  past: [],
  present,
  future: [],
  mark: null,
});

export const sameDoc = (a: EditDraft, b: EditDraft) =>
  JSON.stringify(a) === JSON.stringify(b);

export function change(
  history: History,
  next: EditDraft,
  key: string | null,
  now: number
): History {
  if (sameDoc(next, history.present)) {
    return history;
  }
  const merge =
    key !== null &&
    history.mark?.key === key &&
    now - history.mark.at < MERGE_MS;
  return {
    past: merge
      ? history.past
      : [...history.past, history.present].slice(-MAX_STEPS),
    present: next,
    future: [],
    mark: key === null ? null : { key, at: now },
  };
}

export function undo(history: History): History {
  const previous = history.past.at(-1);
  if (!previous) {
    return history;
  }
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    mark: null,
  };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) {
    return history;
  }
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    mark: null,
  };
}

export const updateSegment = (
  doc: EditDraft,
  id: string,
  patch: Partial<Omit<Segment, "id">>
): EditDraft => ({
  ...doc,
  segments: doc.segments.map((segment) =>
    segment.id === id ? { ...segment, ...patch } : segment
  ),
});

export const anchorKey = (anchor: CaptionAnchor) =>
  anchor.kind === "words"
    ? `words:${anchor.first}-${anchor.last}`
    : `cue:${anchor.id}`;

/**
 * crypto.randomUUID only exists in secure contexts, and a self-hosted
 * install is often reached over plain http on the LAN.
 */
export function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = 0x40 + ((bytes[6] ?? 0) % 16);
  bytes[8] = 0x80 + ((bytes[8] ?? 0) % 64);
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const STAGES = [1, 2, 3, 4] as const satisfies readonly DeliveryStage[];

export const stageFor = (capability: Capability): DeliveryStage =>
  STAGES.find((stage) =>
    capabilitiesFor(stage, true).enabled.includes(capability)
  ) ?? 4;

export interface DraftOwner {
  clipId: string;
  jobId: string;
  userId: string;
}

export interface Draft {
  doc: EditDraft;
  touched: number;
}

type DraftStorage = Pick<Storage, "getItem" | "key" | "length" | "removeItem">;

const KEPT_DRAFTS = 5;

const draftPrefix = ({ userId, jobId, clipId }: DraftOwner) =>
  `clipradar:draft:v2:${userId}:${jobId}:${clipId}:`;

export const draftKey = (owner: DraftOwner, actor: string) =>
  `${draftPrefix(owner)}${actor}`;

function readDraft(raw: string | null): Draft | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (
      typeof value !== "object" ||
      value === null ||
      !("touched" in value) ||
      typeof value.touched !== "number" ||
      !("doc" in value)
    ) {
      return null;
    }
    return { touched: value.touched, doc: parseDocument(value.doc) };
  } catch {
    return null;
  }
}

export function newestDraft(
  storage: DraftStorage,
  owner: DraftOwner
): Draft | null {
  const prefix = draftPrefix(owner);
  const found: { key: string; draft: Draft | null }[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) {
      found.push({ key, draft: readDraft(storage.getItem(key)) });
    }
  }
  found.sort((a, b) => (b.draft?.touched ?? -1) - (a.draft?.touched ?? -1));
  // ponytail: keeps the newest few entries even if their tabs are closed; a per-tab heartbeat would let it keep exactly the open ones.
  for (const [index, { key, draft }] of found.entries()) {
    if (draft === null || index >= KEPT_DRAFTS) {
      storage.removeItem(key);
    }
  }
  return found[0]?.draft ?? null;
}
