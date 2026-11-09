"""Fails if the running service breaks its HTTP contract.

python3 check.py <speech audio file> [base url, default http://localhost:8000]
"""
import http.client
import json
import sys
from urllib.parse import urlsplit

audio = open(sys.argv[1], "rb").read()
url = urlsplit(sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000")


def request(method, path, body=None, headers=None):
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=600)
    conn.request(method, path, body=body, headers=headers or {})
    response = conn.getresponse()
    return response.status, response.read()


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


status, _ = request("GET", "/health")
assert status == 200, f"/health returned {status}"

status, raw = request("POST", "/transcribe", audio)
assert status == 200, f"/transcribe returned {status}: {raw[:200]}"
body = json.loads(raw)
assert set(body) == {"language", "duration", "segments"}, f"top-level keys {set(body)}"
assert isinstance(body["language"], str) and body["language"], "language is a code"
assert number(body["duration"]) and body["duration"] > 0, "duration is positive seconds"
assert body["segments"], "speech produced segments"
for segment in body["segments"]:
    assert set(segment) == {"start", "end", "text", "words"}, f"segment keys {set(segment)}"
    assert number(segment["start"]) and number(segment["end"]), "segment times are numbers"
    assert 0 <= segment["start"] <= segment["end"] <= body["duration"], f"segment times {segment}"
    assert isinstance(segment["text"], str) and segment["text"].strip(), "segment has text"
    assert segment["words"], f"segment has word timings: {segment['text']}"
    for word in segment["words"]:
        assert set(word) == {"start", "end", "word"}, f"word keys {set(word)}"
        assert number(word["start"]) and number(word["end"]), "word times are numbers"
        assert 0 <= word["start"] <= word["end"] <= body["duration"], f"word times {word}"
        assert isinstance(word["word"], str) and word["word"], "word has text"

status, raw = request("POST", "/transcribe", audio, {"X-Language": "en"})
assert status == 200 and json.loads(raw)["language"] == "en", "X-Language is honored"

status, _ = request("POST", "/transcribe", audio, {"X-Language": "xx"})
assert status == 400, f"unsupported language returned {status}"

status, _ = request("POST", "/transcribe", b"", {"Content-Length": str(10**12)})
assert status == 413, f"oversized upload returned {status}"

starts = [word["start"] for segment in body["segments"] for word in segment["words"]]
assert starts == sorted(starts), "word start times never go backwards"

print(f"ok: {body['language']}, {body['duration']:.1f}s, {len(body['segments'])} segments")
