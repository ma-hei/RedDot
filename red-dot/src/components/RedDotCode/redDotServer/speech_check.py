"""Is this 100 ms chunk of microphone audio speech?

Step 1 of the lab's detector (../detector.py), on its own: the orb only needs a yes/no
per chunk, not the utterance state machine. A chunk counts as speech if both are true:

    loud enough        RMS (average loudness) >= MIN_RMS
    sounds like voice  WebRTC's voice detector says "voice" for at least
                       VOICED_SHARE of the chunk's 20 ms frames

Neither check is enough alone: WebRTC sometimes calls background noise "voice", and
automatic gain control can make noise loud.
"""

from __future__ import annotations

import math
import os
from array import array
from dataclasses import dataclass

import webrtcvad

SAMPLE_RATE = 16000
MIN_RMS = float(os.getenv("VAD_MIN_RMS", "200"))  # 16-bit scale: speech ~1000-5000, quiet room < 200
VAD_MODE = int(os.getenv("VAD_MODE", "3"))        # 0 (lenient) .. 3 (strictest about what is a voice)
VAD_FRAME_MS = 20                                 # WebRTC accepts 10, 20 or 30 ms frames
VOICED_SHARE = 0.6                                # 3 of 5 frames must be voice


@dataclass
class ChunkCheck:
    rms: float
    voiced_frames: int
    total_frames: int
    is_speech: bool


class SpeechCheck:
    def __init__(self) -> None:
        self._vad = webrtcvad.Vad(VAD_MODE)
        self._frame_bytes = SAMPLE_RATE * VAD_FRAME_MS // 1000 * 2  # 2 bytes per 16-bit sample

    def check(self, chunk: bytes) -> ChunkCheck:
        """Judge one chunk of 16 kHz 16-bit mono PCM."""
        rms = _rms(chunk)
        frames = [chunk[i:i + self._frame_bytes] for i in range(0, len(chunk), self._frame_bytes)]
        frames = [f for f in frames if len(f) == self._frame_bytes]
        voiced = sum(self._vad.is_speech(f, SAMPLE_RATE) for f in frames)
        sounds_like_voice = bool(frames) and voiced / len(frames) >= VOICED_SHARE
        return ChunkCheck(rms=rms, voiced_frames=voiced, total_frames=len(frames),
                          is_speech=rms >= MIN_RMS and sounds_like_voice)


def _rms(chunk: bytes) -> float:
    samples = array("h", chunk)  # bytes -> 16-bit signed integers
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))
