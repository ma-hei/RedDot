"""RecordingToText as a service, over HTTP and a WebSocket.

Run:   .venv/bin/uvicorn recording_to_text.server:app --port 8092

HTTP:
    GET  /health                 {"ok": true}
    GET  /services               the services: name, default model, what each can do
    POST /transcribe?service=google&language=de-DE&model=...
                                 mode 2: the body is a WAV file (16-bit mono); answers a Transcript.
                                 language=none (or leaving it out) lets the service detect it.
WebSocket /stream (mode 1), any number of streams one after another on one connection:
    client -> server  text   {"type": "start", "service": "google", "language": "de-DE" | null,
                              "model": null, "options": {}, "sample_rate": 16000}
                      binary 16-bit mono PCM, any length (the red dot sends 100 ms at a time)
                      text   {"type": "end"}              no more audio for this stream
    server -> client  text   {"type": "started", "service": ..., "model": ...}
                      text   {"type": "transcript", ...}  a Transcript; final=false: may still change
                      text   {"type": "done"}             the stream is finished, all results sent
                      text   {"type": "error", "message": "..."}   then "done"; the connection stays usable

There's no access check yet: run it only on your own computer (localhost) until step 7.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import asdict

from .settings import load_settings

load_settings()

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect  # noqa: E402

from . import Params, ServiceError, close_all, read_wav  # noqa: E402
from .services import FACTORIES, get_service  # noqa: E402
from .services.base import Stream  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s.%(msecs)03d  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("recording-to-text")

MAX_STREAM_SECONDS = 290    # Google ends a stream after 5 minutes; end ours a little before
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # mode 2: about 5 minutes of 16 kHz audio


WARM_UP_SECONDS = 20  # don't hold up startup longer than this if a service is slow


async def warm_up() -> None:
    """Gets every service ready before the first request (see Service.warm_up). Failures are only
    logged: the server starts anyway, and a request to that service then says what's wrong."""
    async def one(name: str) -> None:
        start = time.monotonic()
        try:
            await asyncio.wait_for(get_service(name).warm_up(), WARM_UP_SECONDS)
            log.info("warm-up: %s ready (%.1f s)", name, time.monotonic() - start)
        except ServiceError as e:
            log.warning("warm-up: %s not usable: %s", name, e)
        except asyncio.TimeoutError:
            log.warning("warm-up: %s didn't answer within %d s", name, WARM_UP_SECONDS)
    await asyncio.gather(*(one(name) for name in FACTORIES))


@asynccontextmanager
async def lifespan(_: FastAPI):
    await warm_up()
    yield
    await close_all()


app = FastAPI(title="RecordingToText", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.get("/services")
async def services() -> dict:
    out = []
    for name in FACTORIES:
        try:
            service = get_service(name)
        except ServiceError as e:  # e.g. a missing key: list it as unavailable, with the reason
            out.append({"name": name, "available": False, "reason": str(e)})
            continue
        out.append({"name": name, "available": True, "default_model": service.default_model,
                    **asdict(service.capabilities)})
    return {"services": out}


def _language(value: str | None) -> str | None:
    return None if not value or value.lower() == "none" else value


@app.post("/transcribe")
async def transcribe(request: Request, service: str = "google", language: str | None = None,
                     model: str | None = None) -> dict:
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "recording too long")
    try:
        recording = read_wav(body)
        transcript = await get_service(service).transcribe(recording, Params(language=_language(language), model=model))
    except ServiceError as e:
        raise HTTPException(400, str(e)) from e
    log.info("transcribe %s %.1f s -> %r", service, recording.seconds, transcript.text)
    return transcript.as_dict()


@app.websocket("/stream")
async def stream_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    send_lock = asyncio.Lock()  # results and replies are sent from two tasks

    async def send(message: dict) -> None:
        async with send_lock:
            await websocket.send_text(json.dumps(message, ensure_ascii=False))

    stream: Stream | None = None
    reader: asyncio.Task | None = None
    received = 0  # bytes of audio in the current stream
    sample_rate = 16000

    async def forward(stream: Stream, label: str) -> None:
        """Passes the stream's results on to the client, then says it's done."""
        try:
            async for t in stream.updates():
                log.info("%s %s %s", label, "FINAL  " if t.final else "partial", t.text)
                await send({"type": "transcript", **t.as_dict()})
        except ServiceError as e:
            log.warning("%s failed: %s", label, e)
            await send({"type": "error", "message": str(e)})
        await send({"type": "done"})

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("bytes") is not None:
                if stream is None:
                    continue  # audio outside a stream (e.g. after an error): nothing to do with it
                received += len(msg["bytes"])
                await stream.send(msg["bytes"])
                if received / 2 / sample_rate > MAX_STREAM_SECONDS:
                    log.info("stream too long, ending it")
                    await stream.end()
                    stream = None
                continue

            data = json.loads(msg.get("text") or "{}")
            if data.get("type") == "start":
                if reader and not reader.done():  # a new start before the old one finished: drop the old one
                    if stream:
                        await stream.cancel()
                    await reader
                service_name = data.get("service", "google")
                params = Params(language=_language(data.get("language")), model=data.get("model"),
                                options=data.get("options") or {})
                sample_rate = int(data.get("sample_rate", 16000))
                try:
                    service = get_service(service_name)
                    stream = await service.open_stream(params, sample_rate)
                except ServiceError as e:
                    stream = None
                    await send({"type": "error", "message": str(e)})
                    await send({"type": "done"})
                    continue
                received = 0
                model = params.model or service.default_model
                label = f"{service_name}/{model}"
                log.info("stream started: %s, language %s", label, params.language or "none (detect)")
                await send({"type": "started", "service": service_name, "model": model})
                reader = asyncio.create_task(forward(stream, label))
            elif data.get("type") == "end" and stream is not None:
                await stream.end()
                stream = None
    except WebSocketDisconnect:
        pass
    finally:
        if stream:
            await stream.cancel()
        if reader:
            reader.cancel()
