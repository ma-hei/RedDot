"""The backend for the React orb (../orb-react): nothing else.

The browser streams the microphone while the dot (or R) is held; for every 100 ms chunk
the server answers whether it is speech. For debugging, it also cuts the stream into
utterances (utterances.py) and saves each as a WAV file in DEBUG_AUDIO_DIR. Everything
runs locally: no speech-to-text, no Google Cloud.

Run:   .venv/bin/uvicorn server:app --port 8090
       (the port the React dev server forwards to: see ../orb-react/vite.config.ts)

HTTP:
    GET /healthz                  the page polls this while the server is down
    GET /static/pcm-recorder.js   the AudioWorklet that turns the mic into 100 ms PCM chunks
WebSocket /ws:
    page -> server  text   {"type": "mic", "on": true|false}   dot/R pressed or released
                    binary 100 ms of 16 kHz 16-bit mono PCM   only while pressed
    server -> page  text   {"type": "verdict", "speech": bool, "rms": int}   one per chunk
                    text   {"type": "utterance", "event": "ended", "first": n, "last": m, "seconds": s}
                           an utterance is complete: it consists of the chunks numbered first..last
                           (counted from 1 per connection, in the order the page sent them). The page
                           kept those chunks itself, so the audio doesn't travel back.
"""

from __future__ import annotations

import json
import logging
import os
import time
import wave
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from speech_check import MIN_RMS, SAMPLE_RATE, ChunkCheck, SpeechCheck
from utterances import UtteranceEvent, UtteranceRecorder

logging.basicConfig(level=logging.INFO, format="%(asctime)s.%(msecs)03d  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("orb-server")

# Every finished utterance is saved here as a WAV file you can listen to. Empty: don't save.
DEBUG_AUDIO_DIR = os.getenv("DEBUG_AUDIO_DIR", "debug-audio")

ALLOWED_ORIGINS = [o.strip().rstrip("/") for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

app = FastAPI(title="Orb backend")
# CORS: lets pages from ALLOWED_ORIGINS read /healthz although they come from another domain.
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["GET"])


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


def describe(n: int, c: ChunkCheck, recorder: UtteranceRecorder) -> str:
    """One log line per chunk: the two checks, the verdict, and whether a sentence is being recorded."""
    loud = f"rms {c.rms:5.0f} {'>=' if c.rms >= MIN_RMS else '< '} {MIN_RMS:.0f}"
    voice = f"voice {c.voiced_frames}/{c.total_frames}"
    state = "RECORDING" if recorder.recording else "waiting"
    return f"#{n:05d}  {loud}   {voice}   -> {'SPEECH' if c.is_speech else 'quiet '}   {state}"


def save_wav(pcm: bytes) -> Path:
    path = Path(DEBUG_AUDIO_DIR) / f"{time.strftime('%H%M%S')}_{len(pcm) / 2 / SAMPLE_RATE:.1f}s.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)       # mono
        w.setsampwidth(2)       # 16 bit
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return path


def report(ev: UtteranceEvent, why: str = "") -> None:
    if ev.event == "ended" and ev.audio and DEBUG_AUDIO_DIR:
        log.info("=== utterance ended%s (%.1f s) -> saved %s ===", why, ev.seconds, save_wav(ev.audio))
    else:
        log.info("=== utterance %s%s (%.1f s) ===", ev.event, why, ev.seconds)


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
    speech_check = SpeechCheck()
    recorder = UtteranceRecorder()
    talking = False  # the dot (or R) is held
    chunks = 0       # chunks received while talking; the page counts the ones it sends the same way

    async def utterance_done(ev: UtteranceEvent, why: str = "") -> None:
        report(ev, why)
        if ev.event == "ended":
            # The utterance is the last ev.chunks chunks received, up to and including this one.
            await websocket.send_text(json.dumps({"type": "utterance", "event": "ended",
                                                  "first": chunks - ev.chunks + 1, "last": chunks,
                                                  "seconds": round(ev.seconds, 1)}))

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("text"):
                data = json.loads(msg["text"])
                if data.get("type") == "mic" and bool(data.get("on")) != talking:
                    talking = bool(data.get("on"))
                    if not talking and (ev := recorder.finish()):
                        await utterance_done(ev, " because the dot/R was released")
                    log.info("=== %s ===", "talking" if talking else "not talking")
            elif msg.get("bytes") and talking:
                chunks += 1
                c = speech_check.check(msg["bytes"])
                ev = recorder.feed(msg["bytes"], c.is_speech)
                log.info(describe(chunks, c, recorder))
                await websocket.send_text(json.dumps({"type": "verdict", "speech": c.is_speech, "rms": round(c.rms)}))
                if ev:
                    await utterance_done(ev)
    except WebSocketDisconnect:
        pass
    finally:
        if ev := recorder.finish():  # the page went away mid-sentence: keep what was said
            report(ev, " because the page disconnected")
        log.info("page disconnected")
