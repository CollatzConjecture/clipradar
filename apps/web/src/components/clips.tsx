import type { ClipSpan, JobSummary } from "@clipradar/db/jobs";
import { cn } from "@clipradar/ui/lib/utils";
import { type MouseEvent, useCallback } from "react";

import { rulerStep, timecode } from "@/lib/format";

export const clipSrc = (clipId: string) => `/api/clips/${clipId}`;
export const clipDownload = (clipId: string) =>
  `/api/clips/${clipId}?download=1`;

/** Starts a download without leaving the page, even if the file is gone. */
function startDownload(href: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = "";
  link.click();
}

export const downloadClip = (clipId: string) =>
  startDownload(clipDownload(clipId));

export function ClipThumb({
  clip,
  selected = false,
  className,
}: {
  clip: ClipSpan;
  selected?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "bg-viewer relative block aspect-[9/16] w-7 shrink-0 overflow-hidden rounded-md outline-2 -outline-offset-2 outline-transparent",
        selected && "outline-primary",
        className
      )}
    >
      {clip.status === "ready" ? (
        // ponytail: one metadata request per thumb; have the worker write poster images if lists grow long.
        <video
          aria-hidden
          className="size-full object-cover"
          muted
          playsInline
          preload="metadata"
          src={`${clipSrc(clip.id)}#t=0.5`}
          tabIndex={-1}
        />
      ) : (
        <span
          className={cn(
            "absolute inset-0",
            clip.status === "failed" ? "hatch-negative" : "hatch"
          )}
        />
      )}
    </span>
  );
}

export function NotKnown() {
  return (
    <span className="text-faint text-[13px]">
      <span aria-hidden>—</span>
      <span className="sr-only">Not known yet</span>
    </span>
  );
}

const MOMENT_FILL: Record<ClipSpan["status"], string> = {
  ready: "bg-faint",
  pending: "bg-control",
  failed: "bg-negative",
};

const pct = (seconds: number, total: number) => `${(seconds / total) * 100}%`;

export function MomentMap({ job }: { job: JobSummary }) {
  const total = job.durationSeconds;
  if (!total) {
    return <NotKnown />;
  }
  return (
    <span
      aria-label={`${job.clips.length} moments across ${timecode(total)}`}
      className="bg-card relative block h-3.5 w-full rounded-full"
      role="img"
    >
      {job.clips.map((clip) => (
        <span
          className={cn(
            "absolute inset-y-0 min-w-[2px] rounded-full",
            MOMENT_FILL[clip.status]
          )}
          key={clip.id}
          style={{
            left: pct(clip.startSeconds, total),
            width: pct(clip.durationSeconds, total),
          }}
        />
      ))}
    </span>
  );
}

const BLOCK_FILL: Record<ClipSpan["status"], string> = {
  ready: "bg-faint hover:bg-muted-foreground",
  pending: "hatch bg-control hover:bg-faint",
  failed: "hatch-negative bg-negative-tint",
};

export function SourceTimeline({
  job,
  selectedId,
  onSelect,
}: {
  job: JobSummary;
  selectedId: string | undefined;
  onSelect: (clipId: string) => void;
}) {
  const pick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { clipId } = event.currentTarget.dataset;
      if (clipId) {
        onSelect(clipId);
      }
    },
    [onSelect]
  );
  const total = job.durationSeconds;
  const step = total ? rulerStep(total) : 0;
  const ticks = total
    ? Array.from(
        { length: Math.ceil(total / step) },
        (_, i) => i * step
      ).filter((t) => t < total - step / 2)
    : [];
  let empty = "Moments appear here after picking.";
  if (job.status === "failed") {
    empty = "No moments picked. The job stopped before picking finished.";
  }
  return (
    <section
      aria-labelledby="timeline-heading"
      className="shrink-0 border-t px-4 pt-2.5 pb-3"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-semibold" id="timeline-heading">
          Source
        </h2>
        <span className="tnum text-faint truncate text-[12px]">
          {total
            ? `${job.clips.length} ${job.clips.length === 1 ? "moment" : "moments"} picked from ${timecode(total)}`
            : "Length known after transcribing"}
        </span>
      </div>
      <div className="relative mt-1.5 h-[68px]">
        {ticks.map((t, i) => (
          <span
            aria-hidden
            className={cn(
              "tnum border-input text-faint absolute top-0 h-[22px] border-l pl-1 text-[11px] leading-none",
              i % 2 === 1 && "max-sm:hidden"
            )}
            key={t}
            style={{ left: pct(t, total ?? 1) }}
          >
            {timecode(t)}
          </span>
        ))}
        <div className="bg-card absolute inset-x-0 top-[18px] h-8 rounded-lg">
          {job.clips.length === 0 && (
            <span className="text-faint flex h-full items-center px-3 text-[12px]">
              {empty}
            </span>
          )}
          {total
            ? job.clips.map((clip) => (
                <button
                  aria-label={`Clip ${clip.rank}, ${timecode(clip.startSeconds)} to ${timecode(clip.startSeconds + clip.durationSeconds)}`}
                  aria-pressed={clip.id === selectedId}
                  className={cn(
                    "absolute inset-y-0 min-w-1 rounded-md",
                    BLOCK_FILL[clip.status],
                    clip.id === selectedId && "bg-primary hover:bg-primary"
                  )}
                  data-clip-id={clip.id}
                  key={clip.id}
                  onClick={pick}
                  style={{
                    left: pct(clip.startSeconds, total),
                    width: pct(clip.durationSeconds, total),
                  }}
                  type="button"
                />
              ))
            : null}
        </div>
        {total
          ? job.clips.map((clip) => (
              <span
                aria-hidden
                className={cn(
                  "tnum absolute top-[54px] -translate-x-1/2 text-[11px] leading-none",
                  clip.id === selectedId
                    ? "text-primary-text font-semibold"
                    : "text-faint"
                )}
                key={clip.id}
                style={{
                  left: pct(
                    clip.startSeconds + clip.durationSeconds / 2,
                    total
                  ),
                }}
              >
                {clip.rank}
              </span>
            ))
          : null}
      </div>
    </section>
  );
}
