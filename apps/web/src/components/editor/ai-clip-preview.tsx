// biome-ignore-all lint/performance/noJsxPropsBind: nothing here is memoized and the editor re-renders every frame while playing, so stable handlers would save nothing.
import {
  type CaptionRow,
  type Cue,
  captionStyle,
  segmentCues,
} from "@clipradar/db/captions";
import { CANVASES, type EditDraft, type SourceRef } from "@clipradar/db/editor";
import {
  frameAt,
  type PreviewFrame,
  type PreviewLayer,
  type Schedule,
} from "@clipradar/db/timeline";
import {
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { clamp } from "@/lib/edit-doc";

const SEEK_TOLERANCE_SECONDS = 0.25;
const FRAME_SECONDS = 1 / 30;
const MAX_TICK_SECONDS = 0.1;
const ZOOM_MIN_SCALE = 0.5;

type Failure = "unsupported" | "failed";

function Media({
  url,
  label,
  time,
  playing,
  volume,
  crop,
  onError,
  register,
}: {
  url: string;
  label: string;
  time: number;
  playing: boolean;
  volume: number;
  crop: [number, number];
  onError: (failure: Failure) => void;
  register?: (element: HTMLVideoElement | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    register?.(video.current);
    return () => register?.(null);
  }, [register]);
  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    element.volume = Math.min(volume, 1);
    element.muted = volume === 0;
    if (
      Number.isFinite(time) &&
      Math.abs(element.currentTime - time) > SEEK_TOLERANCE_SECONDS
    ) {
      element.currentTime = time;
    }
    if (playing && element.paused) {
      element.play().catch(() => onError("failed"));
    }
    if (!(playing || element.paused)) {
      element.pause();
    }
  }, [time, playing, volume, onError]);
  const failed = (event: SyntheticEvent<HTMLVideoElement>) => {
    const code = event.currentTarget.error?.code;
    onError(
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ||
        code === MediaError.MEDIA_ERR_DECODE
        ? "unsupported"
        : "failed"
    );
  };
  return (
    // biome-ignore lint/a11y/useMediaCaption: the caption layer beside it draws what the render burns in.
    <video
      aria-label={label}
      onError={failed}
      onLoadedMetadata={() => {
        if (video.current) {
          video.current.currentTime = time;
        }
      }}
      playsInline
      preload="auto"
      ref={video}
      src={url}
      style={{ objectPosition: `${crop[0] * 100}% ${crop[1] * 100}%` }}
    />
  );
}

function captionCss(aspect: EditDraft["aspectRatio"]): CSSProperties {
  const caption = captionStyle(aspect);
  const ofWidth = (pixels: number) => `${(pixels / caption.width) * 100}cqw`;
  return {
    left: `${(caption.marginX / caption.width) * 100}%`,
    right: `${(caption.marginX / caption.width) * 100}%`,
    bottom: `${(caption.marginBottom / caption.height) * 100}%`,
    fontFamily: `"${caption.font}", Verdana, sans-serif`,
    fontWeight: caption.bold ? 700 : 400,
    fontSize: ofWidth(caption.size * caption.cssEmScale),
    lineHeight: 1 / caption.cssEmScale,
    WebkitTextStroke: `${ofWidth(caption.outline * 2)} black`,
    paintOrder: "stroke fill",
  };
}

function layerStyle(frame: PreviewFrame, layer: PreviewLayer): CSSProperties {
  if (frame.layers.length < 2) {
    return {};
  }
  if (frame.transition === "slide") {
    const at = layer.incoming ? 1 - frame.progress : -frame.progress;
    return { transform: `translateX(${at * 100}%)` };
  }
  if (!layer.incoming) {
    return {};
  }
  return {
    opacity: frame.progress,
    transform:
      frame.transition === "zoom"
        ? `scale(${ZOOM_MIN_SCALE + frame.progress * (1 - ZOOM_MIN_SCALE)})`
        : undefined,
  };
}

const FAILURE_TEXT: Record<Failure, string> = {
  unsupported: "This browser can't preview this source.",
  failed: "The source didn't load.",
};

export interface PreviewProps {
  captions: ReadonlyMap<string, readonly CaptionRow[]>;
  mediaUrl: (source: SourceRef) => string | null;
  onPlaying: (playing: boolean) => void;
  onTime: (time: number) => void;
  playing: boolean;
  schedule: Schedule;
  settings: EditDraft;
  sourceName: string;
  time: number;
}

