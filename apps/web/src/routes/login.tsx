import { Button } from "@clipradar/ui/components/button";
import { Input } from "@clipradar/ui/components/input";
import { Label } from "@clipradar/ui/components/label";
import { cn } from "@clipradar/ui/lib/utils";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Captions, Eye, EyeOff, KeyRound, Server } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  type MouseEvent,
  useCallback,
  useState,
} from "react";
import { toast } from "sonner";

import { Wordmark } from "@/components/header";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/login")({
  component: Login,
});

type Mode = "sign-in" | "sign-up";

const COPY: Record<
  Mode,
  {
    title: string;
    lede: string;
    submit: string;
    pending: string;
    switchPrompt: string;
    switchAction: string;
    other: Mode;
  }
> = {
  "sign-in": {
    title: "Welcome back",
    lede: "Sign in to get back to your clips.",
    submit: "Sign in",
    pending: "Signing in…",
    switchPrompt: "New to clipradar?",
    switchAction: "Create an account",
    other: "sign-up",
  },
  "sign-up": {
    title: "Create your account",
    lede: "Start turning long videos into clips.",
    submit: "Create account",
    pending: "Creating account…",
    switchPrompt: "Already have an account?",
    switchAction: "Sign in",
    other: "sign-in",
  },
};

/** Better Auth's default minimum. */
const MIN_PASSWORD_LENGTH = 8;

function Login() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[mode];

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const email = String(data.get("email"));
      const password = String(data.get("password"));
      setPending(true);
      setError(null);
      const result =
        mode === "sign-up"
          ? await authClient.signUp.email({
              email,
              password,
              name: String(data.get("name")),
            })
          : await authClient.signIn.email({ email, password });
      setPending(false);
      if (result.error) {
        setError(result.error.message ?? result.error.statusText);
        return;
      }
      await navigate({ to: "/" });
    },
    [mode, navigate]
  );
  const switchMode = useCallback(() => {
    setError(null);
    setMode((current) => COPY[current].other);
  }, []);

  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_520px]">
      <Showcase />
      <main className="flex flex-col px-5 py-5 sm:px-12 lg:px-16 lg:py-10">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <div className="mx-auto my-auto w-full max-w-[372px] py-10 lg:mx-0">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.02em]">
            {copy.title}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">{copy.lede}</p>
          <form className="mt-8 flex flex-col gap-4" onSubmit={onSubmit}>
            {mode === "sign-up" && (
              <Field
                autoComplete="name"
                id="name"
                label="Name"
                placeholder="Ada Lovelace"
              />
            )}
            <Field
              autoComplete="email"
              id="email"
              label="Email"
              placeholder="you@example.com"
              type="email"
            />
            <PasswordField
              autoComplete={
                mode === "sign-up" ? "new-password" : "current-password"
              }
              hint={
                mode === "sign-up"
                  ? `At least ${MIN_PASSWORD_LENGTH} characters.`
                  : undefined
              }
              minLength={mode === "sign-up" ? MIN_PASSWORD_LENGTH : undefined}
            />
            {error ? (
              <p className="text-negative text-[13px]" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              className="mt-2 w-full text-sm font-semibold"
              disabled={pending}
              size="lg"
              type="submit"
            >
              {pending ? copy.pending : copy.submit}
            </Button>
          </form>
          <div className="text-faint before:bg-border after:bg-border my-6 flex items-center gap-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1">
            or
          </div>
          <SocialSignIn />
          <p className="text-muted-foreground mt-6 text-center text-[13px]">
            {copy.switchPrompt}{" "}
            <button
              className="text-primary-text rounded-sm font-medium underline-offset-4 hover:underline"
              onClick={switchMode}
              type="button"
            >
              {copy.switchAction}
            </button>
          </p>
        </div>
      </main>
    </div>
  );
}

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & ComponentProps<"input">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} required {...props} />
    </div>
  );
}

