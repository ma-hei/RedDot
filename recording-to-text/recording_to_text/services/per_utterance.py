"""Mode 1 for services that can't stream (e.g. Whisper): one result per utterance.

The audio is cut into utterances at pauses (../utterances.py); each finished utterance is sent
to the service's transcribe() as a whole recording, and its result comes out of the stream as a
final Transcript. There are no partial results: the text of an utterance arrives once the pause
after it has been heard (pause_ms, default 700 ms) plus the time the service takes.

Utterances are transcribed one after another, in order, while the audio keeps coming in.

Transcript fields, compared with the service's own transcribe():
    words            times count from the start of the stream, not of the utterance
    extras.utterance {"start": s, "end": s}: where the utterance is in the stream
Params.options["pause_ms"] changes how long a pause ends an utterance.
"""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import TYPE_CHECKING

from ..types import Params, Recording
from ..utterances import PAUSE_MS, Utterance, UtteranceCutter
from .base import QueueStream

if TYPE_CHECKING:
    from .base import Service


class PerUtteranceStream(QueueStream):
    def __init__(self, service: Service, params: Params, sample_rate: int) -> None:
        super().__init__()
        self._cutter = UtteranceCutter(sample_rate, int(params.options.get("pause_ms", PAUSE_MS)))
        self.run(self._work(service, params, sample_rate))

    async def _work(self, service: Service, params: Params, sample_rate: int) -> None:
        todo: asyncio.Queue[Utterance | None] = asyncio.Queue()

        async def transcribe_in_order() -> None:
            while (u := await todo.get()) is not None:
                t = await service.transcribe(Recording(u.pcm, sample_rate), params)
                await self.put(replace(
                    t,
                    words=[replace(w, start=_shift(w.start, u.start), end=_shift(w.end, u.start)) for w in t.words],
                    extras={**t.extras, "utterance": {"start": round(u.start, 2), "end": round(u.end, 2)}},
                    final=True,
                ))

        worker = asyncio.create_task(transcribe_in_order())
        try:
            while (chunk := await self.audio.get()) is not None:
                for u in self._cutter.add(chunk):
                    await todo.put(u)
                if worker.done():  # the service failed: stop here, the error comes out of updates()
                    break
            else:
                if (u := self._cutter.finish()) is not None:
                    await todo.put(u)
            await todo.put(None)
            await worker
        finally:
            worker.cancel()


def _shift(t: float | None, by: float) -> float | None:
    return None if t is None else round(t + by, 3)