export function AiClipPreview({
  settings,
  schedule,
  captions,
  mediaUrl,
  sourceName,
  time,
  playing,
  onTime,
  onPlaying,
}: PreviewProps) {
  const [error, setError] = useState<Failure | null>(null);
  const playhead = useRef<HTMLVideoElement | null>(null);
  const registerPlayhead = useCallback((element: HTMLVideoElement | null) => {
    playhead.current = element;
  }, []);
  const total = schedule.totalFrames / schedule.fps;
  const frame = frameAt(settings, time);
  const incoming = frame.layers.find((layer) => layer.incoming);
  const current = useRef({ time, onTime, onPlaying, total, offset: 0 });
  useEffect(() => {
    current.current = {
      time,
      onTime,
      onPlaying,
      total,
      offset: incoming ? time - incoming.sourceTime : 0,
    };
  }, [time, onTime, onPlaying, total, incoming]);
  useEffect(() => {
    if (!playing) {
      return;
    }
    let animation = 0;
    let previous = performance.now();
    const tick = (instant: number) => {
      const elapsed = Math.min((instant - previous) / 1000, MAX_TICK_SECONDS);
      if (elapsed >= FRAME_SECONDS) {
        previous = instant;
        const element = playhead.current;
        const clockTime =
          element &&
          !element.paused &&
          element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          Number.isFinite(element.currentTime)
            ? element.currentTime + current.current.offset
            : current.current.time + elapsed;
        const next = clamp(clockTime, 0, current.current.total);
        current.current.time = next;
        current.current.onTime(next);
        if (next >= current.current.total) {
          current.current.onPlaying(false);
          return;
        }
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing]);

  const cues = useMemo(() => {
    const bySegment = new Map<string, readonly Cue[]>();
    for (const [index, segment] of settings.segments.entries()) {
      const span = schedule.spans[index];
      if (span) {
        bySegment.set(
          segment.id,
          segmentCues(
            captions.get(segment.id) ?? [],
            { start: segment.start, end: segment.end },
            span.lengthFrames / schedule.fps
          )
        );
      }
    }
    return bySegment;
  }, [settings.segments, schedule, captions]);
  const onError = useCallback(
    (failure: Failure) => {
      setError(failure);
      onPlaying(false);
    },
    [onPlaying]
  );

  const [width, height] = CANVASES[settings.aspectRatio];
  const caption = captionCss(settings.aspectRatio);
  const visual = (layer: PreviewLayer) => {
    const segment = settings.segments.find((s) => s.id === layer.segmentId);
    const url = mediaUrl(layer.source);
    if (!(segment && url)) {
      return null;
    }
    const centiseconds = Math.round((layer.localFrame / settings.fps) * 100);
    const cue = settings.captionsEnabled
      ? cues
          .get(segment.id)
          ?.find((c) => c.startCs <= centiseconds && centiseconds < c.endCs)
      : undefined;
    return (
      <div
        className="ce-preview-layer"
        key={layer.segmentId}
        style={layerStyle(frame, layer)}
      >
        <Media
          crop={[segment.cropX, segment.cropY]}
          label={sourceName}
          onError={onError}
          playing={playing}
          register={layer.incoming ? registerPlayhead : undefined}
          time={layer.sourceTime}
          url={url}
          volume={layer.gain}
        />
        {cue ? (
          <p className="ce-preview-caption" style={caption}>
            {cue.lines.join("\n")}
          </p>
        ) : null}
      </div>
    );
  };
  return (
    <>
      <div className="ce-preview-fit">
        <div
          className="ce-preview-stage"
          style={
            {
              aspectRatio: `${width}/${height}`,
              "--ce-ratio": width / height,
            } as CSSProperties
          }
        >
          <div className="ce-preview-layer">{frame.layers.map(visual)}</div>
        </div>
      </div>
      {error ? (
        <p className="ce-error" role="alert">
          {FAILURE_TEXT[error]} Trim, captions and Export still work.{" "}
          <button onClick={() => setError(null)} type="button">
            Dismiss
          </button>
        </p>
      ) : null}
    </>
  );
}
