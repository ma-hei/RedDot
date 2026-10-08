"""The contract every speech-to-text service fulfils.

Mode 2: `transcribe(recording, params)` gets a whole recording and returns one Transcript.
Mode 1: `open_stream(params)` returns a Stream (for services that can't stream, one built from
transcribe(), per utterance): audio goes in with send() while it's recorded,
Transcripts come out of updates() while it's being recognised, partial ones (final=False, may
still change) and settled ones (final=True). end() says there's no more audio; updates() then
delivers what's left and stops.

Nothing else in RecordingToText knows which engine is behind a service, so services can be
added, swapped and compared on the same audio.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from ..types import Capabilities, Params, Recording, ServiceError, Transcript


class Stream(ABC):
    """Mode 1: one stream of audio (16-bit mono PCM), from the first chunk to end()."""

    @abstractmethod
    async def send(self, pcm: bytes) -> None:
        """Add the next piece of audio (any length; the red dot sends 100 ms at a time)."""

    @abstractmethod
    async def end(self) -> None:
        """No more audio. The remaining results still arrive in updates()."""

    @abstractmethod
    def updates(self) -> AsyncIterator[Transcript]:
        """Transcripts as they come; stops after end() once everything has arrived.
        Raises ServiceError if the service fails."""

    async def cancel(self) -> None:
        """Stop at once, without waiting for results (e.g. the client went away)."""


class QueueStream(Stream):
    """A Stream built on two queues: audio in, results out. A service's stream subclasses it,
    starts its work with run() and puts results (or a ServiceError) with put()."""

    def __init__(self) -> None:
        self.audio: asyncio.Queue[bytes | None] = asyncio.Queue()  # None: end of audio
        self._out: asyncio.Queue[Transcript | Exception | None] = asyncio.Queue()  # None: finished
        self._task: asyncio.Task | None = None

    def run(self, work) -> None:
        """Run the service's coroutine; whatever happens, updates() stops after it."""
        async def guarded() -> None:
            try:
                await work
            except asyncio.CancelledError:
                raise
            except ServiceError as e:
                await self._out.put(e)
            except Exception as e:  # an unexpected failure must not leave updates() waiting forever
                await self._out.put(ServiceError(f"{type(e).__name__}: {e}"))
            finally:
                await self._out.put(None)
        self._task = asyncio.create_task(guarded())

    async def put(self, transcript: Transcript) -> None:
        await self._out.put(transcript)

    async def send(self, pcm: bytes) -> None:
        await self.audio.put(pcm)

    async def end(self) -> None:
        await self.audio.put(None)

    async def updates(self) -> AsyncIterator[Transcript]:
        while (item := await self._out.get()) is not None:
            if isinstance(item, Exception):
                raise item
            yield item

    async def cancel(self) -> None:
        if self._task:
            self._task.cancel()
        await self._out.put(None)


class Service(ABC):
    name: str                    # how callers pick it, e.g. "google"
    default_model: str
    capabilities: Capabilities

    @abstractmethod
    async def transcribe(self, recording: Recording, params: Params) -> Transcript:
        """Transcribe a whole recording (mode 2). Silence is not an error: return text=""."""

    async def open_stream(self, params: Params, sample_rate: int = 16000) -> Stream:
        """Start a stream (mode 1). Services that stream natively override this; the others get
        one result per utterance, cut at pauses (per_utterance.py)."""
        from .per_utterance import PerUtteranceStream

        try:
            return PerUtteranceStream(self, params, sample_rate)
        except ValueError as e:  # e.g. a sample rate the voice detector can't handle
            raise ServiceError(str(e)) from e

    async def close(self) -> None:
        """Release connections. Called once when RecordingToText shuts down."""
