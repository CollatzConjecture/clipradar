import { cn } from "@clipradar/ui/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("bg-muted animate-pulse rounded-lg", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
