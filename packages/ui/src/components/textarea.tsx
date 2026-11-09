import { cn } from "@clipradar/ui/lib/utils";
import type * as React from "react";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "border-input placeholder:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 bg-raised flex field-sizing-content min-h-16 w-full resize-none rounded-lg border px-2.5 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-1 md:text-xs",
        className
      )}
      data-slot="textarea"
      {...props}
    />
  );
}

export { Textarea };
