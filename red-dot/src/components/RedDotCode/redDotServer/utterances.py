"""Cuts the stream of 100 ms chunks into utterances (one sentence each), so each can be
saved as its own WAV file.

Step 2 of the lab's detector (../detector.py). It doesn't judge the audio itself: the
server passes in step 1's verdict (speech_check.py) with every chunk.

            START_CHUNKS speech chunks in a row
    WAITING ----------------------------------> RECORDING
       ^                                            |
       |   END_CHUNKS quiet chunks in a row,        |
       +------------ or MAX_SECONDS reached <-------+
                     -> "ended" (with the audio), or "discarded" if it had
                        fewer than MIN_SPEECH_CHUNKS of speech

Letting go of the dot (or R) also ends an utterance: see finish().
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from speech_check import SAMPLE_RATE

START_CHUNKS = 2        # 200 ms of speech starts an utterance
END_CHUNKS = 7          # 700 ms of quiet ends it
PRE_ROLL_CHUNKS = 3     # keep 300 ms from before the start, so the first syllable isn't cut
MIN_SPEECH_CHUNKS = 3   # shorter than 300 ms of speech: a click or a cough
MAX_SECONDS = 15


@dataclass
class UtteranceEvent:
    event: str            # "started", "ended" or "discarded"
    seconds: float        # length of the utterance (so far, for "started")
    audio: bytes | None   # the whole utterance, for "ended"
    chunks: int = 0       # how many 100 ms chunks it has (so far), including the pre-roll


class UtteranceRecorder:
    def __init__(self) -> None:
        self._recording = False
        self._pre: deque[bytes] = deque(maxlen=PRE_ROLL_CHUNKS)
        self._chunks: list[bytes] = []
        self._speech_run = 0    # WAITING: speech chunks in a row
        self._quiet_run = 0     # RECORDING: quiet chunks in a row
        self._speech_total = 0  # RECORDING: speech chunks in this utterance

    @property
    def recording(self) -> bool:
        return self._recording

    def feed(self, chunk: bytes, is_speech: bool) -> UtteranceEvent | None:
        """Add one chunk and its verdict; returns an event when an utterance starts or stops."""
        if not self._recording:
            self._pre.append(chunk)
            self._speech_run = self._speech_run + 1 if is_speech else 0
            if self._speech_run >= START_CHUNKS:
                self._recording = True
                self._chunks = list(self._pre)
                self._speech_total, self._quiet_run = self._speech_run, 0
                return UtteranceEvent("started", self._seconds(), None, len(self._chunks))
            return None

        self._chunks.append(chunk)
        if is_speech:
            self._speech_total += 1
            self._quiet_run = 0
        else:
            self._quiet_run += 1
        if self._quiet_run >= END_CHUNKS or self._seconds() >= MAX_SECONDS:
            return self._end()
        return None

    def finish(self) -> UtteranceEvent | None:
        """The dot (or R) was let go: end the utterance being recorded, if any."""
        return self._end() if self._recording else None

    def _end(self) -> UtteranceEvent:
        seconds = self._seconds()
        count = len(self._chunks)
        if self._speech_total >= MIN_SPEECH_CHUNKS:
            event = UtteranceEvent("ended", seconds, b"".join(self._chunks), count)
        else:
            event = UtteranceEvent("discarded", seconds, None, count)
        self._recording = False
        self._pre.clear()
        self._chunks = []
        self._speech_run = self._quiet_run = self._speech_total = 0
        return event

    def _seconds(self) -> float:
        return sum(len(c) for c in self._chunks) / 2 / SAMPLE_RATE
