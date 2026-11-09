"""Speech to word-timed text. POST raw audio to /transcribe. Internal network only, so no auth."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
import signal
import sys
import tempfile
import time
from threading import Lock

import av
from faster_whisper import WhisperModel, decode_audio

MAX_BYTES = 48 * 1024 * 1024
SAMPLE_RATE = 16000
# faster-whisper builds the spectrogram of all the audio it is handed at once, about
# 44 MB per minute, so a 3 hour file in one call needs over 11 GB. Ten minute chunks cap it.
CHUNK = 600 * SAMPLE_RATE
SEARCH = 30 * SAMPLE_RATE
FRAME = SAMPLE_RATE // 10

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
model = WhisperModel(
    os.getenv("WHISPER_MODEL", "small"),
    device="cpu",
    compute_type="int8",
    cpu_threads=int(os.getenv("WHISPER_THREADS", "4")),
)
# ponytail: one global lock, one inference at a time. Run more replicas for throughput.
inference_lock = Lock()


def transcribe(audio, language):
    cuts = [0]
    while len(audio) - cuts[-1] > CHUNK + SEARCH:
        start = cuts[-1] + CHUNK - SEARCH
        frames = audio[start : start + 2 * SEARCH].reshape(-1, FRAME)
        cuts.append(start + int((frames**2).mean(axis=1).argmin()) * FRAME + FRAME // 2)
    cuts.append(len(audio))

    segments = []
    for start, end in zip(cuts, cuts[1:]):
        parts, info = model.transcribe(
            audio[start:end],
            language=language,
            word_timestamps=True,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        offset = start / SAMPLE_RATE
        found = [
            {
                "start": round(s.start + offset, 3),
                "end": round(s.end + offset, 3),
                "text": s.text.strip(),
                "words": [
                    {"start": round(w.start + offset, 3), "end": round(w.end + offset, 3), "word": w.word.strip()}
                    for w in s.words
                    if w.word.strip()
                ],
            }
            for s in parts
            if s.text.strip()
        ]
        if found:
            language = info.language
        segments += found
    return {"language": info.language, "duration": len(audio) / SAMPLE_RATE, "segments": segments}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        self.reply(200, {"status": "ok"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"error": "not found"})
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            return self.reply(411, {"error": "Content-Length is required"})
        if length > MAX_BYTES:
            return self.reply(413, {"error": f"audio is over {MAX_BYTES} bytes"})
        language = self.headers.get("X-Language", "").strip().lower() or None
        if language and language not in model.supported_languages:
            return self.reply(400, {"error": f"unsupported language: {language}"})

        with tempfile.NamedTemporaryFile() as upload:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    return self.reply(400, {"error": "body ended before Content-Length"})
                upload.write(chunk)
                remaining -= len(chunk)
            upload.flush()

            with inference_lock:
                started = time.monotonic()
                try:
                    audio = decode_audio(upload.name)
                except av.error.FFmpegError as error:
                    return self.reply(400, {"error": f"cannot decode audio: {error}"})
                except IndexError:
                    return self.reply(400, {"error": "no audio stream"})
                decoded = time.monotonic()
                try:
                    result = transcribe(audio, language)
                except Exception:
                    logging.exception("transcription failed")
                    return self.reply(500, {"error": "transcription failed"})

        logging.info(
            "transcribed %.1fs of %s audio: decode %.1fs, inference %.1fs",
            result["duration"],
            result["language"],
            decoded - started,
            time.monotonic() - decoded,
        )
        self.reply(200, result)


# As PID 1 in a container, Python would otherwise ignore SIGTERM and docker stop waits 10s.
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
