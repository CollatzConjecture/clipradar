// biome-ignore-all lint/performance/noJsxPropsBind: nothing here is memoized and the editor re-renders every frame while playing, so stable handlers would save nothing.
import { type CaptionRow, editCaption } from "@clipradar/db/captions";
import { type EditDraft, LIMITS, type SourceRef } from "@clipradar/db/editor";
import type { Schedule } from "@clipradar/db/timeline";
import {
  Captions,
  Film,
  Image as ImageIcon,
  Music2,
  Sparkles,
  Type,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";

import { usePoster } from "@/components/editor/clip-posters";
import {
  anchorKey,
  clamp,
  rounded,
  type Selection,
  updateSegment,
} from "@/lib/edit-doc";
import { tenths } from "@/lib/format";

const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
const MAX_TICKS = 12;
const MIN_VISIBLE_SECONDS = 5;
const NUDGE_SECONDS = 0.1;
const MIN_DRAG_SECONDS = 0.1;
const tickStep = (total: number) =>
  STEPS.find((step) => total / step <= MAX_TICKS) ?? 300;
function tick(value: number) {
  const fraction = value % 1 !== 0;
  return `${Math.floor(value / 60)}:${(value % 60)
    .toFixed(fraction ? 1 : 0)
    .padStart(fraction ? 4 : 2, "0")}`;
}

function BarThumb({ url, at }: { url: string; at: number }) {
  const poster = usePoster(url, at);
  return poster ? (
    <img
      alt=""
      className="ce-bar-thumb"
      draggable={false}
      height={18}
      src={poster}
      width={18}
    />
  ) : (
    <span className="ce-bar-thumb" />
  );
}

type DragMode = "start" | "end" | "move";

function Bar({
  label,
  start,
  end,
  total,
  active,
  color,
  movable = false,
  locked,
  onSelect,
  onRange,
  children,
  thumb,
}: {
  label: string;
  start: number;
  end: number;
  total: number;
  active: boolean;
  color: string;
  movable?: boolean;
  locked?: string;
  onSelect: () => void;
  onRange: (start: number, end: number) => void;
  children?: ReactNode;
  thumb?: ReactNode;
}) {
  const bar = useRef<HTMLDivElement>(null);
  function drag(event: PointerEvent, mode: DragMode) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onSelect();
    const lane = bar.current?.parentElement;
    if (locked || !lane) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const { width } = lane.getBoundingClientRect();
    const origin = event.clientX;
    target.setPointerCapture(event.pointerId);
    const move = (e: globalThis.PointerEvent) => {
      const delta = ((e.clientX - origin) / width) * total;
      const a =
        mode === "end"
          ? start
          : clamp(
              start + delta,
              0,
              mode === "move" ? total - (end - start) : end - MIN_DRAG_SECONDS
            );
      let b = clamp(end + delta, start + MIN_DRAG_SECONDS, total);
      if (mode === "start") {
        b = end;
      } else if (mode === "move") {
        b = a + end - start;
      }
      onRange(rounded(a), rounded(b));
    };
    const done = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", done);
      target.removeEventListener("pointercancel", done);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", done);
    target.addEventListener("pointercancel", done);
  }
  const nudge = (event: KeyboardEvent, edge: "start" | "end") => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const by = event.key === "ArrowRight" ? NUDGE_SECONDS : -NUDGE_SECONDS;
    if (edge === "start") {
      onRange(
        rounded(clamp(start + by, 0, end - LIMITS.minSegmentSeconds)),
        end
      );
    } else {
      onRange(
        start,
        rounded(clamp(end + by, start + LIMITS.minSegmentSeconds, total))
      );
    }
  };
  return (
    <div
      className={`ce-bar ${active ? "is-selected" : ""}`}
      ref={bar}
      style={{
        left: `${(start / total) * 100}%`,
        width: `${((end - start) / total) * 100}%`,
        background: color,
      }}
    >
      <button
        aria-label={`Trim start: ${label}`}
        className="ce-trim-handle"
        disabled={locked !== undefined}
        onKeyDown={(e) => nudge(e, "start")}
        onPointerDown={(e) => drag(e, "start")}
        title={locked}
        type="button"
      >
        │
      </button>
      <button
        className="ce-bar-label"
        onClick={onSelect}
        onPointerDown={movable ? (e) => drag(e, "move") : undefined}
        title={label}
        type="button"
      >
        {thumb}
        {label}
        {children}
      </button>
      <button
        aria-label={`Trim end: ${label}`}
        className="ce-trim-handle"
        disabled={locked !== undefined}
        onKeyDown={(e) => nudge(e, "end")}
        onPointerDown={(e) => drag(e, "end")}
        title={locked}
        type="button"
      >
        │
      </button>
    </div>
  );
}

