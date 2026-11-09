import { Avatar, AvatarFallback } from "@clipradar/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@clipradar/ui/components/dropdown-menu";
import { Kbd } from "@clipradar/ui/components/kbd";
import { cn } from "@clipradar/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Keyboard, LogOut, Plus, Rows3 } from "lucide-react";
import { useCallback } from "react";

import { authClient } from "@/lib/auth-client";

/** A 9:16 frame with two caption lines. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("h-[26px] w-[18px] shrink-0", className)}
      viewBox="0 0 18 26"
    >
      <rect
        fill="none"
        height="24"
        rx="2.5"
        stroke="var(--faint)"
        strokeWidth="1.5"
        width="16"
        x="1"
        y="1"
      />
      <rect
        fill="var(--primary)"
        height="2.25"
        rx="1.1"
        width="10"
        x="4"
        y="15"
      />
      <rect
        fill="var(--primary)"
        height="2.25"
        rx="1.1"
        width="7"
        x="5.5"
        y="19"
      />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <Mark />
      <span className="text-[15px] font-semibold tracking-[-0.01em]">
        clipradar
      </span>
    </span>
  );
}

const NAV = [
  { to: "/new", label: "New job", icon: Plus },
  { to: "/jobs", label: "Your jobs", icon: Rows3 },
] as const;

const EXACT = { exact: true };
const WORDS = /\s+/u;

export default function Header({
  user,
  onShowShortcuts,
}: {
  user: { name: string; email: string };
  onShowShortcuts: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOut = useCallback(async () => {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: "/login" });
  }, [navigate, queryClient]);
  const initials = user.name
    .split(WORDS)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-3 sm:px-4">
      <Link aria-label="clipradar, latest job" className="rounded-lg" to="/">
        <Wordmark />
      </Link>
      <nav aria-label="Main" className="ml-3 flex items-center gap-0.5 sm:ml-6">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            activeOptions={EXACT}
            className="press text-muted-foreground hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium"
            key={to}
            to={to}
          >
            <Icon aria-hidden className="hidden size-4 sm:block" />
            {label}
          </Link>
        ))}
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Account, ${user.name}`}
          className="press text-muted-foreground hover:text-foreground ml-auto flex h-8 items-center gap-2 rounded-lg px-1 text-[13px] sm:pr-2.5"
        >
          <Avatar size="sm">
            <AvatarFallback className="bg-secondary text-foreground text-[11px] font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden max-w-48 truncate sm:inline">
            {user.name}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              <span className="text-foreground block truncate">
                {user.name}
              </span>
              <span className="mt-1 block truncate text-[12px]">
                {user.email}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onShowShortcuts}>
            <Keyboard aria-hidden />
            Keyboard shortcuts
            <Kbd className="ml-auto">?</Kbd>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={signOut}>
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
