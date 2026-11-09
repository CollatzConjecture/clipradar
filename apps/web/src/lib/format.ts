const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const DAYS_PER_WEEK = 7;
const JUST_NOW_SECONDS = 45;
const MAX_RULER_TICKS = 7;
const RULER_STEPS = [
  5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
] as const;

const AGO_UNITS = [
  { unit: "minute", seconds: SECONDS_PER_MINUTE, below: SECONDS_PER_HOUR },
  { unit: "hour", seconds: SECONDS_PER_HOUR, below: SECONDS_PER_DAY },
  {
    unit: "day",
    seconds: SECONDS_PER_DAY,
    below: SECONDS_PER_DAY * DAYS_PER_WEEK,
  },
] as const;

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DATE = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function timecode(totalSeconds: number): string {
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const rest = String(seconds % SECONDS_PER_MINUTE).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

export function tenths(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds * 10) / 10;
  const whole = Math.floor(rounded);
  return `${timecode(whole)}.${Math.round((rounded - whole) * 10)}`;
}

export function rulerStep(totalSeconds: number): number {
  return (
    RULER_STEPS.find((step) => totalSeconds / step <= MAX_RULER_TICKS) ??
    Math.ceil(totalSeconds / MAX_RULER_TICKS / SECONDS_PER_HOUR) *
      SECONDS_PER_HOUR
  );
}

export function startedAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < JUST_NOW_SECONDS) {
    return "Just now";
  }
  const match = AGO_UNITS.find((u) => seconds < u.below);
  if (!match) {
    return DATE.format(new Date(iso));
  }
  const text = RELATIVE.format(
    -Math.max(1, Math.round(seconds / match.seconds)),
    match.unit
  );
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function score(value: number): string {
  return value.toFixed(1);
}
