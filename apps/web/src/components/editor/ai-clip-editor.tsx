// biome-ignore-all lint/performance/noJsxPropsBind: nothing here is memoized and the editor re-renders every frame while playing, so stable handlers would save nothing.

import type { AppRouter } from "@clipradar/api/routers/index";
import {
  type CaptionRow,
  captionRows,
  editCaption,
} from "@clipradar/db/captions";
import {
  type Capability,
  DEFAULTS,
  type EditDraft,
  EFFECT_PRESETS,
  FPS,
  type Issue,
  issuesFor,
  LIMITS,
  type Quality,
  type Range,
  type Segment,
  type SourceRef,
  TRANSITIONS,
} from "@clipradar/db/editor";
import { sameSource, schedule } from "@clipradar/db/timeline";
import { Button } from "@clipradar/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@clipradar/ui/components/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import type { inferRouterOutputs } from "@trpc/server";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Captions,
  ChevronLeft,
  CircleCheck,
  Clapperboard,
  Crosshair,
  Download,
  Eraser,
  FastForward,
  Film,
  Image as ImageIcon,
  Music2,
  Pause,
  Play,
  Plus,
  Redo2,
  Rewind,
  Scissors,
  SkipBack,
  SkipForward,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  createElement,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AiClipPreview } from "@/components/editor/ai-clip-preview";
import { AiClipTimeline } from "@/components/editor/ai-clip-timeline";
import { usePoster } from "@/components/editor/clip-posters";
import {
  anchorKey,
  change,
  clamp,
  type Draft,
  type DraftOwner,
  draftKey,
  type History,
  newestDraft,
  open,
  redo,
  rounded,
  type Selection,
  sameDoc,
  stageFor,
  undo,
  updateSegment,
  uuid,
} from "@/lib/edit-doc";
import { tenths, timecode } from "@/lib/format";
import { useTRPC } from "@/utils/trpc";

import "./ai-clip-editor.css";

const TABS = [
  { id: "Trim", icon: Clapperboard },
  { id: "Split", icon: Scissors },
  { id: "Transitions", icon: ArrowLeftRight },
  { id: "Captions", icon: Captions },
  { id: "Text", icon: Type },
  { id: "Images", icon: ImageIcon },
  { id: "Audio", icon: Music2 },
  { id: "Effects", icon: Sparkles },
  { id: "Watermark", icon: Eraser },
  { id: "Export", icon: Download },
] as const;
type Tab = (typeof TABS)[number]["id"];
const CLIP_TABS: readonly Tab[] = ["Trim", "Split", "Transitions", "Captions"];
const ASPECTS = ["9:16", "16:9", "1:1"] as const;
const ASPECT_TITLE = {
  "9:16": "Portrait",
  "16:9": "Landscape",
  "1:1": "Square",
} as const;
const QUALITIES = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low / smaller file" },
] as const satisfies readonly { value: Quality; label: string }[];
const POLL_MS = 2500;
const NETWORK_RETRIES = 2;
const DRAFT_SAVE_MS = 300;
const CAPTION_MAX_CHARS = 240;
const ignore = () => undefined;

type ClipEditorView = inferRouterOutputs<AppRouter>["clips"]["editor"];
type VersionView = inferRouterOutputs<AppRouter>["clips"]["versions"][number];

const versionSrc = (clipId: string, number: number) =>
  `/api/clips/${clipId}?v=${number}`;
const versionDownload = (clipId: string, number: number) =>
  `${versionSrc(clipId, number)}&download=1`;

function useVersionsOptions(clipId: string) {
  const trpc = useTRPC();
  return trpc.clips.versions.queryOptions(
    { id: clipId },
    {
      refetchInterval: (query) =>
        query.state.data?.some((version) => version.active) ? POLL_MS : false,
    }
  );
}

const noSubscribe = () => ignore;