function Track({
  label,
  icon: Icon,
  children,
  onSeek,
}: {
  label: string;
  icon: typeof Film;
  children: ReactNode;
  onSeek: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const filled = Array.isArray(children)
    ? children.some(Boolean)
    : Boolean(children);
  return (
    <div className={`ce-track ${filled ? "" : "is-empty"}`}>
      <div className="ce-track-label">
        <Icon size={12} />
        {label}
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a click seeks; the ruler's range input is the keyboard way to seek. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click seeks; the ruler's range input is the keyboard way to seek. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a click seeks; the ruler's range input is the keyboard way to seek. */}
      <div className="ce-track-lane" onClick={onSeek}>
        {children}
      </div>
    </div>
  );
}

export interface TimelineProps {
  captions: ReadonlyMap<string, readonly CaptionRow[]>;
  captionTimingLocked: string | undefined;
  durationOf: (source: SourceRef) => number;
  mediaUrl: string;
  onChange: (settings: EditDraft, key: string) => void;
  onSeek: (time: number) => void;
  onSelect: (selection: Selection) => void;
  schedule: Schedule;
  segmentId: string;
  selected: Selection;
  settings: EditDraft;
  sourceName: string;
  time: number;
}

export function AiClipTimeline({
  settings,
  schedule,
  captions,
  captionTimingLocked,
  mediaUrl,
  durationOf,
  sourceName,
  time,
  selected,
  segmentId,
  onSelect,
  onSeek,
  onChange,
}: TimelineProps) {
  const [zoom, setZoom] = useState(1);
  const { fps } = schedule;
  const duration = schedule.totalFrames / fps || 1;
  const total = Math.max(duration, MIN_VISIBLE_SECONDS);
  const laneTime = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return clamp(((event.clientX - box.left) / box.width) * total, 0, duration);
  };
  const seekLane = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onSeek(laneTime(event));
    }
  };
  const step = tickStep(total);
  const ticks = Array.from(
    { length: Math.floor(total / step) + 1 },
    (_, i) => i * step
  );
  const index = settings.segments.findIndex((s) => s.id === segmentId);
  const segment = settings.segments[index];
  const span = schedule.spans[index];
  const offset = segment && span ? span.startFrame / fps - segment.start : 0;
  const segmentRows = (segment && captions.get(segment.id)) ?? [];

  return (
    <section aria-label="Video timeline" className="ce-timeline">
      <div className="ce-timeline-heading">
        <strong>Timeline</strong>
        <span>
          {settings.segments.length}{" "}
          {settings.segments.length === 1 ? "clip" : "clips"} ·{" "}
          {tenths(duration)}
        </span>
        <label>
          Zoom{" "}
          <input
            aria-label="Timeline zoom"
            max="5"
            min="1"
            onChange={(e) => setZoom(Number(e.target.value))}
            step="0.25"
            type="range"
            value={zoom}
          />
        </label>
      </div>
      <div className="ce-timeline-scroll">
        <div
          className="ce-timeline-content"
          style={
            {
              minWidth: `${Math.max(640, 760 * zoom)}px`,
              "--ce-grid": `${(step / total) * 100}%`,
            } as CSSProperties
          }
        >
          <div className="ce-track ce-ruler">
            <div className="ce-track-label">{tenths(time)}</div>
            <div className="ce-track-lane">
              {ticks.map((at) => (
                <span key={at} style={{ left: `${(at / total) * 100}%` }}>
                  {tick(at)}
                </span>
              ))}
              <input
                aria-label="Playhead"
                max={duration}
                min="0"
                onChange={(e) => onSeek(Number(e.target.value))}
                step="0.01"
                type="range"
                value={Math.min(time, duration)}
              />
            </div>
          </div>
          <Track icon={Film} label="Video" onSeek={seekLane}>
            {settings.segments.map((item, i) => {
              const itemSpan = schedule.spans[i];
              if (!itemSpan) {
                return null;
              }
              const spanStart = itemSpan.startFrame / fps;
              const spanEnd = itemSpan.endFrame / fps;
              return (
                <Bar
                  active={
                    selected.type === "segment" && selected.id === item.id
                  }
                  color="var(--ce-track-video)"
                  end={spanEnd}
                  key={item.id}
                  label={`${i + 1}. ${sourceName}`}
                  onRange={(start, end) => {
                    const a = clamp(
                      item.start + start - spanStart,
                      0,
                      item.end - LIMITS.minSegmentSeconds
                    );
                    const b = clamp(
                      item.end + end - spanEnd,
                      a + LIMITS.minSegmentSeconds,
                      durationOf(item.source)
                    );
                    onChange(
                      updateSegment(settings, item.id, {
                        start: rounded(a),
                        end: rounded(b),
                      }),
                      `trim:${item.id}`
                    );
                  }}
                  onSelect={() => {
                    onSelect({ type: "segment", id: item.id });
                    onSeek(spanStart);
                  }}
                  start={spanStart}
                  thumb={<BarThumb at={item.start} url={mediaUrl} />}
                  total={total}
                >
                  {i > 0 && item.transition.kind !== "cut" ? (
                    <small>{item.transition.kind}</small>
                  ) : null}
                </Bar>
              );
            })}
          </Track>
          <Track icon={Captions} label="Captions" onSeek={seekLane}>
            {settings.captionsEnabled && segment
              ? segmentRows.map((row) => {
                  const a = Math.max(row.start, segment.start);
                  const b = Math.min(row.end, segment.end);
                  if (b <= a || row.lines.length === 0) {
                    return null;
                  }
                  const key = anchorKey(row.anchor);
                  return (
                    <Bar
                      active={
                        selected.type === "caption" &&
                        anchorKey(selected.anchor) === key
                      }
                      color="var(--ce-track-caption)"
                      end={b + offset}
                      key={key}
                      label={row.lines.join(" ")}
                      locked={captionTimingLocked}
                      movable={captionTimingLocked === undefined}
                      onRange={(start, end) =>
                        onChange(
                          updateSegment(settings, segment.id, {
                            captions: editCaption(segment.captions, row, {
                              kind: "timing",
                              range: {
                                start: rounded(start - offset),
                                end: rounded(end - offset),
                              },
                            }),
                          }),
                          `caption:${key}`
                        )
                      }
                      onSelect={() =>
                        onSelect({
                          type: "caption",
                          segmentId: segment.id,
                          anchor: row.anchor,
                        })
                      }
                      start={a + offset}
                      total={total}
                    />
                  );
                })
              : null}
          </Track>
          <Track icon={Type} label="Text" onSeek={seekLane}>
            {null}
          </Track>
          <Track icon={ImageIcon} label="Images" onSeek={seekLane}>
            {null}
          </Track>
          <Track icon={Music2} label="Audio" onSeek={seekLane}>
            {null}
          </Track>
          <Track icon={Sparkles} label="Effects" onSeek={seekLane}>
            {null}
          </Track>
          <div
            className="ce-playhead"
            style={{
              left: `calc(var(--ce-label-w) + (100% - var(--ce-label-w)) * ${time / total})`,
            }}
          />
        </div>
      </div>
      <p className="ce-timeline-help">
        Drag clip bodies to reorder, drag edges to trim.
        <span>
          <kbd>Space</kbd> play
        </span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> nudge<em> (hold Shift for 1s)</em>
        </span>
        <span>
          <kbd>S</kbd> split
        </span>
        <span>
          <kbd>⌘</kbd>
          <kbd>Z</kbd> undo
        </span>
      </p>
    </section>
  );
}
