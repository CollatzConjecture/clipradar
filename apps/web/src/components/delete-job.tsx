import type { JobView } from "@clipradar/db/jobs";
import { Button } from "@clipradar/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@clipradar/ui/components/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";

import { useTRPC } from "@/utils/trpc";

export function DeleteJob({ job }: { job: JobView }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(
    trpc.jobs.delete.mutationOptions({
      onSuccess: async () => {
        queryClient.setQueryData(trpc.jobs.list.queryKey(), (jobs) =>
          jobs?.filter(({ id }) => id !== job.id)
        );
        await navigate({ to: "/jobs" });
        // After leaving, so the page's poll can't refetch a job that is gone.
        queryClient.removeQueries({
          queryKey: trpc.jobs.get.queryKey({ id: job.id }),
        });
        toast(`Deleted ${job.sourceName}`);
      },
      onError: (error) =>
        toast.error("Couldn't delete this job.", {
          description: error.message,
        }),
    })
  );
  const { mutate } = remove;
  const confirm = useCallback(() => mutate({ id: job.id }), [mutate, job.id]);
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            aria-label="Delete job"
            className="text-muted-foreground ml-auto"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Trash2 />
      </DialogTrigger>
      <DialogContent
        className="gap-5 p-5 sm:max-w-[400px]"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">
            Delete this job?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[13px]">
            {job.active ? "Processing stops. " : ""}This deletes{" "}
            <span className="text-foreground break-all">{job.sourceName}</span>,
            its clips and every saved version. You can't undo this.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" />}>
            Cancel
          </DialogClose>
          <Button
            disabled={remove.isPending}
            onClick={confirm}
            variant="destructive"
          >
            {remove.isPending ? "Deleting…" : "Delete job"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
