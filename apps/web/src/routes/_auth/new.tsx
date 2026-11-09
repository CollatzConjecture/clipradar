import { CLIP_COUNT, CLIP_SECONDS } from "@clipradar/db/rules";
import { Button } from "@clipradar/ui/components/button";
import { Progress } from "@clipradar/ui/components/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@clipradar/ui/components/select";
import { Slider } from "@clipradar/ui/components/slider";
import { cn } from "@clipradar/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FileVideo, Upload as UploadIcon, X } from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useCallback,
  useId,
  useState,
} from "react";

import { STEP_COPY, STEP_ORDER } from "@/components/job-status";
import { languageName } from "@/lib/language";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/new")({
  component: NewJob,
});

const AUTO = "auto";
const LANGUAGES: Record<string, string> = Object.fromEntries([
  [AUTO, "Detect automatically"],
  ...["en", "id", "es", "pt", "fr", "de", "hi", "ja", "ko", "zh"].map(
    (code) => [code, languageName(code)]
  ),
]);
const BYTES_PER_MB = 1024 * 1024;
const PERCENT = 100;

type Upload =
  | { state: "idle" }
  | { state: "sending"; loaded: number; total: number; cancel: () => void }
  | { state: "error"; message: string };

const mb = (bytes: number) =>
  `${Math.round(bytes / BYTES_PER_MB).toLocaleString("en")} MB`;

