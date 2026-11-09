import type { ClipView, JobView, Step } from "@clipradar/db/jobs";
import { Button, buttonVariants } from "@clipradar/ui/components/button";
import { Kbd } from "@clipradar/ui/components/kbd";
import { Slider } from "@clipradar/ui/components/slider";
import { cn } from "@clipradar/ui/lib/utils";
import {
  CircleAlert,
  Download,
  Pause,
  Pencil,
  Play,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useCallback,
  useState,
} from "react";

import { clipDownload, clipSrc } from "@/components/clips";
import { STEP_COPY, STEP_ORDER } from "@/components/job-status";
import { score, timecode } from "@/lib/format";

const CODE = /(?<code>[A-Z0-9]+_[A-Z0-9_]+|\.env\b|`[^`]+`)/u;

/** Sets env var names, `.env`, and backticked commands in an error as code. */
export function ErrorText({ text }: { text: string }) {
  return text.split(CODE).map((part, i) =>
    i % 2 === 1 ? (
      <code
        className="bg-accent text-accent-foreground rounded-md px-1 font-mono text-[0.9em]"
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder.
        key={i}
      >
        {part.replaceAll("`", "")}
      </code>
    ) : (
      part
    )
  );
}

export function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-faint text-[12px]">{label}</dt>
      <dd className="tnum mt-0.5 truncate text-[13px]">{children}</dd>
    </div>
  );
}

export function stoppedAt(job: JobView): Step | undefined {
  return STEP_ORDER.find((step) => job.steps[step] === "failed");
}

export function retryLabel(job: JobView): string {
  const failed = job.clips.filter((clip) => clip.status === "failed").length;
  if (failed > 0) {
    return `Render ${failed} missing ${failed === 1 ? "clip" : "clips"}`;
  }
  const step = stoppedAt(job);
  return step ? `Retry from ${STEP_COPY[step].name.toLowerCase()}` : "Retry";
}

function togglePlay(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  if (video.paused) {
    video.play().catch(() => undefined);
  } else {
    video.pause();
  }
}

export interface Retry {
  pending: boolean;
  run: () => void;
}

export function Viewer({
  job,
  clip,
  videoRef,
  retry,
  onEdit,
}: {
  job: JobView;
  clip: ClipView | undefined;
  videoRef: RefObject<HTMLVideoElement | null>;
  retry: Retry;
  onEdit: (clipId: string) => void;
}) {
  return (
    <section
      aria-label="Viewer"
      className="bg-viewer flex min-h-0 flex-col lg:flex-row"
    >
      <div
        className="relative h-[min(56svh,480px)] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1"
        style={{ containerType: "size" }}
      >
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          {clip ? (
            <Stage
              clip={clip}
              key={clip.id}
              rendering={clip.id === job.renderingClipId}
              videoRef={videoRef}
            />
          ) : (
            <EmptyStage job={job} retry={retry} />
          )}
        </div>
      </div>
      {clip ? (
        <Inspector clip={clip} job={job} onEdit={onEdit} retry={retry} />
      ) : null}
    </section>
  );
}

const FRAME_HEIGHT = "min(100cqh - 72px, (100cqw - 32px) * 16 / 9)";

function Stage({
  clip,
  rendering,
  videoRef,
}: {
  clip: ClipView;
  rendering: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const ready = clip.status === "ready";
  const toggle = useCallback(() => togglePlay(videoRef.current), [videoRef]);
  const sync = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    setPlaying(!event.currentTarget.paused);
    setTime(event.currentTarget.currentTime);
  }, []);
  const seek = useCallback(
    (value: number | readonly number[]) => {
      if (videoRef.current && typeof value === "number") {
        videoRef.current.currentTime = value;
      }
    },
    [videoRef]
  );
  return (
    <>
      <div
        className="bg-background relative aspect-[9/16] overflow-hidden rounded-xl"
        style={{ height: FRAME_HEIGHT }}
      >
        {ready ? (
          // biome-ignore lint/a11y/useMediaCaption: captions are burned into the video frames.
          <video
            aria-label={`Clip ${clip.rank}, ${clip.title}`}
            className="size-full object-contain"
            onClick={toggle}
            onEnded={sync}
            onPause={sync}
            onPlay={sync}
            onTimeUpdate={sync}
            playsInline
            preload="metadata"
            ref={videoRef}
            src={clipSrc(clip.id)}
          />
        ) : (
          <Slate clip={clip} rendering={rendering} />
        )}
      </div>
      <div
        className="flex items-center gap-2.5"
        style={{ width: `calc(${FRAME_HEIGHT} * 9 / 16)` }}
      >
        <Button
          aria-label={playing ? "Pause" : "Play"}
          disabled={!ready}
          onClick={toggle}
          size="icon-sm"
          variant="secondary"
        >
          {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        </Button>
        <span className="tnum text-muted-foreground text-[12px]">
          {timecode(time)}
        </span>
        <Slider
          className="flex-1"
          disabled={!ready}
          max={clip.durationSeconds}
          onValueChange={seek}
          step={0.1}
          thumbLabel="Playback position"
          value={time}
        />
        <span className="tnum text-muted-foreground text-[12px]">
          {timecode(Math.round(clip.durationSeconds))}
        </span>
      </div>
    </>
  );
}

