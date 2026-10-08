"""Speech-to-text for the dot, through RecordingToText (../../../../../recording-to-text).

Only active when RECORDING_TO_TEXT_URL is set, e.g. http://localhost:8092. The page chooses how
(its ⚙ settings, sent as {"type": "settings", ...}):

    mode "stream"     mode 1: each press is streamed while it's held. Text comes back while you
                      speak and is replaced as the service revises it; it's tied to the lines by
                      the time of each word. Needs a service that can stream (Google).
    mode "recording"  mode 2: each finished utterance (= line) is sent as a whole recording when
                      it ends, i.e. at each pause; its text comes back once. Any service (also Whisper).
    mode "press"      mode 3: the whole press is one line and one recording, sent when the dot is
                      let go; its text comes back once. Any service. Google takes at most 1 minute
                      this way (its limit for a single recording).
    mode "off"        nothing is sent.

In modes 1 and 3 one press is one line: server.py tells the utterance cutter not to split at pauses.

To the page (see link.ts):
    {"type": "transcription", "available": bool}        once, when the page connects
    {"type": "text", "line": n | null, "text": "...", "final": bool, "confidence": c | null}
        line: the line's first chunk number (link.ts keys lines by it); null: the line that's
        still being spoken (the page shows it where the next line will appear).
        final: false while it can still change; true once the recording is finished.
    {"type": "text_error", "message": "..."}

What comes back is also logged here, as lines starting with >>>.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import urllib.error
import urllib.parse
import urllib.request
import wave
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

log = logging.getLogger("orb-server")

CHUNK_SECONDS = 0.1


def _base_url() -> str:
    """http://localhost:8092 (an older ws://.../stream setting is accepted too)."""
    url = os.getenv("RECORDING_TO_TEXT_URL", "").strip().rstrip("/")
    if url.endswith("/stream"):
        url = url[: -len("/stream")]
    return url.replace("ws://", "http://", 1).replace("wss://", "https://", 1)


BASE_URL = _base_url()
STREAM_URL = BASE_URL.replace("http", "ws", 1) + "/stream" if BASE_URL else ""

Emit = Callable[[dict], Awaitable[None]]


@dataclass
class Settings:
    mode: str = "stream"            # "stream", "recording", "press" or "off"
    service: str = "google"
    model: str | None = "long"
    language: str | None = "de-DE"  # None: the service detects it

    @classmethod
    def from_page(cls, data: dict) -> Settings:
        mode = data.get("mode") if data.get("mode") in ("stream", "recording", "press", "off") else "off"
        return cls(mode=mode, service=str(data.get("service") or "google"),
                   model=data.get("model") or None, language=data.get("language") or None)


@dataclass
class Line:
    first: int      # its first chunk: the page's key for the line
    start: float    # seconds from the start of the press
    end: float


@dataclass
class Press:
    """One press of the dot in mode 1: one stream, and the lines it has produced so far."""

    start_chunk: int                                   # chunks received before this press
    lines: list[Line] = field(default_factory=list)
    finals: list[dict] = field(default_factory=list)   # settled results, in order
    partial: dict | None = None                        # the current guess
    done: bool = False                                 # the stream is finished
    sent: dict = field(default_factory=dict)           # what the page has, by line (None: pending)


