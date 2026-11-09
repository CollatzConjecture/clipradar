import { useEffect, useRef } from "react";

/** KeyboardEvent.key lowercased, with `mod+` for Cmd or Ctrl and `shift+` after it. */
export type ShortcutKey = "j" | "k" | " " | "d" | "e" | "?";

const TYPING =
  'input:not([type="range"], [type="checkbox"], [type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"])';
const LAYER = '[role="dialog"], [role="menu"], [role="listbox"]';
/** Controls that Space presses natively. Clip rows opt out so Space plays the clip they select. */
const SPACE_PRESSES =
  'button:not([data-clip-row]), summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"]';

function chord(event: KeyboardEvent): string {
  const key = event.key.toLowerCase();
  if (!(event.metaKey || event.ctrlKey)) {
    return key;
  }
  return event.shiftKey ? `mod+shift+${key}` : `mod+${key}`;
}

function pageOwns(event: KeyboardEvent, key: string): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey) {
    return false;
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(`${TYPING}, ${LAYER}`)) {
    return false;
  }
  return !(key === " " && target?.closest(SPACE_PRESSES));
}

/**
 * Binds shortcuts on the window. Keys stay with the focused field while
 * someone types, with an open dialog, menu, or select, and with any control
 * that already handled them, such as a focused slider's arrow keys.
 */
export function useShortcuts(
  bindings: Partial<Record<ShortcutKey, (event: KeyboardEvent) => void>>
): void {
  const latest = useRef(bindings);
  latest.current = bindings;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = chord(event);
      const run = latest.current[key as ShortcutKey];
      if (!(run && pageOwns(event, key))) {
        return;
      }
      event.preventDefault();
      run(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
