import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import Loader from "@/components/loader";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/")({
  component: Home,
});

function Home() {
  const trpc = useTRPC();
  const jobs = useQuery(trpc.jobs.list.queryOptions());
  if (jobs.error) {
    return (
      <p className="text-destructive p-8 text-center text-sm">
        Couldn't load your jobs. {jobs.error.message}
      </p>
    );
  }
  if (!jobs.data) {
    return <Loader />;
  }
  const [latest] = jobs.data;
  return latest ? (
    <Navigate params={{ jobId: latest.id }} replace to="/jobs/$jobId" />
  ) : (
    <Navigate replace to="/new" />
  );
}