function NewJob() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [file, setFile] = useState<File | null>(null);
  const [clipCount, setClipCount] = useState<number>(CLIP_COUNT.default);
  const [language, setLanguage] = useState(AUTO);
  const [upload, setUpload] = useState<Upload>({ state: "idle" });
  const sending = upload.state === "sending";

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!file) {
        return;
      }
      const abort = new AbortController();
      const cancel = () => abort.abort();
      setUpload({ state: "sending", loaded: 0, total: file.size, cancel });
      try {
        const jobId = await uploadVideo(
          {
            file,
            clipCount: String(clipCount),
            language: language === AUTO ? "" : language,
          },
          (loaded, total) =>
            setUpload({ state: "sending", loaded, total, cancel }),
          abort.signal
        );
        await queryClient.invalidateQueries({
          queryKey: trpc.jobs.list.queryKey(),
        });
        await navigate({ to: "/jobs/$jobId", params: { jobId } });
      } catch (error) {
        setUpload(
          abort.signal.aborted
            ? { state: "idle" }
            : {
                state: "error",
                message:
                  error instanceof Error ? error.message : "Upload failed.",
              }
        );
      }
    },
    [file, clipCount, language, navigate, queryClient, trpc]
  );
  const onClipCount = useCallback((value: number | readonly number[]) => {
    if (typeof value === "number") {
      setClipCount(value);
    }
  }, []);
  const onLanguage = useCallback(
    (value: string | null) => setLanguage(value ?? AUTO),
    []
  );

  return (
    <main className="mx-auto grid w-full max-w-[1280px] flex-1 content-start gap-6 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8 lg:px-8 lg:py-8">
      <div className="lg:col-span-2 lg:-mb-2">
        <h1 className="condensed text-[20px] leading-tight font-semibold tracking-[-0.01em]">
          New job
        </h1>
        <p className="text-muted-foreground mt-1 max-w-[62ch] text-[13px]">
          Upload a long video with speech. clipradar picks the moments that
          stand on their own and renders each one as a captioned 9:16 clip.
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {upload.state === "sending" ? (
          <Sending fileName={file?.name ?? "video"} {...upload} />
        ) : (
          <Dropzone file={file} onFile={setFile} />
        )}
      </div>

      <aside aria-label="Job settings" className="flex flex-col gap-6">
        <form
          className="bg-card flex flex-col gap-5 rounded-xl p-5"
          onSubmit={onSubmit}
        >
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-medium" id="clip-count-label">
                Number of clips
              </span>
              <span className="tnum text-[20px] leading-none font-semibold">
                {clipCount}
              </span>
            </div>
            <Slider
              aria-labelledby="clip-count-label"
              disabled={sending}
              max={CLIP_COUNT.max}
              min={CLIP_COUNT.min}
              onValueChange={onClipCount}
              thumbLabel="Number of clips"
              value={clipCount}
            />
            <div
              aria-hidden
              className="tnum text-faint flex justify-between text-[12px]"
            >
              <span>{CLIP_COUNT.min}</span>
              <span>{CLIP_COUNT.max}</span>
            </div>
            <p className="text-faint text-[12px]">
              You get fewer when the video has fewer strong moments.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Select
              disabled={sending}
              items={LANGUAGES}
              onValueChange={onLanguage}
              value={language}
            >
              <span className="text-[13px] font-medium" id="language-label">
                Spoken language
              </span>
              <SelectTrigger
                aria-labelledby="language-label"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LANGUAGES).map(([code, name]) => (
                  <SelectItem key={code} value={code}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-faint text-[12px]">
              Each clip runs {CLIP_SECONDS.min} to {CLIP_SECONDS.max} seconds.
            </p>
          </div>
          {sending ? (
            <p className="bg-secondary text-muted-foreground rounded-lg px-3 py-2.5 text-[13px]">
              Settings are locked while the video uploads. The job starts when
              the upload finishes.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <Button
                aria-describedby={file ? undefined : "start-hint"}
                disabled={!file}
                size="lg"
                type="submit"
              >
                Start job
              </Button>
              {!file && (
                <p className="text-faint text-[12px]" id="start-hint">
                  Choose a video first.
                </p>
              )}
              {upload.state === "error" && (
                <p className="text-negative text-[13px]" role="alert">
                  {upload.message}
                </p>
              )}
            </div>
          )}
        </form>

        <section aria-labelledby="next-heading" className="px-1">
          <h2 className="text-[13px] font-semibold" id="next-heading">
            After the upload
          </h2>
          <ol className="mt-3 flex flex-col gap-3">
            {STEP_ORDER.map((step) => (
              <li className="grid grid-cols-[16px_1fr] gap-3" key={step}>
                <span
                  aria-hidden
                  className="border-faint mt-1.5 size-2 rounded-full border"
                />
                <span>
                  <span className="block text-[13px]">
                    {STEP_COPY[step].name}
                  </span>
                  <span className="text-faint mt-0.5 block text-[12px]">
                    {STEP_COPY[step].detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </aside>
    </main>
  );
}

/** The 9:16 crop every clip takes from the middle of a 16:9 frame. */
function CropGuide() {
  return (
    <span
      aria-hidden
      className="border-control pointer-events-none absolute inset-y-4 left-1/2 hidden -translate-x-1/2 border-x border-dashed sm:block"
      style={{ width: "calc((100cqh - 32px) * 9 / 16)" }}
    >
      <span className="text-faint absolute top-2 left-2 text-[11px]">9:16</span>
    </span>
  );
}

const FRAME =
  "bg-viewer relative flex min-h-[300px] flex-col rounded-xl sm:aspect-video sm:min-h-0";

function Dropzone({
  file,
  onFile,
}: {
  file: File | null;
  onFile: (file: File) => void;
}) {
  const inputId = useId();
  const [over, setOver] = useState(false);
  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    setOver(true);
  }, []);
  const onDragLeave = useCallback(() => setOver(false), []);
  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setOver(false);
      const [dropped] = event.dataTransfer.files;
      if (dropped) {
        onFile(dropped);
      }
    },
    [onFile]
  );
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const chosen = event.target.files?.[0];
      if (chosen) {
        onFile(chosen);
      }
    },
    [onFile]
  );
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a drop target; the file input inside it is the keyboard path.
    <label
      className={cn(
        FRAME,
        "group border-border hover:border-input cursor-pointer items-center justify-center gap-3 border p-6 text-center transition-colors duration-150 has-focus-visible:outline-3 has-focus-visible:outline-(--focus-ring)",
        over && "border-primary bg-card"
      )}
      htmlFor={inputId}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ containerType: "size" }}
    >
      <CropGuide />
      <input
        accept="video/*"
        className="sr-only"
        id={inputId}
        onChange={onChange}
        type="file"
      />
      {file ? (
        <>
          <FileVideo aria-hidden className="text-primary relative size-6" />
          <span className="condensed relative max-w-full truncate text-[17px] font-semibold">
            {file.name}
          </span>
          <span className="text-muted-foreground relative text-[13px]">
            {mb(file.size)}. Ready to upload. Choose another file to replace it.
          </span>
        </>
      ) : (
        <>
          <UploadIcon
            aria-hidden
            className="text-muted-foreground relative size-6"
          />
          <span className="relative text-[17px] font-semibold">
            <span className="sm:hidden">Choose a video</span>
            <span className="hidden sm:inline">Drop a video here</span>
          </span>
          <span className="text-muted-foreground relative text-[13px] sm:max-w-[calc((100cqh-32px)*9/16-24px)]">
            <span className="hidden sm:inline">
              or{" "}
              <span className="text-foreground decoration-input group-hover:decoration-foreground underline underline-offset-4">
                choose a file
              </span>
              .{" "}
            </span>
            A podcast, talk, webinar or stream.
          </span>
        </>
      )}
    </label>
  );
}

