import type { Transcript } from "@clipradar/db/jobs";
import { file } from "bun";
import { z } from "zod";

const NO_IDLE_TIMEOUT = { timeout: false };

const wire = z.object({
  language: z.string().min(1),
  duration: z.number().positive(),
  segments: z.array(
    z.object({
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
      text: z.string(),
      words: z.array(
        z.object({
          start: z.number().nonnegative(),
          end: z.number().nonnegative(),
          word: z.string(),
        })
      ),
    })
  ),
});
const failure = z.object({ error: z.string() });

export async function transcribe(input: {
  url: string;
  audioFile: string;
  language: string | null;
  timeoutMinutes: number;
  signal: AbortSignal;
}): Promise<Transcript> {
  const timeout = AbortSignal.timeout(input.timeoutMinutes * 60_000);
  const headers: Record<string, string> = { "content-type": "audio/ogg" };
  if (input.language) {
    headers["x-language"] = input.language;
  }
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(new URL("/transcribe", input.url), {
      method: "POST",
      // A file body makes Bun send Content-Length, which the service requires.
      body: file(input.audioFile),
      headers,
      signal: AbortSignal.any([input.signal, timeout]),
      ...NO_IDLE_TIMEOUT,
    });
    body = await response.json().catch(() => null);
  } catch (error) {
    if (input.signal.aborted) {
      throw input.signal.reason;
    }
    if (timeout.aborted) {
      throw new Error(
        `Whisper took over ${input.timeoutMinutes} minutes. Raise WHISPER_TIMEOUT_MINUTES in .env for long videos.`,
        { cause: error }
      );
    }
    throw new Error(
      `Couldn't reach the Whisper service at ${input.url}. Check \`docker compose logs whisper\`.`,
      { cause: error }
    );
  }
  if (response.status === 413) {
    throw new Error(
      "This video's audio is longer than the Whisper service accepts (about 4.5 hours)."
    );
  }
  if (response.status === 400) {
    const reason = failure.safeParse(body).data?.error ?? "no details";
    throw new Error(`Whisper couldn't use this audio: ${reason}.`);
  }
  if (!response.ok) {
    throw new Error(
      `Whisper failed (${response.status}). Check \`docker compose logs whisper\`.`
    );
  }
  const parsed = wire.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "Whisper returned a response clipradar doesn't understand. Check that WHISPER_URL points at the clipradar Whisper service."
    );
  }
  return toTranscript(parsed.data);
}

function toTranscript(data: z.output<typeof wire>): Transcript {
  const span = (start: number, end: number) => {
    const from = Math.min(start, data.duration);
    return { start: from, end: Math.min(Math.max(end, from), data.duration) };
  };
  const segments = data.segments.flatMap((segment) => {
    const text = segment.text.trim();
    if (!text) {
      return [];
    }
    const words = segment.words.flatMap((word) => {
      const wordText = word.word.trim();
      return wordText
        ? [{ ...span(word.start, word.end), text: wordText }]
        : [];
    });
    return [{ ...span(segment.start, segment.end), text, words }];
  });
  if (segments.length === 0) {
    throw new Error("Whisper found no speech in this video.");
  }
  return {
    language: data.language,
    durationSeconds: data.duration,
    segments,
  };
}
