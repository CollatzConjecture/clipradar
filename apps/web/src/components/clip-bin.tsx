import type { ClipView, JobView } from "@clipradar/db/jobs";
import { buttonVariants } from "@clipradar/ui/components/button";
import { cn } from "@clipradar/ui/lib/utils";
import { Download } from "lucide-react";
import { useCallback } from "react";

import { ClipThumb, clipDownload } from "@/components/clips";
import { score, timecode } from "@/lib/format";

const COLUMNS =
  "grid-cols-[18px_28px_minmax(0,1fr)_auto] sm:grid-cols-[18px_28px_minmax(0,1fr)_40px_52px_44px_32px]";

export const clipRowId = (clipId: string) => `clip-row-${clipId}`;

function subline(clip: ClipView, rendering: boolean): string {
  if (clip.status === "failed") {
    return `Failed. ${clip.error ?? "This clip did not render."}`;
  }
  if (clip.status === "pending") {
    return rendering ? "Rendering now" : "Waiting to render";
  }
  return clip.reason;
}

export function ClipBin({
  job,
  selectedId,
  onSelect,
}: {
  job: JobView;
  selectedId: string | undefined;
  onSelect: (clipId: string) => void;
}) {
  const hasClips = job.clips.length > 0;
  let empty = "Ranked clips land here as they render.";
  if (job.status === "failed") {
    empty = "No clips. The job stopped before picking moments.";
  }
  return (
    <section
      aria-labelledby="bin-heading"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-4">
        <h2 className="text-[13px] font-semibold" id="bin-heading">
          Clips
        </h2>
        <span className="tnum text-faint text-[12px]">
          {hasClips
            ? `${job.readyCount} of ${job.totalCount} ready, ranked by score`
            : "None yet"}
        </span>
      </div>
      {hasClips ? (
        <>
          <div
            aria-hidden
            className={cn(
              "text-faint hidden gap-3 px-4 pb-1 text-[12px] sm:grid",
              COLUMNS
            )}
          >
            <span className="text-right">#</span>
            <span />
            <span>Title</span>
            <span className="text-right">Score</span>
            <span className="text-right">In</span>
            <span className="text-right">Length</span>
            <span />
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto pb-2">
            {job.clips.map((clip) => (
              <ClipRow
                clip={clip}
                key={clip.id}
                onSelect={onSelect}
                rendering={clip.id === job.renderingClipId}
                selected={clip.id === selectedId}
              />
            ))}
          </ol>
        </>
      ) : (
        <p className="border-input text-muted-foreground mx-4 mb-4 rounded-lg border border-dashed px-3 py-3 text-[13px]">
          {empty}
        </p>
      )}
    </section>
  );
}

function ClipRow({
  clip,
  selected,
  rendering,
  onSelect,
}: {
  clip: ClipView;
  selected: boolean;
  rendering: boolean;
  onSelect: (clipId: string) => void;
}) {
  const select = useCallback(() => onSelect(clip.id), [onSelect, clip.id]);
  return (
    <li className="relative px-2">
      <button
        aria-pressed={selected}
        className={cn(
          "hover:bg-card grid w-full scroll-my-2 items-center gap-3 rounded-lg px-2 py-2 text-left",
          COLUMNS,
          selected && "bg-muted hover:bg-muted"
        )}
        data-clip-row
        id={clipRowId(clip.id)}
        onClick={select}
        type="button"
      >
        <span
          className={cn(
            "tnum text-right text-[12px]",
            selected ? "text-foreground" : "text-faint"
          )}
        >
          {clip.rank}
        </span>
        <ClipThumb clip={clip} selected={selected} />
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate text-[13px]",
              clip.status === "pending"
                ? "text-muted-foreground"
                : "text-foreground",
              selected && "font-medium"
            )}
          >
            {clip.title}
          </span>
          <span
            className={cn(
              "text-faint mt-1 block truncate text-[12px]",
              clip.status === "failed" && "text-negative",
              rendering && "text-primary-text"
            )}
          >
            {subline(clip, rendering)}
          </span>
        </span>
        <span className="tnum text-right text-[13px]">{score(clip.score)}</span>
        <span className="tnum text-muted-foreground hidden text-right text-[12px] sm:block">
          {timecode(clip.startSeconds)}
        </span>
        <span className="tnum text-muted-foreground hidden text-right text-[12px] sm:block">
          {Math.round(clip.durationSeconds)} s
        </span>
      </button>
      {clip.status === "ready" && (
        <a
          aria-label={`Download clip ${clip.rank}`}
          className={cn(
            buttonVariants({ size: "icon-sm", variant: "ghost" }),
            "text-muted-foreground absolute top-1/2 right-3 hidden -translate-y-1/2 sm:inline-flex"
          )}
          download
          href={clipDownload(clip.id)}
        >
          <Download aria-hidden />
        </a>
      )}
    </li>
  );
}
