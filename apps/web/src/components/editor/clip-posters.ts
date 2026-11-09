import { useEffect, useSyncExternalStore } from "react";

const posters = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const listeners = new Set<() => void>();
let queue: Promise<unknown> = Promise.resolve();

const WIDTH = 160;
const POSTER_FRAME_SECONDS = 0.1;
const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_POSTERS = 200;

const posterKey = (url: string, at: number) => `${url}#t=${at}`;

function capture(url: string, at: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let timer = 0;
    const done = (error?: unknown) => {
      window.clearTimeout(timer);
      video.removeAttribute("src");
      // Drops the connection; removing the attribute alone does not.
      video.load();
      if (error) {
        reject(error);
      }
    };
    timer = window.setTimeout(
      () => done(new Error("poster timed out")),
      CAPTURE_TIMEOUT_MS
    );
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.addEventListener(
      "error",
      () => done(new Error("poster unavailable")),
      { once: true }
    );
    video.addEventListener(
      "loadeddata",
      () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = WIDTH;
          canvas.height = Math.max(
            1,
            Math.round(
              (WIDTH * video.videoHeight) / (video.videoWidth || WIDTH)
            )
          );
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error("no 2d context");
          }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const poster = canvas.toDataURL("image/jpeg", 0.7);
          done();
          resolve(poster);
        } catch (error) {
          done(error);
        }
      },
      { once: true }
    );
    video.src = posterKey(url, at);
  });
}

function remember(key: string, poster: string) {
  posters.set(key, poster);
  const oldest = posters.keys().next().value;
  if (posters.size > MAX_POSTERS && oldest !== undefined) {
    posters.delete(oldest);
  }
  for (const listener of listeners) {
    listener();
  }
}

export function posterFor(url: string, at: number): Promise<string> {
  const key = posterKey(url, at);
  const cached = posters.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  const run = queue
    .then(() => capture(url, at))
    .then(
      (poster) => {
        remember(key, poster);
        pending.delete(key);
        return poster;
      },
      (error: unknown) => {
        pending.delete(key);
        throw error;
      }
    );
  pending.set(key, run);
  queue = run.catch(() => undefined);
  return run;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePoster(
  url: string | undefined,
  at = POSTER_FRAME_SECONDS,
  enabled = true
): string | undefined {
  const key = url ? posterKey(url, at) : undefined;
  const poster = useSyncExternalStore(
    subscribe,
    () => (key ? posters.get(key) : undefined),
    () => undefined
  );
  useEffect(() => {
    if (!(url && enabled) || posters.has(posterKey(url, at))) {
      return;
    }
    posterFor(url, at).catch(() => undefined);
  }, [url, at, enabled]);
  return poster;
}
