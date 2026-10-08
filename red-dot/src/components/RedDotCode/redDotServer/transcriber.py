"""Forwards the dot's audio to RecordingToText (../../../../../recording-to-text) and logs the text.

Optional: only active when RECORDING_TO_TEXT_URL is set, e.g. ws://localhost:8092/stream. While
the dot (or R) is held, every 100 ms chunk also goes to RecordingToText; letting go ends the
stream. One press is one stream. What comes back is only logged, in this terminal:

    >>> google/long        partial          Hallo wie
    >>> google/long        FINAL 0.98 de-DE Hallo, wie geht es dir?

If RecordingToText can't be reached or fails, the dot keeps working; the log says why.

Settings (environment):
    RECORDING_TO_TEXT_URL    where its /stream WebSocket is; empty: off (the default)
    RTT_SERVICE              google (default); a service that can stream (not whisper)
    RTT_LANGUAGE             de-DE (default); none: the service detects the language
    RTT_MODEL                the service's model; empty: its default (google: chirp_2)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

log = logging.getLogger("orb-server")

URL = os.getenv("RECORDING_TO_TEXT_URL", "")
SERVICE = os.getenv("RTT_SERVICE", "google")
LANGUAGE = os.getenv("RTT_LANGUAGE", "de-DE")
MODEL = os.getenv("RTT_MODEL", "") or None


class Transcriber:
    """One per page connection. Connects on the first press and keeps the connection."""

    def __init__(self) -> None:
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task | None = None
        self._streaming = False
        self._last_partial = ""  # services often repeat a guess: log each one once

    @staticmethod
    def enabled() -> bool:
        return bool(URL)

    async def start(self) -> None:
        """The dot was pressed: start a stream."""
        if not URL:
            return
        try:
            if self._ws is None:
                self._ws = await connect(URL, open_timeout=5, max_size=2**20)
                self._reader = asyncio.create_task(self._read(self._ws))
                log.info(">>> connected to RecordingToText at %s", URL)
            await self._ws.send(json.dumps({
                "type": "start", "service": SERVICE, "model": MODEL, "sample_rate": 16000,
                "language": None if LANGUAGE.lower() == "none" else LANGUAGE,
            }))
            self._streaming = True
        except (OSError, WebSocketException, asyncio.TimeoutError) as e:
            log.warning(">>> RecordingToText not reachable at %s (%s): no text for this press", URL, e)
            await self._drop()

    async def chunk(self, pcm: bytes) -> None:
        if self._streaming and self._ws:
            try:
                await self._ws.send(pcm)
            except WebSocketException:
                await self._drop()

    async def stop(self) -> None:
        """The dot was let go: end the stream. The last results still arrive."""
        if self._streaming and self._ws:
            self._streaming = False
            try:
                await self._ws.send(json.dumps({"type": "end"}))
            except WebSocketException:
                await self._drop()

    async def close(self) -> None:
        """The page went away."""
        await self._drop()

    async def _drop(self) -> None:
        self._streaming = False
        ws, self._ws = self._ws, None
        if self._reader:
            self._reader.cancel()
            self._reader = None
        if ws:
            await ws.close()

    async def _read(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg["type"] == "transcript":
                    label = f"{msg['service']}/{msg['model']}"
                    if msg["final"]:
                        conf = f"{msg['confidence']:.2f}" if msg.get("confidence") is not None else "  – "
                        log.info(">>> %-18s FINAL %s %-5s %s", label, conf, msg.get("language") or "?", msg["text"])
                        self._last_partial = ""
                    elif msg["text"] != self._last_partial:
                        self._last_partial = msg["text"]
                        log.info(">>> %-18s partial          %s", label, msg["text"])
                elif msg["type"] == "error":
                    log.warning(">>> RecordingToText: %s", msg["message"])
        except WebSocketException as e:
            log.warning(">>> connection to RecordingToText lost (%s)", e)
            self._ws = None
            self._streaming = False