function PasswordField({
  hint,
  ...props
}: { hint?: string } & ComponentProps<"input">) {
  const [shown, setShown] = useState(false);
  const toggle = useCallback(() => setShown((value) => !value), []);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="password">Password</Label>
      <div className="relative">
        <Input
          aria-describedby={hint ? "password-hint" : undefined}
          className="pr-10"
          id="password"
          name="password"
          required
          type={shown ? "text" : "password"}
          {...props}
        />
        <button
          aria-label="Show password"
          aria-pressed={shown}
          className="text-faint hover:text-foreground absolute inset-y-1 right-1 grid w-8 place-items-center rounded-md transition-colors"
          onClick={toggle}
          type="button"
        >
          {shown ? (
            <EyeOff aria-hidden className="size-4" />
          ) : (
            <Eye aria-hidden className="size-4" />
          )}
        </button>
      </div>
      {hint ? (
        <p className="text-faint text-[12px]" id="password-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ponytail: placeholders. Wire each to Better Auth's socialProviders once its OAuth app exists.
const PROVIDERS = [
  { name: "Google", Logo: GoogleLogo },
  { name: "Apple", Logo: AppleLogo },
  { name: "GitHub", Logo: GitHubLogo },
] as const;

function SocialSignIn() {
  const notYet = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    toast.info(
      `${event.currentTarget.dataset.provider} sign-in isn't set up yet. Use your email for now.`,
      { id: "social-sign-in" }
    );
  }, []);
  return (
    <div className="flex flex-col gap-2.5">
      {PROVIDERS.map(({ name, Logo }) => (
        <Button
          className="h-10 w-full gap-2.5 text-sm"
          data-provider={name}
          key={name}
          onClick={notYet}
          variant="outline"
        >
          <Logo />
          Continue with {name}
        </Button>
      ))}
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg aria-hidden className="size-[18px]" viewBox="0 0 24 24">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </svg>
  );
}

function AppleLogo() {
  return (
    <svg
      aria-hidden
      className="size-[18px]"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg
      aria-hidden
      className="size-[18px]"
      fill="currentColor"
      viewBox="0 0 24 24"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/** Drawn, not data, because nobody is signed in yet. `*word*` is the word being spoken. */
const SHOWCASE_CLIPS = [
  {
    rank: 2,
    score: "8.8",
    caption: ["Most people *think*", "productivity is"],
    background: "linear-gradient(160deg, #2b3340, #15191f)",
    shade: "#3a4350",
    progress: "38%",
  },
  {
    rank: 1,
    score: "9.2",
    caption: ["The one habit", "that *changed* it"],
    background: "linear-gradient(160deg, #352f52, #17151f)",
    shade: "#4a4268",
    progress: "62%",
  },
  {
    rank: 3,
    score: "8.1",
    caption: ["Protect your", "*sleep* first"],
    background: "linear-gradient(160deg, #21363b, #131a1c)",
    shade: "#30494f",
    progress: "20%",
  },
] as const;

/** Where the moments sit in the source, as fractions of its length. */
const SHOWCASE_MOMENTS = [
  { rank: 2, start: 0.08, end: 0.2 },
  { rank: 1, start: 0.41, end: 0.56 },
  { rank: 3, start: 0.72, end: 0.83 },
] as const;

const WAVE_BARS = 96;
const WAVE = Array.from({ length: WAVE_BARS }, (_, index) => {
  const at = index / WAVE_BARS;
  const swing =
    Math.sin(index * 1.7) * Math.cos(index * 0.37) +
    0.25 * Math.sin(index * 5.1);
  return {
    id: `bar-${index}`,
    height: Math.min(92, 18 + 70 * Math.abs(swing)),
    rank: SHOWCASE_MOMENTS.find(({ start, end }) => at >= start && at <= end)
      ?.rank,
  };
});

const RADAR_RINGS = [960, 700, 440, 220] as const;
const SPOKEN = /(?<spoken>\*[^*]+\*)/u;

function Showcase() {
  return (
    <section
      aria-label="What clipradar makes"
      className="bg-viewer relative hidden flex-col gap-10 overflow-hidden px-14 py-10 lg:flex"
    >
      <Wordmark />
      <div className="max-w-[520px]">
        <h2 className="condensed text-[46px] leading-[1.04] font-semibold tracking-[-0.025em]">
          Long video in.
          <br />
          <span className="text-faint">Clips worth posting out.</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-[460px] text-[15px] leading-relaxed">
          clipradar transcribes your video, scores every moment with the model
          you choose, and renders the best ones as captioned 9:16 clips.
        </p>
      </div>
      <div aria-hidden className="mt-auto flex max-w-[560px] flex-col gap-5">
        <div className="relative flex items-end gap-4">
          <Radar />
          {SHOWCASE_CLIPS.map((clip) => (
            <ShowcaseClip key={clip.rank} {...clip} />
          ))}
        </div>
        <div>
          <div className="tnum text-faint mb-2 flex justify-between text-[12px]">
            <span>founder-podcast-ep12.mp4 · 48:12</span>
            <span>3 moments picked</span>
          </div>
          <div className="bg-card relative flex h-11 items-center gap-0.5 rounded-[10px] px-2">
            {WAVE.map((bar) => (
              <span
                className={cn(
                  "flex-1 rounded-sm",
                  bar.rank === undefined && "bg-input/80",
                  bar.rank === 1 && "bg-primary",
                  bar.rank !== undefined && bar.rank !== 1 && "bg-primary/55"
                )}
                key={bar.id}
                style={{ height: `${bar.height}%` }}
              />
            ))}
            <div className="absolute inset-x-2 -inset-y-1 translate-x-[41%] motion-safe:animate-[playhead-scan_8s_linear_infinite]">
              <span className="bg-foreground before:bg-foreground absolute inset-y-0 left-0 w-0.5 rounded-full before:absolute before:-top-1 before:-left-[3px] before:size-2 before:rounded-full" />
            </div>
          </div>
        </div>
      </div>
      <ul className="text-muted-foreground flex gap-7 text-[13px]">
        <Fact icon={Captions}>Word-timed captions</Fact>
        <Fact icon={KeyRound}>Your own model key</Fact>
        <Fact icon={Server}>Self-hosted, MIT licensed</Fact>
      </ul>
    </section>
  );
}

function Radar() {
  return (
    <div className="pointer-events-none absolute top-1/2 left-1/2 size-[960px] -translate-x-1/2 -translate-y-1/2">
      {RADAR_RINGS.map((size) => (
        <span
          className="absolute inset-0 m-auto rounded-full border border-white/5"
          key={size}
          style={{ width: size, height: size }}
        />
      ))}
      <span className="absolute inset-0 rounded-full [mask-image:radial-gradient(circle,#000_0,transparent_68%)] [background:conic-gradient(from_0deg,transparent_0deg_300deg,color-mix(in_oklab,var(--primary)_14%,transparent)_360deg)] motion-safe:animate-[spin_10s_linear_infinite] motion-reduce:hidden" />
    </div>
  );
}

function ShowcaseClip({
  rank,
  score,
  caption,
  background,
  shade,
  progress,
}: (typeof SHOWCASE_CLIPS)[number]) {
  const lead = rank === 1;
  return (
    <div
      className={cn(
        "relative aspect-[9/16] shrink-0 overflow-hidden rounded-xl border border-white/8 shadow-[0_18px_40px_-18px_rgb(0_0_0/0.7)]",
        lead
          ? "outline-primary w-[164px] outline-2 outline-offset-3"
          : "w-[138px]"
      )}
      style={{ background }}
    >
      <svg
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[74%] w-full"
        preserveAspectRatio="xMidYMax slice"
        viewBox="0 0 100 130"
      >
        <circle cx="50" cy="38" fill={shade} r="19" />
        <path d="M8 130c2-34 20-58 42-58s40 24 42 58z" fill={shade} />
      </svg>
      <span className="tnum absolute top-2 left-2 flex gap-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[11px] backdrop-blur-sm">
        <b className="font-semibold">#{rank}</b>
        <span className="text-faint">{score}</span>
      </span>
      <span
        className={cn(
          "absolute inset-x-2 bottom-[19%] text-center leading-tight font-extrabold uppercase [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]",
          lead ? "text-[13.5px]" : "text-[12px]"
        )}
      >
        {caption.map((line) => (
          <span className="block" key={line}>
            {line.split(SPOKEN).map((part) =>
              part.startsWith("*") ? (
                <span className="text-primary-text" key={part}>
                  {part.slice(1, -1)}
                </span>
              ) : (
                part
              )
            )}
          </span>
        ))}
      </span>
      <span className="absolute inset-x-2.5 bottom-2.5 h-[3px] overflow-hidden rounded-full bg-white/20">
        <span
          className="bg-foreground block h-full rounded-full"
          style={{ width: progress }}
        />
      </span>
    </div>
  );
}

function Fact({
  icon: Icon,
  children,
}: {
  icon: typeof Captions;
  children: string;
}) {
  return (
    <li className="flex items-center gap-2">
      <Icon aria-hidden className="text-faint size-4" />
      {children}
    </li>
  );
}
