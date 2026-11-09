import type { JobStatus, JobSummary, Step } from "@clipradar/db/jobs";
import { Badge } from "@clipradar/ui/components/badge";
import { cn } from "@clipradar/ui/lib/utils";
import { Check, CircleAlert } from "lucide-react";

/** Key order is the run order. STEP_ORDER reads it. */
export const STEP_COPY: Record<Step, { name: string; detail: string }> = {
  queued: {
    name: "Queued",
    detail: "Your video is uploaded. It starts as soon as a worker is free.",
  },
  transcribing: {
    name: "Transcribing",
    detail: "Turning speech into timed words. Long videos take a while on CPU.",
  },
  selecting: {
    name: "Picking moments",
    detail: "The language model is scoring moments that stand on their own.",
  },
  rendering: {
    name: "Rendering clips",
    detail:
      "Cropping to 9:16 and burning in captions. Clips appear as each one finishes.",
  },
};

export const STEP_ORDER = Object.keys(STEP_COPY) as Step[];

type Tone = "live" | "quiet" | "neutral" | "negative";

const STATUS: Record<
  JobStatus,
  { tone: Tone; label: (job: JobSummary) => string }
> = {
  queued: { tone: "quiet", label: () => "Queued" },
  transcribing: { tone: "live", label: () => "Transcribing" },
  selecting: { tone: "live", label: () => "Picking moments" },
  rendering: {
    tone: "live",
    label: (job) => `Rendering ${job.readyCount}/${job.totalCount}`,
  },
  completed: { tone: "neutral", label: () => "Done" },
  partial: {
    tone: "neutral",
    label: (job) => `Partly done ${job.readyCount}/${job.totalCount}`,
  },
  failed: { tone: "negative", label: () => "Failed" },
};

const TONE: Record<Tone, string> = {
  live: "bg-secondary text-foreground",
  quiet: "bg-secondary text-muted-foreground",
  neutral: "bg-secondary text-foreground",
  negative: "bg-negative-tint text-negative",
};

export function StatusPill({
  job,
  className,
}: {
  job: JobSummary;
  className?: string;
}) {
  const { tone, label } = STATUS[job.status];
  return (
    <Badge
      className={cn(
        "tnum h-6 shrink-0 gap-1.5 rounded-full px-2.5 text-[12px]",
        TONE[tone],
        className
      )}
    >
      {tone === "live" && (
        <span aria-hidden className="bg-primary size-1.5 rounded-full" />
      )}
      {job.status === "completed" && <Check aria-hidden />}
      {tone === "negative" && <CircleAlert aria-hidden />}
      {label(job)}
    </Badge>
  );
}
