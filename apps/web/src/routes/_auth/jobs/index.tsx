import type { JobSummary } from "@clipradar/db/jobs";
import { buttonVariants } from "@clipradar/ui/components/button";
import { cn } from "@clipradar/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { ClipThumb, MomentMap, NotKnown } from "@/components/clips";
import { StatusPill } from "@/components/job-status";
import Loader from "@/components/loader";
import { startedAgo, timecode } from "@/lib/format";
import { languageName } from "@/lib/language";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/jobs/")({
  component: Jobs,
});

const POLL_MS = 5000;
const COLUMNS =
  "sm:grid sm:grid-cols-[minmax(0,1fr)_150px_minmax(120px,200px)_64px_80px] sm:gap-x-6 lg:grid-cols-[minmax(0,1fr)_170px_200px_80px_96px_130px_120px]";

function Jobs() {
  const trpc = useTRPC();
  const jobs = useQuery(
    trpc.jobs.list.queryOptions(undefined, {
      refetchInterval: (query) =>
        query.state.data?.some((job) => job.active) ? POLL_MS : false,
    })
  );
  const count = jobs.data?.length ?? 0;

  return (
    <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-5 lg:px-8 lg:py-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="condensed text-[20px] leading-tight font-semibold tracking-[-0.01em]">
          Your jobs
        </h1>
        {jobs.data ? (
          <span className="tnum text-faint text-[12px]">
            {count === 1 ? "1 job" : `${count} jobs`}
          </span>
        ) : null}
      </div>
      <JobsHead />
      <JobList jobs={jobs.data} />
      {jobs.error && !jobs.data ? (
        <p className="text-negative mt-6 text-[13px]" role="alert">
          Couldn't load your jobs. {jobs.error.message}
        </p>
      ) : null}
    </main>
  );
}

function JobsHead() {
  return (
    <div
      aria-hidden
      className={cn(
        "text-faint mt-5 hidden h-9 items-center border-b text-[12px]",
        COLUMNS
      )}
    >
      <span>Video</span>
      <span>Status</span>
      <span>Moments in the source</span>
      <span className="text-right">Clips</span>
      <span className="text-right">Length</span>
      <span className="hidden lg:block">Language</span>
      <span className="hidden text-right lg:block">Started</span>
    </div>
  );
}

function JobList({ jobs }: { jobs: JobSummary[] | undefined }) {
  if (!jobs) {
    return <Loader />;
  }
  if (jobs.length === 0) {
    return (
      <div className="border-input bg-viewer mt-4 flex flex-col items-start gap-4 rounded-xl border border-dashed px-6 py-10 sm:mt-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[15px] font-semibold">No jobs yet</p>
          <p className="text-muted-foreground mt-1 max-w-[52ch] text-[13px]">
            Upload a long video with speech. Each job turns it into ranked,
            captioned 9:16 clips you can download.
          </p>
        </div>
        <Link className={buttonVariants({ size: "lg" })} to="/new">
          Start your first job
        </Link>
      </div>
    );
  }
  return (
    <ul className="mt-4 sm:mt-0">
      {jobs.map((job) => (
        <li className="border-t sm:first:border-t-0" key={job.id}>
          <JobRow job={job} />
        </li>
      ))}
    </ul>
  );
}

function JobRow({ job }: { job: JobSummary }) {
  const cover = job.clips.find((clip) => clip.status === "ready");
  return (
    <Link
      className={cn(
        "hover:bg-raised -mx-3 flex min-h-[72px] items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-150 sm:items-center",
        COLUMNS
      )}
      params={{ jobId: job.id }}
      to="/jobs/$jobId"
    >
      <span className="flex min-w-0 flex-1 items-center gap-3">
        {cover ? (
          <ClipThumb className="w-[30px]" clip={cover} />
        ) : (
          <span
            aria-hidden
            className={cn(
              "bg-viewer block aspect-[9/16] w-[30px] shrink-0 rounded-md",
              job.status === "failed" ? "hatch-negative" : "hatch"
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span
            className="condensed block truncate text-[15px] font-semibold"
            title={job.sourceName}
          >
            {job.sourceName}
          </span>
          <span className="tnum text-faint mt-1.5 flex items-center gap-3 text-[12px] sm:hidden">
            <StatusPill job={job} />
            <span className="truncate">
              {job.readyCount} of {job.totalCount || job.clipCount} clips
            </span>
            <span className="ml-auto shrink-0">
              {startedAgo(job.createdAt)}
            </span>
          </span>
        </span>
      </span>
      <span className="hidden sm:block">
        <StatusPill job={job} />
      </span>
      <span className="hidden sm:block">
        <MomentMap job={job} />
      </span>
      <span className="tnum hidden text-right text-[13px] sm:block">
        {job.readyCount}
        <span className="text-faint"> / {job.totalCount || job.clipCount}</span>
      </span>
      <span className="tnum hidden text-right text-[13px] sm:block">
        {job.durationSeconds === null ? (
          <NotKnown />
        ) : (
          timecode(job.durationSeconds)
        )}
      </span>
      <span className="hidden text-[13px] lg:block">
        {job.language ? languageName(job.language) : "Auto"}
      </span>
      <span className="text-muted-foreground hidden text-right text-[13px] lg:block">
        <time dateTime={job.createdAt}>{startedAgo(job.createdAt)}</time>
      </span>
    </Link>
  );
}