export function AiClipEditor({
  ownerId,
  clipId,
  onClose,
}: {
  ownerId: string;
  clipId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const editor = useQuery(
    trpc.clips.editor.queryOptions(
      { id: clipId },
      { staleTime: Number.POSITIVE_INFINITY }
    )
  );
  const versions = useQuery(useVersionsOptions(clipId));
  const hydrated = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
  const failed = editor.isError || versions.isError;
  return (
    <main aria-labelledby="clip-editor-title" className="clip-editor">
      {editor.data && versions.data && hydrated ? (
        <Workspace
          onClose={onClose}
          ownerId={ownerId}
          versions={versions.data}
          view={editor.data}
        />
      ) : (
        <div className="ce-loading">
          <h1 id="clip-editor-title">Video editor</h1>
          <button className="ce-button" onClick={onClose} type="button">
            Close
          </button>
          {failed ? (
            <p role="alert">
              Could not load the editor.{" "}
              <button
                className="ce-button"
                onClick={() => {
                  editor.refetch();
                  versions.refetch();
                }}
                type="button"
              >
                Retry
              </button>
            </p>
          ) : (
            <p role="status">Loading your clips…</p>
          )}
        </div>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: every caller passes its control as children.
    <label className="ce-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 300,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        max={max}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
        step={step}
        type="number"
        value={Number.isFinite(value) ? rounded(value) : ""}
      />
    </Field>
  );
}

function RangeFields({
  value,
  total,
  onChange,
}: {
  value: Range;
  total: number;
  onChange: (value: Range) => void;
}) {
  return (
    <div className="ce-two">
      <NumberField
        label="Start (s)"
        max={total}
        onChange={(start) => onChange({ start, end: value.end })}
        value={value.start}
      />
      <NumberField
        label="End (s)"
        max={total}
        onChange={(end) => onChange({ start: value.start, end })}
        value={value.end}
      />
    </div>
  );
}

function AssetThumb({
  url,
  at,
  duration,
}: {
  url: string;
  at: number;
  duration: number;
}) {
  const poster = usePoster(url, at);
  return (
    <div className="ce-asset-thumb">
      {poster ? (
        <img alt="" height={52} src={poster} width={52} />
      ) : (
        <Film size={20} />
      )}
      <small>{timecode(duration)}</small>
    </div>
  );
}

interface Tool {
  can: (capability: Capability) => boolean;
  captions: readonly CaptionRow[];
  edit: (next: EditDraft, key?: string | null) => void;
  exportBlocked: boolean;
  exportVersion: () => void;
  index: number;
  invalid: ReadonlySet<string>;
  reset: () => void;
  segment: Segment;
  select: (selection: Selection) => void;
  selected: Selection;
  settings: EditDraft;
  sourceDuration: number;
  time: number;
  total: number;
}

function Later({ need, tool }: { need: Capability; tool: Tool }) {
  return tool.can(need) ? null : (
    <p className="ce-muted">Available in stage {stageFor(need)}.</p>
  );
}

function TrimTool({ tool }: { tool: Tool }) {
  const { settings, segment, index, can } = tool;
  const update = (patch: Partial<Segment>, key: string | null) =>
    tool.edit(updateSegment(settings, segment.id, patch), key);
  return (
    <>
      <RangeFields
        onChange={(range) => update(range, `trim:${segment.id}`)}
        total={tool.sourceDuration}
        value={segment}
      />
      <p className="ce-muted">
        Drag the clip edges in the timeline, or enter exact source times. Keep
        at least 0.25 seconds per segment.
      </p>
      <fieldset className="ce-fieldset" disabled={!can("timeline")}>
        <div className="ce-actions">
          <button className="ce-button" disabled={index === 0} type="button">
            <ArrowUp size={14} />
            Earlier
          </button>
          <button
            className="ce-button"
            disabled={index === settings.segments.length - 1}
            type="button"
          >
            <ArrowDown size={14} />
            Later
          </button>
          <button
            className="ce-button"
            disabled={settings.segments.length === 1}
            type="button"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </fieldset>
      <Later need="timeline" tool={tool} />
      <h3>Framing</h3>
      <Field label="Horizontal crop">
        <input
          max="1"
          min="0"
          onChange={(e) =>
            update({ cropX: Number(e.target.value) }, `crop:${segment.id}`)
          }
          step="0.01"
          type="range"
          value={segment.cropX}
        />
      </Field>
      <fieldset className="ce-fieldset" disabled={!can("output")}>
        <Field label="Vertical crop">
          <input
            max="1"
            min="0"
            onChange={(e) =>
              update({ cropY: Number(e.target.value) }, `crop:${segment.id}`)
            }
            step="0.01"
            type="range"
            value={segment.cropY}
          />
        </Field>
      </fieldset>
      <Later need="output" tool={tool} />
      <button
        className="ce-button"
        onClick={() =>
          update({ cropX: DEFAULTS.cropX, cropY: DEFAULTS.cropY }, null)
        }
        type="button"
      >
        Center crop
      </button>
    </>
  );
}

function SplitTool({ tool }: { tool: Tool }) {
  return (
    <>
      <fieldset className="ce-fieldset" disabled={!tool.can("timeline")}>
        <button className="ce-button" type="button">
          <Scissors size={15} />
          Split at playhead · {tenths(tool.time)}
        </button>
        <NumberField
          label="Split every (seconds)"
          max={300}
          min={0.25}
          onChange={ignore}
          value={5}
        />
        <button className="ce-button" type="button">
          Split by interval
        </button>
      </fieldset>
      <Later need="timeline" tool={tool} />
      <h3>Automatic detection</h3>
      <fieldset className="ce-fieldset" disabled={!tool.can("detection")}>
        <NumberField
          label="Scene sensitivity threshold"
          max={0.95}
          min={0.05}
          onChange={ignore}
          step={0.05}
          value={0.35}
        />
        <button className="ce-button" type="button">
          Detect scene changes
        </button>
        <NumberField
          label="Silence threshold (dB)"
          max={-5}
          min={-70}
          onChange={ignore}
          step={1}
          value={-35}
        />
        <NumberField
          label="Minimum pause (s)"
          max={5}
          min={0.1}
          onChange={ignore}
          value={0.35}
        />
        <button className="ce-button" type="button">
          Detect speech pauses
        </button>
      </fieldset>
      <Later need="detection" tool={tool} />
    </>
  );
}

function TransitionsTool({ tool }: { tool: Tool }) {
  const { segment, index } = tool;
  return (
    <>
      <p className="ce-muted">
        The transition joins this clip to the previous clip. Overlap shortens
        the timeline.
      </p>
      <fieldset className="ce-fieldset" disabled={!tool.can("transitions")}>
        <Field label="Transition">
          <select
            disabled={index === 0}
            onChange={ignore}
            value={segment.transition.kind}
          >
            {["cut", ...TRANSITIONS].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </Field>
        <NumberField
          label="Overlap duration (s)"
          max={2}
          min={0.05}
          onChange={ignore}
          step={0.05}
          value={
            segment.transition.kind === "cut"
              ? 0.25
              : segment.transition.duration
          }
        />
      </fieldset>
      {index === 0 ? (
        <p className="ce-muted">Select a later clip to add a transition.</p>
      ) : null}
      <Later need="transitions" tool={tool} />
    </>
  );
}

function rowText(segment: Segment, row: CaptionRow): string {
  const key = anchorKey(row.anchor);
  const pinned = segment.captions.find(
    (edit) => anchorKey(edit.anchor) === key
  );
  return (pinned?.lines ?? row.lines).join("\n");
}

function CaptionsTool({ tool }: { tool: Tool }) {
  const { settings, segment, selected } = tool;
  const setCaptions = (
    row: CaptionRow,
    edit: Parameters<typeof editCaption>[2],
    key: string | null
  ) =>
    tool.edit(
      updateSegment(settings, segment.id, {
        captions: editCaption(segment.captions, row, edit),
      }),
      key
    );
  return (
    <>
      <label className="ce-check">
        <input
          checked={settings.captionsEnabled}
          onChange={(e) =>
            tool.edit({ ...settings, captionsEnabled: e.target.checked })
          }
          type="checkbox"
        />
        Show editable captions
      </label>
      <p className="ce-muted">
        Times follow the selected source clip. Splitting and reordering preserve
        each clip's caption timing.
      </p>
      {tool.captions.map((row, i) => {
        const key = anchorKey(row.anchor);
        const isSelected =
          selected.type === "caption" && anchorKey(selected.anchor) === key;
        return (
          <div
            className={`ce-cue ${isSelected ? "is-selected" : ""}`}
            key={key}
          >
            <Field label={`Caption ${i + 1}`}>
              <textarea
                aria-invalid={tool.invalid.has(key)}
                maxLength={CAPTION_MAX_CHARS}
                onChange={(e) =>
                  setCaptions(
                    row,
                    { kind: "text", text: e.target.value },
                    `caption:${key}`
                  )
                }
                onFocus={() =>
                  tool.select({
                    type: "caption",
                    segmentId: segment.id,
                    anchor: row.anchor,
                  })
                }
                placeholder="Hidden. Type to show it again."
                rows={2}
                value={rowText(segment, row)}
              />
            </Field>
            <fieldset
              className="ce-fieldset"
              disabled={!tool.can("captionTiming")}
            >
              <RangeFields
                onChange={(range) =>
                  setCaptions(row, { kind: "timing", range }, `caption:${key}`)
                }
                total={tool.sourceDuration}
                value={row}
              />
            </fieldset>
            {row.lines.length > 0 ? (
              <button
                aria-label={`Remove caption ${i + 1}`}
                className="ce-button"
                onClick={() =>
                  setCaptions(row, { kind: "text", text: "" }, null)
                }
                type="button"
              >
                <Trash2 size={13} />
                Remove
              </button>
            ) : null}
            {row.edited ? (
              <button
                aria-label={`Restore caption ${i + 1}`}
                className="ce-button"
                onClick={() => setCaptions(row, { kind: "restore" }, null)}
                type="button"
              >
                Restore
              </button>
            ) : null}
          </div>
        );
      })}
      <button
        className="ce-button"
        disabled={!tool.can("captionTiming")}
        type="button"
      >
        <Plus size={14} />
        Add caption
      </button>
      <Later need="captionTiming" tool={tool} />
    </>
  );
}

function TextTool({ tool }: { tool: Tool }) {
  return (
    <>
      <fieldset className="ce-fieldset" disabled={!tool.can("compositing")}>
        <button className="ce-button" type="button">
          <Type size={15} />
          Add text
        </button>
      </fieldset>
      <Later need="compositing" tool={tool} />
    </>
  );
}

function ImagesTool({ tool }: { tool: Tool }) {
  return (
    <>
      <p className="ce-muted">
        Upload an image in Media, then choose Overlay. Drag its frame in the
        preview to move or resize it.
      </p>
      <Later need="compositing" tool={tool} />
    </>
  );
}

function AudioTool({ tool }: { tool: Tool }) {
  const { segment } = tool;
  return (
    <>
      <fieldset className="ce-fieldset" disabled={!tool.can("compositing")}>
        <h3>Selected clip audio</h3>
        <Field label={`Source volume (${Math.round(segment.volume * 100)}%)`}>
          <input
            max="2"
            min="0"
            onChange={ignore}
            step="0.05"
            type="range"
            value={segment.volume}
          />
        </Field>
        <button className="ce-button" type="button">
          {segment.volume ? "Mute source" : "Unmute source"}
        </button>
        <p className="ce-muted">Volume above 100% is applied in the export.</p>
        <h3>Music / audio track</h3>
        <Field label="Audio asset">
          <select onChange={ignore} value="">
            <option value="">No added audio</option>
          </select>
        </Field>
      </fieldset>
      <Later need="compositing" tool={tool} />
    </>
  );
}

function EffectsTool({ tool }: { tool: Tool }) {
  const { effect } = tool.settings;
  return (
    <>
      <fieldset className="ce-fieldset" disabled={!tool.can("compositing")}>
        <Field label="Effect preset">
          <select onChange={ignore} value={effect?.preset ?? "none"}>
            {["none", ...EFFECT_PRESETS].map((preset) => (
              <option key={preset}>{preset}</option>
            ))}
          </select>
        </Field>
        <RangeFields
          onChange={ignore}
          total={tool.total}
          value={effect ?? { start: 0, end: tool.total }}
        />
        <p className="ce-muted">
          Effects are applied to the video before image and text overlays.
        </p>
      </fieldset>
      <Later need="compositing" tool={tool} />
    </>
  );
}

function WatermarkTool({ tool }: { tool: Tool }) {
  return (
    <>
      <p className="ce-muted">
        Blend a rectangular logo area with the surrounding pixels. The box marks
        the area; the removal appears in the saved export.
      </p>
      <fieldset className="ce-fieldset" disabled={!tool.can("compositing")}>
        <label className="ce-check">
          <input
            checked={tool.settings.watermark !== null}
            onChange={ignore}
            type="checkbox"
          />
          Remove an area
        </label>
      </fieldset>
      <Later need="compositing" tool={tool} />
    </>
  );
}

function ExportTool({ tool }: { tool: Tool }) {
  const { settings } = tool;
  return (
    <>
      <Field label="File name">
        <input
          maxLength={LIMITS.nameChars}
          onChange={(e) =>
            tool.edit({ ...settings, name: e.target.value }, "name")
          }
          value={settings.name}
        />
      </Field>
      <fieldset className="ce-fieldset" disabled={!tool.can("output")}>
        <Field label="Frame rate">
          <select
            onChange={(e) =>
              tool.edit({
                ...settings,
                fps:
                  FPS.find((f) => f === Number(e.target.value)) ?? settings.fps,
              })
            }
            value={settings.fps}
          >
            {FPS.map((f) => (
              <option key={f} value={f}>
                {f} FPS
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quality">
          <select
            onChange={(e) =>
              tool.edit({
                ...settings,
                quality:
                  QUALITIES.find((q) => q.value === e.target.value)?.value ??
                  settings.quality,
              })
            }
            value={settings.quality}
          >
            {QUALITIES.map((q) => (
              <option key={q.value} value={q.value}>
                {q.label}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
      <Later need="output" tool={tool} />
      <p className="ce-muted">
        MP4 with H.264 video and AAC audio. The short edge is 720 pixels. Each
        export saves a new version and keeps the original.
      </p>
      <button
        className="ce-button ce-primary"
        disabled={tool.exportBlocked}
        onClick={tool.exportVersion}
        type="button"
      >
        Export new version
      </button>
      <button className="ce-button" onClick={tool.reset} type="button">
        Reset to original clip
      </button>
    </>
  );
}

const TOOLS: Record<Tab, (props: { tool: Tool }) => ReactNode> = {
  Trim: TrimTool,
  Split: SplitTool,
  Transitions: TransitionsTool,
  Captions: CaptionsTool,
  Text: TextTool,
  Images: ImagesTool,
  Audio: AudioTool,
  Effects: EffectsTool,
  Watermark: WatermarkTool,
  Export: ExportTool,
};

function VersionsPanel({
  clipId,
  versions,
  onClose,
  onLoad,
  onPreview,
}: {
  clipId: string;
  versions: readonly VersionView[];
  onClose: () => void;
  onLoad: (version: VersionView) => void;
  onPreview: (version: VersionView) => void;
}) {
  return (
    <>
      <div className="ce-panel-title">
        <strong>Saved versions</strong>
        <button
          aria-label="Close versions"
          className="ce-icon"
          onClick={onClose}
          type="button"
        >
          <X size={16} />
        </button>
      </div>
      <div className="ce-version-list">
        {versions.length === 0 ? (
          <p className="ce-muted" style={{ padding: "0 14px" }}>
            Export a version to keep its settings and finished video here.
          </p>
        ) : null}
        {versions.map((item) => (
          <article className="ce-version" key={item.number}>
            <strong>Version {item.number}</strong>
            <span className={`ce-status ${item.status}`}>{item.status}</span>
            <p>{new Date(item.createdAt).toLocaleString()}</p>
            {item.status === "failed" ? (
              <p className="ce-error">
                {item.error ?? "This version did not render."} Load these
                settings and export again.
              </p>
            ) : null}
            <div className="ce-actions">
              <button
                className="ce-button"
                onClick={() => onLoad(item)}
                type="button"
              >
                Load settings
              </button>
              {item.status === "ready" ? (
                <>
                  <button
                    className="ce-button"
                    onClick={() => onPreview(item)}
                    type="button"
                  >
                    Preview
                  </button>
                  <a
                    className="ce-button"
                    download
                    href={versionDownload(clipId, item.number)}
                  >
                    Download MP4
                  </a>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

interface TranscriptCue {
  anchor: CaptionRow["anchor"];
  at: number;
  key: string;
  segmentId: string;
  text: string;
  until: number;
}

function TranscriptPanel({
  cues,
  time,
  onPick,
}: {
  cues: readonly TranscriptCue[];
  time: number;
  onPick: (cue: TranscriptCue) => void;
}) {
  return (
    <div className="ce-transcript">
      {cues.length === 0 ? (
        <p className="ce-muted">
          This clip has no caption cues. Add them in the Captions tool.
        </p>
      ) : null}
      {cues.map((cue) => (
        <button
          className={`ce-cue-row ${time >= cue.at && time < cue.until ? "is-now" : ""}`}
          key={cue.key}
          onClick={() => onPick(cue)}
          type="button"
        >
          <span>{tenths(cue.at)}</span>
          {cue.text}
        </button>
      ))}
      <p className="ce-muted">
        Cues follow their source clip, so splitting and reordering keeps them in
        place. Edit the wording in the Captions tool.
      </p>
    </div>
  );
}

function MediaPanel({ view, tool }: { view: ClipEditorView; tool: Tool }) {
  return (
    <>
      <div className="ce-panel-title">
        <Film size={15} />
        <strong>Media</strong>
        <span>{view.presets.length}</span>
      </div>
      <button
        className="ce-button ce-upload"
        disabled={!tool.can("imageAudioUpload")}
        type="button"
      >
        <Upload size={15} />
        Upload media
      </button>
      <p className="ce-muted">
        Videos, images and audio, up to 100 MB. Drag one onto a timeline track
        to place it.
      </p>
      <Later need="imageAudioUpload" tool={tool} />
      <div className="ce-asset-list">
        {view.presets.map((preset) => (
          <article className="ce-asset" key={preset.clipId}>
            <AssetThumb
              at={preset.range.start}
              duration={preset.range.end - preset.range.start}
              url={view.jobPreviewUrl}
            />
            <p title={preset.title}>{preset.title}</p>
            <div className="ce-asset-actions">
              <button
                aria-label={`Add ${preset.title} to timeline`}
                disabled={!tool.can("timeline")}
                title={
                  tool.can("timeline")
                    ? undefined
                    : `Available in stage ${stageFor("timeline")}`
                }
                type="button"
              >
                <Plus size={13} />
                Timeline
              </button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function LeaveDialog({
  open: isOpen,
  onStay,
  onLeave,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onStay();
        }
      }}
      open={isOpen}
    >
      <DialogContent
        className="gap-5 p-5 sm:max-w-[400px]"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">
            Leave the editor?
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-[13px]">
            This browser blocks saving drafts, so changes since your last export
            will be lost. Export them first to keep them as a version.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onStay} variant="secondary">
            Keep editing
          </Button>
          <Button onClick={onLeave} variant="destructive">
            Leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function restore(
  owner: DraftOwner,
  versions: readonly VersionView[],
  original: EditDraft
): Draft {
  try {
    const draft = newestDraft(localStorage, owner);
    if (draft) {
      return draft;
    }
  } catch {
    // Storage is blocked; the header says the draft isn't kept.
  }
  return { doc: versions[0]?.settings ?? original, touched: 0 };
}

const totalOf = (doc: EditDraft) => {
  const { totalFrames, fps } = schedule(doc);
  return totalFrames / fps;
};

function invalidCaptions(
  settings: EditDraft,
  issues: readonly Issue[]
): ReadonlySet<string> {
  return new Set(
    issues.flatMap(({ path: [field, at, list, editAt] }) => {
      const edit =
        field === "segments" &&
        list === "captions" &&
        typeof at === "number" &&
        typeof editAt === "number"
          ? settings.segments[at]?.captions[editAt]
          : undefined;
      return edit ? [anchorKey(edit.anchor)] : [];
    })
  );
}

type ShortcutAction =
  | "undo"
  | "redo"
  | "back"
  | "forward"
  | "start"
  | "end"
  | "close"
  | "play"
  | "split";
const KEYS: Record<string, ShortcutAction> = {
  ArrowLeft: "back",
  ArrowRight: "forward",
  Home: "start",
  End: "end",
  Escape: "close",
};
const KEYS_OFF_CONTROLS: Record<string, ShortcutAction> = {
  " ": "play",
  s: "split",
  S: "split",
};

function shortcutFor(
  event: KeyboardEvent<HTMLDivElement>,
  actions: Record<ShortcutAction, () => void>
): (() => void) | undefined {
  const { target } = event;
  if (
    !(target instanceof HTMLElement) ||
    target.matches("input,textarea,select")
  ) {
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    return event.shiftKey ? actions.redo : actions.undo;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  const onControl = target.matches('button,a,[role="button"]');
  const action =
    KEYS[event.key] ?? (onControl ? undefined : KEYS_OFF_CONTROLS[event.key]);
  return action && actions[action];
}

function exportLabel(active: boolean, pending: boolean): string {
  if (active) {
    return "Exporting…";
  }
  return pending ? "Saving…" : "Export new version";
}

function transcriptCues(
  settings: EditDraft,
  plan: ReturnType<typeof schedule>,
  captions: ReadonlyMap<string, readonly CaptionRow[]>
): TranscriptCue[] {
  return settings.segments
    .flatMap((item, i): TranscriptCue[] => {
      const span = plan.spans[i];
      if (!span) {
        return [];
      }
      const offset = span.startFrame / plan.fps - item.start;
      return (captions.get(item.id) ?? []).flatMap((row) => {
        const from = Math.max(row.start, item.start);
        const to = Math.min(row.end, item.end);
        if (to <= from || row.lines.length === 0) {
          return [];
        }
        return [
          {
            key: `${item.id}:${anchorKey(row.anchor)}`,
            segmentId: item.id,
            anchor: row.anchor,
            text: row.lines.join(" "),
            at: from + offset,
            until: to + offset,
          },
        ];
      });
    })
    .sort((a, b) => a.at - b.at);
}

function EditorHeader({
  title,
  draftSaved,
  canUndo,
  canRedo,
  showVersions,
  versionCount,
  exportBlocked,
  exportLabel: label,
  onClose,
  onUndo,
  onRedo,
  onToggleVersions,
  onExport,
}: {
  title: string;
  draftSaved: boolean;
  canUndo: boolean;
  canRedo: boolean;
  showVersions: boolean;
  versionCount: number;
  exportBlocked: boolean;
  exportLabel: string;
  onClose: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleVersions: () => void;
  onExport: () => void;
}) {
  return (
    <header className="ce-header">
      <button
        aria-label="Back to generated clips"
        className="ce-icon"
        onClick={onClose}
        type="button"
      >
        <ChevronLeft size={20} />
      </button>
      <div className="ce-heading">
        <h1 id="clip-editor-title">Video editor</h1>
        <p title={title}>{title}</p>
      </div>
      <span
        className="ce-draft"
        title={
          draftSaved
            ? "This draft is kept in this browser until you export."
            : "Local storage is blocked, so this draft is not kept."
        }
      >
        <CircleCheck size={13} />
        {draftSaved ? "Draft saved" : "Draft not saved"}
      </span>
      <div className="ce-group">
        <button
          aria-label="Undo"
          className="ce-icon"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo (Cmd/Ctrl+Z)"
          type="button"
        >
          <Undo2 size={16} />
        </button>
        <button
          aria-label="Redo"
          className="ce-icon"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo (Cmd/Ctrl+Shift+Z)"
          type="button"
        >
          <Redo2 size={16} />
        </button>
      </div>
      <button
        className={showVersions ? "ce-button is-active" : "ce-button"}
        onClick={onToggleVersions}
        type="button"
      >
        Versions <span>{versionCount}</span>
      </button>
      <button
        className="ce-button ce-primary"
        disabled={exportBlocked}
        onClick={onExport}
        type="button"
      >
        {label}
      </button>
    </header>
  );
}

function ControlsBar({
  time,
  total,
  rendered,
  playing,
  aspectRatio,
  can,
  onSeek,
  onPlay,
  onSplit,
  onRecenter,
  onAspect,
}: {
  time: number;
  total: number;
  rendered: boolean;
  playing: boolean;
  aspectRatio: EditDraft["aspectRatio"];
  can: (capability: Capability) => boolean;
  onSeek: (time: number) => void;
  onPlay: () => void;
  onSplit: () => void;
  onRecenter: () => void;
  onAspect: (aspectRatio: EditDraft["aspectRatio"]) => void;
}) {
  return (
    <div className="ce-controls">
      <div className="ce-controls-time">
        <strong>{tenths(time)}</strong>
        <span>/ {tenths(total)}</span>
        {rendered ? <em>Saved export</em> : null}
      </div>
      <div className="ce-transport">
        <button
          aria-label="Jump to start"
          className="ce-icon"
          onClick={() => onSeek(0)}
          title="Start (Home)"
          type="button"
        >
          <SkipBack size={16} />
        </button>
        <button
          aria-label="Back one second"
          className="ce-icon"
          onClick={() => onSeek(time - 1)}
          title="Back 1s (Shift+←)"
          type="button"
        >
          <Rewind size={16} />
        </button>
        <button
          aria-label={playing ? "Pause preview" : "Play preview"}
          className="ce-play"
          onClick={onPlay}
          title="Play / pause (Space)"
          type="button"
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          aria-label="Forward one second"
          className="ce-icon"
          onClick={() => onSeek(time + 1)}
          title="Forward 1s (Shift+→)"
          type="button"
        >
          <FastForward size={16} />
        </button>
        <button
          aria-label="Jump to end"
          className="ce-icon"
          onClick={() => onSeek(total)}
          title="End (End)"
          type="button"
        >
          <SkipForward size={16} />
        </button>
      </div>
      <div className="ce-controls-canvas">
        <button
          aria-label="Split at playhead"
          className="ce-icon"
          disabled={!can("timeline")}
          onClick={onSplit}
          title={`Split at playhead (S)${can("timeline") ? "" : ` · Available in stage ${stageFor("timeline")}`}`}
          type="button"
        >
          <Scissors size={15} />
        </button>
        <button
          aria-label="Recenter clip"
          className="ce-icon"
          onClick={onRecenter}
          title="Recenter this clip inside the canvas"
          type="button"
        >
          <Crosshair size={15} />
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: a set of toggle buttons, not a form section. */}
        <div
          aria-label="Canvas aspect ratio"
          className="ce-segmented"
          role="group"
        >
          {ASPECTS.map((ratio) => (
            <button
              aria-pressed={aspectRatio === ratio}
              disabled={!can("output")}
              key={ratio}
              onClick={() => onAspect(ratio)}
              title={ASPECT_TITLE[ratio]}
              type="button"
            >
              {ratio}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToolContent({
  tab,
  tool,
  sourceName,
  onPickSegment,
}: {
  tab: Tab;
  tool: Tool;
  sourceName: string;
  onPickSegment: (id: string) => void;
}) {
  const { settings, segment, index } = tool;
  return (
    <div className="ce-tool-content">
      <div className="ce-panel-title">
        <strong>{tab}</strong>
        {CLIP_TABS.includes(tab) ? (
          <span>
            Clip {index + 1} of {settings.segments.length}
          </span>
        ) : null}
      </div>
      {CLIP_TABS.includes(tab) ? (
        <Field label="Selected clip">
          <select
            onChange={(e) => onPickSegment(e.target.value)}
            value={segment.id}
          >
            {settings.segments.map((s, i) => (
              <option key={s.id} value={s.id}>
                {i + 1}. {sourceName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {createElement(TOOLS[tab], { tool })}
    </div>
  );
}

function Workspace({
  view,
  versions: initialVersions,
  ownerId,
  onClose,
}: {
  view: ClipEditorView;
  versions: readonly VersionView[];
  ownerId: string;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const versionsOptions = useVersionsOptions(view.clipId);
  const versions = useQuery(versionsOptions).data ?? initialVersions;
  const owner = useMemo(
    () => ({ userId: ownerId, jobId: view.jobId, clipId: view.clipId }),
    [ownerId, view.jobId, view.clipId]
  );
  const [actor] = useState(uuid);
  const [initial] = useState(() =>
    restore(owner, initialVersions, view.original)
  );
  const touched = useRef(initial.touched);
  const baseline = useRef<EditDraft>(initial.doc);
  const [history, setHistory] = useState<History>(() => open(initial.doc));
  const settings = history.present;
  const firstId = settings.segments[0]?.id ?? "";
  const [tab, setTab] = useState<Tab>("Trim");
  const [side, setSide] = useState<"media" | "transcript">("media");
  const [selected, setSelected] = useState<Selection>({
    type: "segment",
    id: firstId,
  });
  const [segmentId, setSegmentId] = useState(firstId);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rendered, setRendered] = useState<VersionView | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [notice, setNotice] = useState("");
  const [draftSaved, setDraftSaved] = useState(true);
  const workspace = useRef<HTMLDivElement>(null);
  const request = useRef<{ requestId: string; json: string } | null>(null);

  const can = (capability: Capability) =>
    view.capabilities.enabled.includes(capability);
  const words = useMemo(
    () => view.sources.flatMap((s) => ("words" in s ? s.words : [])),
    [view.sources]
  );
  const plan = useMemo(() => schedule(settings), [settings]);
  const total = plan.totalFrames / plan.fps;
  const index = Math.max(
    0,
    settings.segments.findIndex((s) => s.id === segmentId)
  );
  const segment = settings.segments[index] ?? settings.segments[0];
  const captions = useMemo(
    () => new Map(settings.segments.map((s) => [s.id, captionRows(words, s)])),
    [words, settings.segments]
  );
  const issues = useMemo(
    () => issuesFor(settings, view.sources, view.capabilities.stage),
    [settings, view.sources, view.capabilities.stage]
  );
  const valid = issues.length === 0;
  const active = versions.some((version) => version.active);
  const durationOf = (ref: SourceRef) => {
    const facts = view.sources.find((s) => sameSource(s.ref, ref));
    return facts?.kind === "image"
      ? LIMITS.maxImageSeconds
      : (facts?.duration ?? 0);
  };
  const mediaUrl = (ref: SourceRef) =>
    ref.kind === "job" ? view.jobPreviewUrl : null;

  useEffect(() => {
    workspace.current?.focus();
  }, []);

  useEffect(() => {
    const key = draftKey(owner, actor);
    const write = () => {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            touched: touched.current,
            doc: settings,
          } satisfies Draft)
        );
        return true;
      } catch {
        return false;
      }
    };
    const timer = window.setTimeout(
      () => setDraftSaved(write()),
      DRAFT_SAVE_MS
    );
    window.addEventListener("pagehide", write);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", write);
      write();
    };
  }, [owner, actor, settings]);

  const leave = useRef<{ saved: boolean; dirty: boolean }>({
    saved: true,
    dirty: false,
  });
  leave.current = {
    saved: draftSaved,
    dirty: !sameDoc(settings, baseline.current),
  };
  const mustAsk = useCallback(
    () => !leave.current.saved && leave.current.dirty,
    []
  );
  const blocker = useBlocker({
    shouldBlockFn: mustAsk,
    enableBeforeUnload: mustAsk,
    withResolver: true,
  });

  const submit = useMutation(
    trpc.clips.export.mutationOptions({
      retry: (failures, error) => !error.data && failures < NETWORK_RETRIES,
      onSuccess: (version, input) => {
        queryClient.setQueryData(versionsOptions.queryKey, (old) => [
          version,
          ...(old ?? []).filter((v) => v.number !== version.number),
        ]);
        request.current = null;
        baseline.current = input.settings;
        setShowVersions(true);
        setNotice(
          "Export queued. Your original remains unchanged. You can close this editor while it renders."
        );
      },
    })
  );

  const edit = (next: EditDraft, key: string | null = null) => {
    touched.current = Date.now();
    setHistory((h) => change(h, next, key, performance.now()));
    setRendered(null);
    setNotice("");
    setTime((t) => Math.min(t, totalOf(next)));
    submit.reset();
  };
  const step = (move: (h: History) => History) => {
    const next = move(history);
    if (next === history) {
      return;
    }
    touched.current = Date.now();
    setHistory(next);
    setRendered(null);
    setPlaying(false);
    setTime((t) => Math.min(t, totalOf(next.present)));
    const first = next.present.segments[0]?.id ?? "";
    setSegmentId(first);
    setSelected({ type: "segment", id: first });
  };
  const select = (selection: Selection) => {
    setSelected(selection);
    if (selection.type === "segment") {
      setSegmentId(selection.id);
      setTab("Trim");
    } else {
      setSegmentId(selection.segmentId);
      setTab("Captions");
    }
  };
  const load = (doc: EditDraft) => {
    edit(doc);
    const first = doc.segments[0]?.id ?? "";
    setSegmentId(first);
    setSelected({ type: "segment", id: first });
    setTime(0);
    setPlaying(false);
  };
  const exportVersion = () => {
    setPlaying(false);
    const json = JSON.stringify(settings);
    if (request.current?.json !== json) {
      request.current = { requestId: uuid(), json };
    }
    submit.mutate({
      id: view.clipId,
      requestId: request.current.requestId,
      settings,
    });
  };
  const seek = (value: number) => {
    setPlaying(false);
    setTime(clamp(value, 0, total));
    setRendered(null);
  };
  const play = () => {
    if (time >= total) {
      setTime(0);
    }
    setPlaying((v) => !v);
    setRendered(null);
  };
  const splitAtPlayhead = () => {
    if (!can("timeline")) {
      setNotice(`Splitting is available in stage ${stageFor("timeline")}.`);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? 1 : 0.1;
    const run = shortcutFor(event, {
      undo: () => step(undo),
      redo: () => step(redo),
      back: () => seek(time - by),
      forward: () => seek(time + by),
      start: () => seek(0),
      end: () => seek(total),
      close: onClose,
      play,
      split: splitAtPlayhead,
    });
    if (run) {
      event.preventDefault();
      run();
    }
  };

  if (!segment) {
    return null;
  }
  const pickSegment = (id: string) => {
    const i = settings.segments.findIndex((s) => s.id === id);
    const span = plan.spans[i];
    if (span) {
      setSegmentId(id);
      setSelected({ type: "segment", id });
      setTime(span.startFrame / plan.fps);
      setPlaying(false);
    }
  };
  const recenter = () =>
    edit(
      updateSegment(settings, segment.id, {
        cropX: DEFAULTS.cropX,
        cropY: DEFAULTS.cropY,
      })
    );
  const transcript = transcriptCues(settings, plan, captions);
  const tool: Tool = {
    can,
    captions: captions.get(segment.id) ?? [],
    edit,
    exportBlocked: !valid || active || submit.isPending,
    exportVersion,
    index,
    invalid: invalidCaptions(settings, issues),
    reset: () => load(view.original),
    segment,
    select,
    selected,
    settings,
    sourceDuration: durationOf(segment.source),
    time,
    total,
  };
  const failure = submit.error?.message ?? issues[0]?.message ?? null;

  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: keyboard shortcuts bubble up here from the editor's controls; the div is not a widget. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts bubble up here from the editor's controls; the div is not a widget. */}
      <div
        className="ce-workspace"
        onKeyDown={onKeyDown}
        ref={workspace}
        tabIndex={-1}
      >
        <EditorHeader
          canRedo={history.future.length > 0}
          canUndo={history.past.length > 0}
          draftSaved={draftSaved}
          exportBlocked={tool.exportBlocked}
          exportLabel={exportLabel(active, submit.isPending)}
          onClose={onClose}
          onExport={exportVersion}
          onRedo={() => step(redo)}
          onToggleVersions={() => setShowVersions((v) => !v)}
          onUndo={() => step(undo)}
          showVersions={showVersions}
          title={view.title}
          versionCount={versions.length}
        />
        {notice || failure ? (
          <div
            className={`ce-notice ${failure ? "ce-error" : ""}`}
            role="status"
          >
            {failure ?? notice}
          </div>
        ) : null}
        <div className="ce-main">
          <aside className="ce-assets">
            {/* biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form section. */}
            <div
              aria-label="Left panel"
              className="ce-side-tabs"
              data-tabs={2}
              role="group"
            >
              <button
                aria-pressed={side === "media"}
                className={side === "media" ? "is-active" : ""}
                onClick={() => setSide("media")}
                type="button"
              >
                <Film size={13} />
                Media
              </button>
              <button
                aria-pressed={side === "transcript"}
                className={side === "transcript" ? "is-active" : ""}
                onClick={() => setSide("transcript")}
                type="button"
              >
                <Captions size={13} />
                Transcript
              </button>
            </div>
            {side === "transcript" ? (
              <TranscriptPanel
                cues={transcript}
                onPick={(cue) => {
                  select({
                    type: "caption",
                    segmentId: cue.segmentId,
                    anchor: cue.anchor,
                  });
                  seek(cue.at);
                }}
                time={time}
              />
            ) : (
              <MediaPanel tool={tool} view={view} />
            )}
          </aside>
          <section aria-label="Video preview" className="ce-center">
            {rendered ? (
              <div className="ce-rendered">
                {/* biome-ignore lint/a11y/useMediaCaption: captions are burned into the exported frames. */}
                <video
                  aria-label="Saved export preview"
                  controls
                  playsInline
                  src={versionSrc(view.clipId, rendered.number)}
                />
                <button
                  className="ce-button"
                  onClick={() => setRendered(null)}
                  type="button"
                >
                  Back to editing
                </button>
              </div>
            ) : (
              <AiClipPreview
                captions={captions}
                mediaUrl={mediaUrl}
                onPlaying={setPlaying}
                onTime={setTime}
                playing={playing}
                schedule={plan}
                settings={settings}
                sourceName={view.title}
                time={time}
              />
            )}
            <ControlsBar
              aspectRatio={settings.aspectRatio}
              can={can}
              onAspect={(aspectRatio) => edit({ ...settings, aspectRatio })}
              onPlay={play}
              onRecenter={recenter}
              onSeek={seek}
              onSplit={splitAtPlayhead}
              playing={playing}
              rendered={rendered !== null}
              time={time}
              total={total}
            />
          </section>
          <aside className="ce-properties">
            {showVersions ? (
              <VersionsPanel
                clipId={view.clipId}
                onClose={() => setShowVersions(false)}
                onLoad={(version) => load(version.settings)}
                onPreview={(version) => {
                  setPlaying(false);
                  setRendered(version);
                }}
                versions={versions}
              />
            ) : (
              <ToolContent
                onPickSegment={pickSegment}
                sourceName={view.title}
                tab={tab}
                tool={tool}
              />
            )}
          </aside>
          <nav aria-label="Editing tools" className="ce-rail">
            {TABS.map(({ id, icon: Icon }) => (
              <button
                aria-pressed={!showVersions && tab === id}
                className={!showVersions && tab === id ? "is-active" : ""}
                key={id}
                onClick={() => {
                  setTab(id);
                  setShowVersions(false);
                }}
                title={id}
                type="button"
              >
                <Icon size={17} />
                {id}
              </button>
            ))}
          </nav>
        </div>
        <AiClipTimeline
          captions={captions}
          captionTimingLocked={
            can("captionTiming")
              ? undefined
              : `Available in stage ${stageFor("captionTiming")}`
          }
          durationOf={durationOf}
          mediaUrl={view.jobPreviewUrl}
          onChange={edit}
          onSeek={seek}
          onSelect={select}
          schedule={plan}
          segmentId={segment.id}
          selected={selected}
          settings={settings}
          sourceName={view.title}
          time={clamp(time, 0, total)}
        />
      </div>
      <LeaveDialog
        onLeave={() => blocker.proceed?.()}
        onStay={() => blocker.reset?.()}
        open={blocker.status === "blocked"}
      />
    </>
  );
}
