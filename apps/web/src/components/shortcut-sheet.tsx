import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@clipradar/ui/components/dialog";
import { Kbd, KbdGroup } from "@clipradar/ui/components/kbd";

const GROUPS = [
  {
    title: "Job page",
    shortcuts: [
      { keys: ["J", "K"], action: "Next or previous clip" },
      { keys: ["Space"], action: "Play or pause the selected clip" },
      { keys: ["E"], action: "Edit the selected clip" },
      { keys: ["D"], action: "Download the selected clip" },
      { keys: ["?"], action: "Show this list" },
    ],
  },
  {
    title: "Clip editor",
    shortcuts: [
      { keys: ["Space"], action: "Play or pause the preview" },
      { keys: ["←", "→"], action: "Move the playhead 0.1 s, with Shift 1 s" },
      { keys: ["Home", "End"], action: "Jump to the start or the end" },
      { keys: ["S"], action: "Split at the playhead" },
      { keys: ["⌘/Ctrl", "Z"], action: "Undo, with Shift redo" },
      { keys: ["Esc"], action: "Close the editor" },
    ],
  },
] as const;

export function ShortcutSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[13px]">
            None of them fire while you type.
          </DialogDescription>
        </DialogHeader>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3 className="text-faint mb-1 text-[12px]">{group.title}</h3>
            <dl className="flex flex-col">
              {group.shortcuts.map(({ keys, action }) => (
                <div
                  className="flex min-h-10 items-center justify-between gap-4 border-t first:border-t-0"
                  key={action}
                >
                  <dt className="text-[13px]">{action}</dt>
                  <dd>
                    <KbdGroup>
                      {keys.map((key) => (
                        <Kbd
                          className="bg-secondary text-foreground min-w-6 px-1.5 text-[12px]"
                          key={key}
                        >
                          {key}
                        </Kbd>
                      ))}
                    </KbdGroup>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