class Transcriber:
    """One per page connection."""

    def __init__(self, emit: Emit) -> None:
        self._emit = emit
        self.settings = Settings()
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._presses: deque[Press] = deque()   # streams sent, oldest first; results go to [0]
        self._current: Press | None = None      # the press being held (mode 1)
        self._last_partial = ""

    @staticmethod
    def available() -> bool:
        return bool(BASE_URL)

    def configure(self, data: dict) -> None:
        """New settings from the page. While listening, server.py first ends the current line (with
        the old settings) and then starts a new one with these."""
        self.settings = Settings.from_page(data)
        log.info(">>> settings: %s", self.settings)

    def would_change(self, data: dict) -> bool:
        return Settings.from_page(data) != self.settings

    def splits_at_pauses(self) -> bool:
        """Whether pauses end a line: not in Live and Per press, where a line is a whole press
        (or, with the dot always on, lasts until a click)."""
        return self.settings.mode not in ("stream", "press") or not BASE_URL

    # ---------------- the dot ----------------
    async def start(self, chunks_so_far: int) -> None:
        """The dot was pressed. Mode 1: start a stream."""
        if not BASE_URL or self.settings.mode != "stream":
            return
        try:
            if self._ws is None:
                self._ws = await connect(STREAM_URL, open_timeout=5, max_size=2**20)
                self._reader = asyncio.create_task(self._read(self._ws))
                log.info(">>> connected to RecordingToText at %s", STREAM_URL)
            s = self.settings
            await self._ws.send(json.dumps({"type": "start", "service": s.service, "model": s.model,
                                            "language": s.language, "sample_rate": 16000}))
        except (OSError, WebSocketException, asyncio.TimeoutError) as e:
            await self._error(f"RecordingToText not reachable at {BASE_URL} ({e})")
            await self._drop()
            return
        self._current = Press(start_chunk=chunks_so_far)
        self._presses.append(self._current)

    async def chunk(self, pcm: bytes) -> None:
        if self._current and self._ws:
            try:
                await self._ws.send(pcm)
            except WebSocketException:
                await self._drop()

    async def stop(self) -> None:
        """The dot was let go. Mode 1: end the stream; the last results still arrive."""
        if self._current and self._ws:
            self._current = None
            try:
                await self._ws.send(json.dumps({"type": "end"}))
            except WebSocketException:
                await self._drop()

    async def utterance(self, first: int, last: int, audio: bytes) -> None:
        """An utterance ended and the page now has a line for chunks first..last."""
        if not BASE_URL:
            return
        if self.settings.mode in ("recording", "press"):  # the press's one utterance ends on release
            asyncio.create_task(self._transcribe_recording(first, audio, self.settings))
        elif self._current:  # mode 1: from now on, text for this stretch goes to the line
            p = self._current
            p.lines.append(Line(first, (first - p.start_chunk - 1) * CHUNK_SECONDS, (last - p.start_chunk) * CHUNK_SECONDS))
            await self._update(p)

    async def close(self) -> None:
        """The page went away."""
        await self._drop()

    # ---------------- modes 2 and 3: one recording per line ----------------
    async def _transcribe_recording(self, first: int, audio: bytes, s: Settings) -> None:
        await self._emit({"type": "text", "line": first, "text": "", "final": False, "confidence": None})
        query = {"service": s.service, "language": s.language or "none"}
        if s.model:
            query["model"] = s.model
        try:
            result = await asyncio.to_thread(_post_wav, f"{BASE_URL}/transcribe?{urllib.parse.urlencode(query)}", audio)
        except RuntimeError as e:
            await self._emit({"type": "text", "line": first, "text": "", "final": True, "confidence": None})
            await self._error(str(e))
            return
        self._log(result)
        await self._emit({"type": "text", "line": first, "text": result["text"], "final": True,
                          "confidence": result.get("confidence")})

    # ---------------- mode 1: results -> lines ----------------
    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                msg = json.loads(raw)
                p = self._presses[0] if self._presses else None
                if msg["type"] == "transcript" and p:
                    self._log(msg)
                    if msg["final"]:
                        p.finals.append(msg)
                        p.partial = None
                    else:
                        p.partial = msg
                    await self._update(p)
                elif msg["type"] == "error":
                    await self._error(msg["message"])
                elif msg["type"] == "done" and p:
                    p.done = True
                    p.partial = None
                    await self._update(p)
                    self._presses.popleft()
        except WebSocketException as e:
            log.warning(">>> connection to RecordingToText lost (%s)", e)
            self._ws = None
            self._current = None
            self._presses.clear()

    async def _update(self, p: Press) -> None:
        """Works out each line's text (and the pending text) and sends the page what changed."""
        texts: dict[int | None, list[str]] = {line.first: [] for line in p.lines}
        texts[None] = []
        confidences: dict[int | None, list[float]] = {}

        def owner(t: float) -> int | None:
            """The line a moment of the press belongs to: the nearest ended line, or None (pending)
            if it's after all of them."""
            if not p.lines or t >= p.lines[-1].end:
                return None
            return min(p.lines, key=lambda l: 0 if l.start <= t < l.end else min(abs(t - l.start), abs(t - l.end))).first

        def owner_of_span(start: float, end: float) -> int | None:
            """The line a stretch of the press (a result without word times) overlaps most; None
            (pending) is the time after the last ended line. Neither end alone is reliable: a
            stretch starts where the text before it was settled (maybe inside the previous line),
            and keeps ending later while silence follows its line."""
            spans = [(line.first, line.start, line.end) for line in p.lines]
            spans.append((None, p.lines[-1].end if p.lines else 0.0, float("inf")))
            def overlap(span):
                return min(end, span[2]) - max(start, span[1])
            return max(reversed(spans), key=overlap)[0]  # reversed: on a tie, the later one

        settled_until = 0.0
        for result in p.finals:
            end = result["extras"].get("end", settled_until)
            if result["words"]:
                # Each word to its line, by when it ends: its end is reliable, its start isn't (Google
                # long starts a word where the previous one ended, even across a pause).
                for w in result["words"]:
                    key = owner(w["end"] - 0.01) if w["end"] is not None else owner_of_span(settled_until, end)
                    texts[key].append(w["text"])
                    if result.get("confidence") is not None:
                        confidences.setdefault(key, []).append(result["confidence"])
            elif result["text"]:
                texts[owner_of_span(settled_until, end)].append(result["text"])
            settled_until = end
        if p.partial and p.partial["text"]:
            end = p.partial["extras"].get("end", settled_until)
            texts[owner_of_span(settled_until, end)].append(p.partial["text"])

        for key, words in texts.items():
            if key is None and p.done:
                words = []  # the press is over: nothing is pending any more
            message = {"type": "text", "line": key, "text": " ".join(words), "final": p.done,
                       "confidence": min(confidences[key]) if confidences.get(key) else None}
            if p.sent.get(key) != message:
                p.sent[key] = message
                await self._emit(message)

    # ---------------- helpers ----------------
    async def _error(self, message: str) -> None:
        log.warning(">>> %s", message)
        await self._emit({"type": "text_error", "message": message})

    def _log(self, msg: dict) -> None:
        label = f"{msg['service']}/{msg['model']}"
        if msg["final"]:
            conf = f"{msg['confidence']:.2f}" if msg.get("confidence") is not None else "  – "
            log.info(">>> %-18s FINAL %s %-5s %s", label, conf, msg.get("language") or "?", msg["text"])
            self._last_partial = ""
        elif msg["text"] != self._last_partial:  # services often repeat a guess: log each once
            self._last_partial = msg["text"]
            log.info(">>> %-18s partial          %s", label, msg["text"])

    async def _drop(self) -> None:
        self._current = None
        self._presses.clear()
        ws, self._ws = self._ws, None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if ws:
            await ws.close()


def _post_wav(url: str, pcm: bytes) -> dict:
    """POST the audio as a WAV file to RecordingToText's /transcribe (runs in a thread)."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    request = urllib.request.Request(url, data=buffer.getvalue(), headers={"Content-Type": "audio/wav"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", e.reason)
        except ValueError:
            detail = e.reason
        raise RuntimeError(f"RecordingToText: {detail}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"RecordingToText not reachable at {BASE_URL} ({e})") from e
