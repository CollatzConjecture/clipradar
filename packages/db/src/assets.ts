import type { SourceFacts } from "./editor";

export type AssetOrigin =
  | { kind: "upload" }
  | {
      kind: "pexels";
      videoId: number;
      author: string;
      authorUrl: string;
      pageUrl: string;
    };
export type PendingOrigin =
  | { kind: "upload" }
  | { kind: "pexels"; videoId: number };
export type AssetFacts = Omit<
  Extract<SourceFacts, { ref: { kind: "asset" } }>,
  "ref"
> & { mime: string };
export type AssetView = { id: string; name: string } & (
  | {
      state: "receiving" | "checking";
      taskId: string | null;
      origin: PendingOrigin;
    }
  | {
      state: "ready";
      facts: AssetFacts;
      previewUrl: string;
      sizeBytes: number;
      origin: AssetOrigin;
    }
  | { state: "failed"; error: string; origin: PendingOrigin }
  | {
      state: "deleting" | "deleted";
      retainedBytes: number;
      facts: AssetFacts | null;
      origin: PendingOrigin | AssetOrigin;
    }
);