function Slate({ clip, rendering }: { clip: ClipView; rendering: boolean }) {
  const failed = clip.status === "failed";
  let title = "Waiting to render";
  let detail = "Clips render one at a time, best first.";
  if (failed) {
    title = "Render failed";
    detail = "A retry renders only the missing clips.";
  } else if (rendering) {
    title = "Rendering now";
    detail = "It plays here as soon as it finishes.";
  }
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center",
        failed ? "hatch-negative" : "hatch"
      )}
    >
      <span className="bg-viewer rounded-lg px-3 py-2">
        <span
          className={cn(
            "block text-[13px] font-semibold",
            failed && "text-negative",
            rendering && "text-primary-text"
          )}
        >
          {title}
        </span>
        <span className="text-muted-foreground mt-1 block max-w-48 text-[12px]">
          {detail}
        </span>
      </span>
    </div>
  );
}

function EmptyStage({ job, retry }: { job: JobView; retry: Retry }) {
  const step = stoppedAt(job);
  if (!step) {
    const running = STEP_ORDER.find((s) => job.steps[s] === "running");
    const copy = STEP_COPY[running ?? "queued"];
    return (
      <div className="max-w-80 px-6 text-center">
        <p className="text-[15px] font-semibold">{copy.name}</p>
        <p className="text-muted-foreground mt-1.5 text-[13px]">
          {copy.detail}
        </p>
      </div>
    );
  }
  return (
    <div className="w-full max-w-[460px] px-6">
      <p className="text-negative flex items-center gap-2 text-[13px] font-medium">
        <CircleAlert aria-hidden className="size-4" />
        Stopped at {STEP_COPY[step].name.toLowerCase()}
      </p>
      <p className="mt-3 text-[20px] leading-snug font-semibold tracking-[-0.01em] text-balance break-words">
        <ErrorText text={job.error ?? "The job stopped without a message."} />
      </p>
      <p className="text-muted-foreground mt-3 text-[13px]">
        Retry picks up where the job stopped. Finished steps are kept.
      </p>
      {job.canRetry ? (
        <Button
          className="mt-6"
          disabled={retry.pending}
          onClick={retry.run}
          size="lg"
        >
          <RotateCcw aria-hidden />
          {retry.pending ? "Retrying…" : retryLabel(job)}
        </Button>
      ) : null}
    </div>
  );
}

function Inspector({
  job,
  clip,
  retry,
  onEdit,
}: {
  job: JobView;
  clip: ClipView;
  retry: Retry;
  onEdit: (clipId: string) => void;
}) {
  const rendering = clip.id === job.renderingClipId;
  const edit = useCallback(() => onEdit(clip.id), [onEdit, clip.id]);
  return (
    <aside
      aria-label="Selected clip"
      className="border-border flex shrink-0 flex-col gap-4 border-t p-4 lg:w-[300px] lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-faint text-[12px]">
          Rank {clip.rank} of {job.clips.length}
        </span>
        <span className="tnum">
          <span className="text-[28px] leading-none font-semibold tracking-[-0.02em]">
            {score(clip.score)}
          </span>
          <span className="text-faint text-[13px]"> /10</span>
        </span>
      </div>
      <h2 className="text-[17px] leading-snug font-semibold text-balance break-words">
        {clip.title}
      </h2>
      <p className="text-muted-foreground text-[13px] break-words">
        {clip.reason}
      </p>
      <dl className="border-border grid grid-cols-3 gap-3 border-y py-3">
        <Fact label="In">{timecode(clip.startSeconds)}</Fact>
        <Fact label="Out">
          {timecode(clip.startSeconds + clip.durationSeconds)}
        </Fact>
        <Fact label="Length">{Math.round(clip.durationSeconds)} s</Fact>
      </dl>
      {clip.status === "ready" && (
        <div className="flex gap-2">
          <Button
            className="flex-1"
            data-edit-clip
            onClick={edit}
            variant="secondary"
          >
            <Pencil aria-hidden />
            Edit clip
          </Button>
          <a
            className={buttonVariants({ className: "flex-1" })}
            download
            href={clipDownload(clip.id)}
          >
            <Download aria-hidden />
            Download
          </a>
        </div>
      )}
      {clip.status === "pending" && (
        <p className="text-muted-foreground text-[13px]">
          {rendering ? "Rendering now. " : "Waiting to render. "}
          Download opens when this clip finishes.
        </p>
      )}
      {clip.status === "failed" && (
        <div className="flex flex-col gap-3">
          <p className="bg-negative-tint text-negative rounded-lg px-3 py-2 text-[12px] break-words">
            <ErrorText text={clip.error ?? "This clip did not render."} />
          </p>
          {job.canRetry ? (
            <Button disabled={retry.pending} onClick={retry.run}>
              <RotateCcw aria-hidden />
              {retry.pending ? "Retrying…" : retryLabel(job)}
            </Button>
          ) : (
            <p className="text-muted-foreground text-[13px]">
              Retry opens when the job finishes.
            </p>
          )}
        </div>
      )}
      <p className="text-faint hidden text-[12px] lg:block">
        Press <Kbd className="bg-secondary text-foreground">?</Kbd> for keyboard
        shortcuts.
      </p>
    </aside>
  );
}
