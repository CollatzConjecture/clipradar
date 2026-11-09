# clipradar

clipradar turns a long video into short vertical clips with burned-in captions. Upload a talk, podcast, or stream recording. clipradar transcribes it, asks a language model which 15 to 60 second moments stand on their own, and renders each one as a 9:16 MP4 ranked by score.

Everything runs on your own machine or server with `docker compose`. Transcription uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper) on the CPU. Moment selection uses any OpenAI-compatible Chat Completions API, hosted or local.

## Run it

You need Docker with Compose and an API key for a Chat Completions endpoint.

1. Clone the repository.

   ```bash
   git clone https://github.com/<owner>/clipradar.git
   cd clipradar
   ```

2. Create your settings file.

   ```bash
   cp .env.example .env
   ```

3. In `.env`, set `BETTER_AUTH_SECRET` to the output of `openssl rand -hex 32`, and set `LLM_API_KEY`.

4. Start the stack.

   ```bash
   docker compose up --build
   ```

   The first build downloads the Whisper model into the image, so it takes several minutes.

5. Open <http://localhost:3001>, create an account, and upload a video.

The job page shows each stage as it runs. Clips appear as soon as each one renders, and you can play or download them while the rest finish.

## How a video becomes clips

1. The web app streams your upload to a shared volume and queues a job in Postgres.
2. The worker claims the job, extracts the audio with `ffmpeg`, and sends it to the `whisper` service for word-level timestamps.
3. The worker sends the transcript to the language model, which scores candidate moments from 0 to 10 on hook, completeness, and payoff. Moments with a missing or out-of-range score are dropped.
4. The worker renders each moment with a center 9:16 crop and two-line captions built from the word timings.

If the worker stops mid-job, another attempt resumes from the last saved step. A failed or partial job can be retried from the job page. A retry keeps the transcript and every finished clip, and renders only what is missing.

Deleting a job from its page removes it at once, even mid-render. The worker deletes its upload, clips and saved versions from the shared volume within about ten minutes. It also removes clip and version files that an interrupted render left behind.

## Configure

All settings live in `.env`. Only `BETTER_AUTH_SECRET` is required to start. Jobs fail at the selection step until `LLM_API_KEY` is set for a hosted API.

| Variable | Default | Purpose |
|---|---|---|
| `BETTER_AUTH_SECRET` | none | Signs sessions. Required. |
| `BETTER_AUTH_URL` | `http://localhost:3001` | The URL people open. Set it to your domain when you host clipradar. |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Chat Completions base URL, ending before `/chat/completions`. |
| `LLM_API_KEY` | empty | Sent as a bearer token when set. |
| `LLM_MODEL` | `gpt-5.4-mini` | The model that picks moments. |
| `LLM_MAX_TRANSCRIPT_CHARS` | `60000` | Transcript characters per request. Longer transcripts are split into overlapping windows. |
| `WHISPER_MODEL` | `small` | faster-whisper model baked into the image at build time. |
| `WHISPER_THREADS` | `4` | CPU threads for transcription. |
| `WHISPER_TIMEOUT_MINUTES` | `120` | How long the worker waits for one transcription. |
| `MAX_UPLOAD_MB` | `4096` | Largest accepted upload. |
| `WEB_PORT` | `3001` | Host port for the web app. |
| `POSTGRES_PASSWORD` | `password` | Database password. Postgres listens on `127.0.0.1` only. |
| `POSTGRES_PORT` | `5432` | Host port for Postgres. |

To use Ollama on the host instead of a hosted API, set `LLM_BASE_URL=http://host.docker.internal:11434/v1`, leave `LLM_API_KEY` empty, and pick a model with a context window of at least 16k tokens. If the model's context is small, lower `LLM_MAX_TRANSCRIPT_CHARS`.

## Develop

The repository is a Bun workspace.

| Path | What it holds |
|---|---|
| `apps/web` | TanStack Start app: pages, upload and clip download routes, auth. |
| `apps/worker` | Bun worker: claim, transcribe, select, caption, render. |
| `apps/whisper` | Python faster-whisper HTTP service. |
| `packages/db` | Drizzle schema, migrations, and `jobs.ts`, the only code that writes job state. |
| `packages/api` | tRPC router for jobs. |

To run the web app and worker outside Docker:

```bash
bun install
docker compose up -d postgres whisper
bun run db:migrate
bun run dev:web
bun run --filter worker dev
```

Run the tests with `bun test` in `packages/db` and `apps/worker`. The database tests need the Postgres container.

## License

[MIT](LICENSE)