function Sending({
  fileName,
  loaded,
  total,
  cancel,
}: {
  fileName: string;
  loaded: number;
  total: number;
  cancel: () => void;
}) {
  const percent = total > 0 ? Math.floor((loaded / total) * PERCENT) : 0;
  const done = loaded >= total;
  return (
    <section
      aria-label="Upload"
      className={cn(FRAME, "justify-end gap-5 p-5 sm:p-8")}
      style={{ containerType: "size" }}
    >
      <CropGuide />
      <div className="bg-viewer relative flex flex-col gap-5 pt-5">
        <div className="flex items-start gap-3">
          <FileVideo
            aria-hidden
            className="text-muted-foreground mt-0.5 size-5 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <p className="condensed truncate text-[17px] font-semibold">
              {fileName}
            </p>
            <p className="tnum text-faint mt-0.5 text-[13px]">{mb(total)}</p>
          </div>
          <span className="tnum text-[28px] leading-none font-semibold tracking-[-0.02em]">
            {percent}
            <span className="text-faint text-[15px]">%</span>
          </span>
        </div>
        <Progress
          aria-label="Upload progress"
          className="[&_[data-slot=progress-track]]:h-1.5"
          value={percent}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            aria-live="polite"
            className="tnum text-muted-foreground text-[13px]"
          >
            {done
              ? "Upload complete. Starting the job…"
              : `${mb(loaded)} of ${mb(total)} uploaded. Keep this tab open.`}
          </p>
          <Button disabled={done} onClick={cancel} variant="outline">
            <X aria-hidden />
            Cancel upload
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * XHR rather than fetch because only XHR reports upload progress in every
 * browser. The body is the File itself, so the browser streams it from disk
 * and sets Content-Length.
 */
function uploadVideo(
  form: { file: File; clipCount: string; language: string },
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal
): Promise<string> {
  const params = new URLSearchParams({
    clipCount: form.clipCount,
    language: form.language,
    name: form.file.name,
  });
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/jobs?${params}`);
  xhr.responseType = "json";
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => xhr.abort());
    xhr.upload.addEventListener("progress", (event) =>
      onProgress(event.loaded, event.total)
    );
    xhr.addEventListener("load", () => {
      const body = xhr.response as { jobId?: string; error?: string } | null;
      if (xhr.status === 201 && body?.jobId) {
        resolve(body.jobId);
      } else {
        reject(
          new Error(body?.error ?? `Upload failed with status ${xhr.status}.`)
        );
      }
    });
    xhr.addEventListener("abort", () => reject(new Error("Upload canceled.")));
    xhr.addEventListener("error", () =>
      reject(
        new Error(
          "The upload was interrupted. Check your connection and try again."
        )
      )
    );
    xhr.send(form.file);
  });
}
