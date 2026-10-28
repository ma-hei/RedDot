"""The red dot's backend, only for speech-to-text: it gets the page's audio and utterances and has
them transcribed through RecordingToText (transcriber.py).

The page detects speech and cuts it into utterances itself, in the browser (link.ts). While the dot
(or R) is held, it streams the audio here and says where each utterance starts and ends; this
server keeps the press's chunks, gives the transcriber what it needs (the stream, or an
utterance's recording), and passes the text back. For debugging, each utterance is also saved as
a WAV file in DEBUG_AUDIO_DIR.

Run:   RECORDING_TO_TEXT_URL=http://localhost:8092 .venv/bin/uvicorn server:app --port 8090
       (the port the page's dev server forwards to: see red-dot/vite.config.ts)

HTTP:
    GET /healthz                  {"ok": true}; the page polls this while the server is down
WebSocket /ws:
    page -> server  text   {"type": "mic", "on": true, "chunk": n}   a press starts; the next audio
                           chunk is number n (the page's numbering, which never starts over)
                    binary 100 ms of 16 kHz 16-bit mono PCM   while the press goes on
                    text   {"type": "utterance", "event": "ended", "first": n, "last": m}
                           the page ended an utterance: chunks n..m
                    text   {"type": "cut"}   while listening: start a new stream from here (a click
                           with "Dot always on", the 280 s limit of one utterance, new settings)
                    text   {"type": "mic", "on": false}   the press is over (after its last utterance)
                    text   {"type": "settings", "mode": ..., "service": ..., "model": ..., "language": ...}
                           how to transcribe (see transcriber.py)
    server -> page  text   {"type": "transcription", ...}, {"type": "text", ...}, {"type": "text_error", ...}
                           speech-to-text, see transcriber.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import wave
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from transcriber import Transcriber

logging.basicConfig(level=logging.INFO, format="%(asctime)s.%(msecs)03d  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("red-dot-server")

SAMPLE_RATE = 16000
CHUNK_SECONDS = 0.1
KEEP_CHUNKS = 3000   # a press's chunks are kept for its utterances' recordings: at most 5 minutes

# Every utterance is saved here as a WAV file you can listen to. Empty: don't save.
DEBUG_AUDIO_DIR = os.getenv("DEBUG_AUDIO_DIR", "debug-audio")

ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

app = FastAPI(title="Red dot backend")
# CORS: lets pages from ALLOWED_ORIGINS read /healthz although they come from another domain.
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET"])


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


def save_wav(pcm: bytes) -> Path:
    path = Path(DEBUG_AUDIO_DIR) / f"{time.strftime('%H%M%S')}_{len(pcm) / 2 / SAMPLE_RATE:.1f}s.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)       # mono
        w.setsampwidth(2)       # 16 bit
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return path


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:

    # CORS doesn't cover WebSockets: any website's page could open one to this server.
    # So check where the page came from ourselves.
    origin = websocket.headers.get("origin", "")
    if origin not in ALLOWED_ORIGINS:
        log.warning("refused a WebSocket from %r (allowed: %s)", origin, ", ".join(ALLOWED_ORIGINS))
        await websocket.close(code=1008)  # before accept(): the browser gets HTTP 403
        return

    await websocket.accept()
    log.info("page connected")
    send_lock = asyncio.Lock()  # text comes from the transcriber's own tasks, possibly several at once

    async def send(message: dict) -> None:
        try:
            async with send_lock:
                await websocket.send_text(json.dumps(message, ensure_ascii=False))
        except (WebSocketDisconnect, RuntimeError):
            pass  # the page is gone; the loop below notices and cleans up

    transcriber = Transcriber(send)
    await send({"type": "transcription", "available": Transcriber.available()})
    talking = False                  # a press goes on: its audio arrives
    chunk = 0                        # the last chunk's number, as the page counts them
    kept: dict[int, bytes] = {}      # this press's chunks, by number

    async def utterance_ended(first: int, last: int) -> None:
        audio = b"".join(kept.get(n, b"") for n in range(first, last + 1))
        seconds = (last - first + 1) * CHUNK_SECONDS
        if DEBUG_AUDIO_DIR and audio:
            log.info("=== utterance %d..%d (%.1f s) -> saved %s ===", first, last, seconds, save_wav(audio))
        else:
            log.info("=== utterance %d..%d (%.1f s) ===", first, last, seconds)
        await transcriber.utterance(first, last, audio)

    async def new_stream(why: str) -> None:
        """End the transcriber's current stream here and start the next one (mode 1)."""
        log.info("=== new stream%s ===", why)
        await transcriber.stop()
        await transcriber.start(chunk)

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("text"):
                data = json.loads(msg["text"])
                kind = data.get("type")
                if kind == "settings":
                    if talking and transcriber.would_change(data):
                        await transcriber.stop()       # the page has ended the utterance with the old settings
                        transcriber.configure(data)
                        await transcriber.start(chunk)
                    else:
                        transcriber.configure(data)
                elif kind == "mic" and bool(data.get("on")) != talking:
                    talking = bool(data.get("on"))
                    if talking:
                        chunk = int(data.get("chunk", chunk + 1)) - 1
                        kept.clear()
                        log.info("=== talking (from chunk %d) ===", chunk + 1)
                        await transcriber.start(chunk)
                    else:
                        log.info("=== not talking ===")
                        await transcriber.stop()
                        kept.clear()
                elif kind == "utterance" and data.get("event") == "ended":
                    await utterance_ended(int(data["first"]), int(data["last"]))
                elif kind == "cut" and talking:
                    await new_stream(" (the page asked for it)")
            elif msg.get("bytes") and talking:
                chunk += 1
                kept[chunk] = msg["bytes"]
                kept.pop(chunk - KEEP_CHUNKS, None)
                await transcriber.chunk(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        await transcriber.close()
        log.info("page disconnected")
