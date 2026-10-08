"""Cuts a stream of audio into utterances at pauses, for services that can't stream (mode 1).

The same rules as the red dot's backend (redDotServer/speech_check.py and utterances.py), so an
utterance here is what a line next to the dot is there. Audio is judged in blocks of 100 ms; a
block is speech if both are true:

    loud enough        RMS (average loudness) >= MIN_RMS
    sounds like voice  WebRTC's voice detector says "voice" for at least 60 % of its 20 ms frames

and the blocks are cut into utterances:

            START_BLOCKS speech blocks in a row
    WAITING ----------------------------------> RECORDING
       ^                                            |
       |   pause_ms of quiet, or MAX_SECONDS        |
       +--------------------------------------------+
            -> an utterance, unless it had less than MIN_SPEECH_BLOCKS of speech (a click, a cough)

end() of the stream ends the utterance being recorded, like letting go of the dot.
"""

from __future__ import annotations

import math
from array import array
from collections import deque
from dataclasses import dataclass

import webrtcvad

BLOCK_MS = 100
MIN_RMS = 200            # 16-bit scale: speech ~1000-5000, quiet room < 200
VAD_MODE = 3             # 0 (lenient) .. 3 (strictest about what is a voice)
VAD_FRAME_MS = 20        # WebRTC accepts 10, 20 or 30 ms frames
VOICED_SHARE = 0.6       # 3 of 5 frames must be voice
START_BLOCKS = 2         # 200 ms of speech starts an utterance
PAUSE_MS = 700           # this much quiet ends it (Params.options["pause_ms"] changes it)
PRE_ROLL_BLOCKS = 3      # keep 300 ms from before the start, so the first syllable isn't cut
MIN_SPEECH_BLOCKS = 3    # less than 300 ms of speech: not an utterance
MAX_SECONDS = 15         # a longer utterance is cut here


@dataclass
class Utterance:
    pcm: bytes
    start: float   # seconds from the start of the stream
    end: float


class UtteranceCutter:
    """Feed it audio with add(); it returns the utterances that are complete."""

    def __init__(self, sample_rate: int = 16000, pause_ms: int = PAUSE_MS) -> None:
        if sample_rate not in (8000, 16000, 32000, 48000):
            raise ValueError(f"the voice detector needs 8, 16, 32 or 48 kHz, not {sample_rate} Hz")
        self._rate = sample_rate
        self._vad = webrtcvad.Vad(VAD_MODE)
        self._block_bytes = sample_rate * BLOCK_MS // 1000 * 2
        self._frame_bytes = sample_rate * VAD_FRAME_MS // 1000 * 2
        self._end_blocks = max(1, round(pause_ms / BLOCK_MS))
        self._buffer = b""      # audio not yet judged (less than a block)
        self._blocks_seen = 0   # for the times: blocks since the start of the stream
        self._pre: deque[bytes] = deque(maxlen=PRE_ROLL_BLOCKS)
        self._recording = False
        self._blocks: list[bytes] = []
        self._start_block = 0
        self._speech_run = self._quiet_run = self._speech_total = 0

    def add(self, pcm: bytes) -> list[Utterance]:
        self._buffer += pcm
        done = []
        while len(self._buffer) >= self._block_bytes:
            block, self._buffer = self._buffer[:self._block_bytes], self._buffer[self._block_bytes:]
            if (u := self._feed(block)) is not None:
                done.append(u)
        return done

    def finish(self) -> Utterance | None:
        """The stream ended: the utterance being recorded (with the last bit of audio), if any."""
        if self._recording and self._buffer:
            self._blocks.append(self._buffer)
        self._buffer = b""
        return self._end() if self._recording else None

    def _feed(self, block: bytes) -> Utterance | None:
        self._blocks_seen += 1
        speech = self._is_speech(block)
        if not self._recording:
            self._pre.append(block)
            self._speech_run = self._speech_run + 1 if speech else 0
            if self._speech_run >= START_BLOCKS:
                self._recording = True
                self._blocks = list(self._pre)
                self._start_block = self._blocks_seen - len(self._blocks)
                self._speech_total, self._quiet_run = self._speech_run, 0
            return None
        self._blocks.append(block)
        if speech:
            self._speech_total += 1
            self._quiet_run = 0
        else:
            self._quiet_run += 1
        if self._quiet_run >= self._end_blocks or len(self._blocks) * BLOCK_MS / 1000 >= MAX_SECONDS:
            return self._end()
        return None

    def _end(self) -> Utterance | None:
        pcm = b"".join(self._blocks)
        start = self._start_block * BLOCK_MS / 1000
        keep = self._speech_total >= MIN_SPEECH_BLOCKS
        self._recording = False
        self._pre.clear()
        self._blocks = []
        self._speech_run = self._quiet_run = self._speech_total = 0
        return Utterance(pcm, start, start + len(pcm) / 2 / self._rate) if keep else None

    def _is_speech(self, block: bytes) -> bool:
        samples = array("h", block)
        rms = math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0.0
        frames = [block[i:i + self._frame_bytes] for i in range(0, len(block), self._frame_bytes)]
        frames = [f for f in frames if len(f) == self._frame_bytes]
        voiced = sum(self._vad.is_speech(f, self._rate) for f in frames)
        return rms >= MIN_RMS and bool(frames) and voiced / len(frames) >= VOICED_SHARE
