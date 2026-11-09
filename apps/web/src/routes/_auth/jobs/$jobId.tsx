import type { ClipView, JobView } from "@clipradar/db/jobs";
import { buttonVariants } from "@clipradar/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@clipradar/ui/components/empty";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";

import { ClipBin, clipRowId } from "@/components/clip-bin";
import { downloadClip, SourceTimeline } from "@/components/clips";
import { DeleteJob } from "@/components/delete-job";
import { AiClipEditor } from "@/components/editor/ai-clip-editor";
import { StatusPill } from "@/components/job-status";
import Loader from "@/components/loader";
import { RenderQueue } from "@/components/render-queue";
import { Fact, type Retry, Viewer } from "@/components/viewer";
import { startedAgo, timecode } from "@/lib/format";
import { languageName } from "@/lib/language";
import { useShortcuts } from "@/lib/shortcuts";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/jobs/$jobId")({
  validateSearch: z.object({ edit: z.uuid().optional().catch(undefined) }),
  component: JobPage,
});

const POLL_MS = 2000;
const MAX_LOAD_RETRIES = 3;
const HTTP_SERVER_ERROR = 500;

function JobPage() {
  const { jobId } = Route.useParams();
  const { edit } = Route.useSearch();
  const { session } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  // Lives above the editor so closing it lands back on the clip that was edited.
  const [pickedId, setPickedId] = useState(edit);
  const closeEditor = useCallback(async () => {
    await navigate({ search: {} });
    document.querySelector<HTMLElement>("[data-edit-clip]")?.focus();
  }, [navigate]);
  const openEditor = useCallback(
    (clipId: string) => {
      setPickedId(clipId);
      navigate({ search: { edit: clipId } });
    },
    [navigate]
  );
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const options = trpc.jobs.get.queryOptions(
    { id: jobId },
    {
      refetchInterval: (query) => (query.state.data?.active ? POLL_MS : false),
      retry: (failures, loadError) =>
        !isClientError(loadError.data?.httpStatus) &&
        failures < MAX_LOAD_RETRIES,
    }
  );
  const { data, error } = useQuery(options);
  const retry = useMutation(
    trpc.jobs.retry.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(options.queryKey, next);
        await queryClient.invalidateQueries({
          queryKey: trpc.jobs.list.queryKey(),
        });
      },
      onError: (retryError) =>
        toast.error("Couldn't retry this job.", {
          description: retryError.message,
        }),
    })
  );

  if (!data) {
    if (!error) {
      return <Loader />;
    }
    return isClientError(error.data?.httpStatus) ? (
      <LoadProblem
        description="This job doesn't exist, or it belongs to another account."
        title="Job not found"
      />
    ) : (
      <LoadProblem description={error.message} title="Couldn't load this job" />
    );
  }
  const editing = data.clips.find(
    (clip) => clip.id === edit && clip.status === "ready"
  );
  if (editing) {
    return (
      <AiClipEditor
        clipId={editing.id}
        key={editing.id}
        onClose={closeEditor}
        ownerId={session.user.id}
      />
    );
  }
  return (
    <JobStudio
      job={data}
      key={data.id}
      onEdit={openEditor}
      onPick={setPickedId}
      pickedId={pickedId}
      retry={{
        run: () => retry.mutate({ id: jobId }),
        pending: retry.isPending,
      }}
    />
  );
}

const firstClip = (job: JobView): ClipView | undefined =>
  job.clips.find((clip) => clip.status === "ready") ?? job.clips[0];

function JobStudio({
  job,
  retry,
  pickedId,
  onPick,
  onEdit,
}: {
  job: JobView;
  retry: Retry;
  pickedId: string | undefined;
  onPick: (clipId: string) => void;
  onEdit: (clipId: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const selected =
    job.clips.find((clip) => clip.id === pickedId) ?? firstClip(job);

  const notReady = (clip: ClipView, action: string) =>
    toast(`Clip ${clip.rank} isn't ready to ${action} yet.`, {
      id: "clip-not-ready",
    });
  const move = (by: 1 | -1) => {
    const at = job.clips.findIndex((clip) => clip.id === selected?.id);
    const next =
      job.clips[Math.min(job.clips.length - 1, Math.max(0, at + by))];
    if (next) {
      onPick(next.id);
      document
        .querySelector(`#${clipRowId(next.id)}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  };
  useShortcuts({
    j: () => move(1),
    k: () => move(-1),
    " ": () => {
      const video = videoRef.current;
      if (!selected) {
        return;
      }
      if (!video || selected.status !== "ready") {
        notReady(selected, "play");
      } else if (video.paused) {
        video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    },
    d: () => {
      if (selected?.status === "ready") {
        downloadClip(selected.id);
      } else if (selected) {
        notReady(selected, "download");
      }
    },
    e: () => {
      if (selected?.status === "ready") {
        onEdit(selected.id);
      } else if (selected) {
        notReady(selected, "edit");
      }
    },
  });

  return (
    <main
      className="flex flex-1 flex-col lg:grid lg:min-h-0 lg:grid-rows-[auto_minmax(0,1fr)_auto]"
      data-fit-viewport
    >
      <JobBar job={job} />
      <div className="flex flex-col lg:grid lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_clamp(380px,39vw,560px)]">
        <Viewer
          clip={selected}
          job={job}
          onEdit={onEdit}
          retry={retry}
          videoRef={videoRef}
        />
        <div className="flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l">
          <RenderQueue job={job} retry={retry} />
          <ClipBin job={job} onSelect={onPick} selectedId={selected?.id} />
        </div>
      </div>
      <SourceTimeline job={job} onSelect={onPick} selectedId={selected?.id} />
    </main>
  );
}

function JobBar({ job }: { job: JobView }) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:gap-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <h1
          className="condensed min-w-0 truncate text-[20px] leading-tight font-semibold tracking-[-0.01em]"
          title={job.sourceName}
        >
          {job.sourceName}
        </h1>
        <StatusPill job={job} />
        <DeleteJob job={job} />
      </div>
      <dl className="flex justify-between gap-x-4 lg:shrink-0 lg:justify-start lg:gap-8">
        <Fact label="Length">
          {job.durationSeconds === null ? "—" : timecode(job.durationSeconds)}
        </Fact>
        <Fact label="Language">
          {job.language ? languageName(job.language) : "Auto"}
        </Fact>
        <Fact label="Clips ready">
          {job.readyCount}{" "}
          <span className="text-faint">
            of {job.totalCount || job.clipCount}
          </span>
        </Fact>
        <Fact label="Started">
          <time dateTime={job.createdAt}>{startedAgo(job.createdAt)}</time>
        </Fact>
      </dl>
    </div>
  );
}

function isClientError(httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && httpStatus < HTTP_SERVER_ERROR;
}

function LoadProblem({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link className={buttonVariants({ variant: "outline" })} to="/jobs">
          See your jobs
        </Link>
      </EmptyContent>
    </Empty>
  );
}
