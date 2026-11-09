import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import Header from "@/components/header";
import { ShortcutSheet } from "@/components/shortcut-sheet";
import { getUser } from "@/functions/get-user";
import { useShortcuts } from "@/lib/shortcuts";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
  beforeLoad: async () => {
    const session = await getUser();
    if (!session) {
      throw redirect({
        to: "/login",
      });
    }
    return { session };
  },
});

function AuthLayout() {
  const { session } = Route.useRouteContext();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  useShortcuts({ "?": showShortcuts });
  return (
    <div className="flex min-h-svh flex-col min-[761px]:has-[.clip-editor]:h-svh lg:has-[[data-fit-viewport]]:h-svh">
      <Header onShowShortcuts={showShortcuts} user={session.user} />
      <Outlet />
      <ShortcutSheet onOpenChange={setShortcutsOpen} open={shortcutsOpen} />
    </div>
  );
}
