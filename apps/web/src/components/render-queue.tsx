import type { JobView, Step, StepState } from "@clipradar/db/jobs";
import { Button } from "@clipradar/ui/components/button";
import { Progress } from "@clipradar/ui/components/progress";
import { cn } from "@clipradar/ui/lib/utils";
import { AlertTriangle, Check, CircleAlert, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { STEP_COPY, STEP_ORDER } from "@/components/job-status";
import { ErrorText, type Retry, retryLabel } from "@/components/viewer";

const STATE_ICON: Record<StepState, ReactNode> = {
  done: <Check aria-hidden className="text-muted-foreground size-4" />,
  running: (
    <span aria-hidden className="bg-primary mx-[5px] size-1.5 rounded-full" />
  ),
  waiting: (
    <span
      aria-hidden
      className="border-faint mx-1 size-2 rounded-full border"
    />
  ),
  failed: <CircleAlert aria-hidden className="text-negative size-4" />,
  partial: (
    <AlertTriangle aria-hidden className="text-muted-foreground size-4" />
  ),
};

const STATE_TEXT: Record<StepState, string> = {
  done: "Done",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
  partial: "Partly done",
};

const STATE_COLOR: Record<StepState, string> = {
  done: "text-faint",
  running: "text-primary-text",
  waiting: "text-faint",
  failed: "text-negative",
  partial: "text-muted-foreground",
};

function stateText(job: JobView, step: Step, state: StepState): string {
  if (step === "queued" && state === "running") {
    return "In line";
  }
  if (step === "rendering" && job.totalCount > 0) {
    const ready = `${job.readyCount} of ${job.totalCount}`;
    if (state === "running") {
      return ready;
    }
    if (state === "partial") {
      return `${ready}, ${job.totalCount - job.readyCount} failed`;
    }
  }
  return STATE_TEXT[state];
}

function summary(job: JobView): string {
  if (job.status === "completed") {
    return "All steps done";
  }
  if (job.status === "failed") {
    return "Stopped";
  }
  if (job.status === "partial") {
    const failed = job.totalCount - job.readyCount;
    return `${failed} ${failed === 1 ? "clip" : "clips"} failed`;
  }
  const index = STEP_ORDER.findIndex((step) => job.steps[step] === "running");
  return `Step ${index + 1} of ${STEP_ORDER.length}`;
}

export function RenderQueue({ job, retry }: { job: JobView; retry: Retry }) {
  return (
    <section aria-labelledby="queue-heading" className="shrink-0 border-b">
      <div className="flex h-10 items-center justify-between px-4">
        <h2 className="text-[13px] font-semibold" id="queue-heading">
          Render queue
        </h2>
        <span aria-live="polite" className="tnum text-faint text-[12px]">
          {summary(job)}
        </span>
      </div>
      <ol className="pb-2">
        {STEP_ORDER.map((step) => {
          const state = job.steps[step];
          const live = state === "running";
          const stopped = state === "failed" || state === "partial";
          return (
            <li
              aria-current={live ? "step" : undefined}
              className={cn(
                "mx-2 rounded-lg px-2",
                (live || stopped) && "bg-card ring-border py-1 ring-1"
              )}
              key={step}
            >
              <div className="flex h-8 items-center gap-3">
                <span className="flex w-4 justify-center">
                  {STATE_ICON[state]}
                </span>
                <span
                  className={cn(
                    "flex-1 text-[13px]",
                    state === "waiting" ? "text-faint" : "text-foreground",
                    live && "font-semibold"
                  )}
                >
                  {STEP_COPY[step].name}
                </span>
                <span className={cn("tnum text-[12px]", STATE_COLOR[state])}>
                  {stateText(job, step, state)}
                </span>
              </div>
              {live && (
                <div className="pb-2.5 pl-7">
                  <Progress
                    aria-label={`${STEP_COPY[step].name} progress`}
                    className="render-live"
                    value={
                      step === "rendering" && job.totalCount > 0
                        ? (job.readyCount / job.totalCount) * 100
                        : null
                    }
                  />
                  <p className="text-muted-foreground mt-2 text-[12px]">
                    {STEP_COPY[step].detail}
                  </p>
                </div>
              )}
              {state === "failed" && (
                <p className="text-muted-foreground truncate pb-2.5 pl-7 text-[12px]">
                  <ErrorText
                    text={job.error ?? "No clip finished rendering."}
                  />
                </p>
              )}
              {state === "partial" && (
                <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 pl-7">
                  <p className="text-muted-foreground text-[12px]">
                    The ready clips are kept. A retry renders only the missing
                    ones.
                  </p>
                  {job.canRetry ? (
                    <Button
                      disabled={retry.pending}
                      onClick={retry.run}
                      size="sm"
                      variant="secondary"
                    >
                      <RotateCcw aria-hidden />
                      {retry.pending ? "Retrying…" : retryLabel(job)}
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
