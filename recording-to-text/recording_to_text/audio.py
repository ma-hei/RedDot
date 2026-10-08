"""Reading and writing WAV files (16-bit mono PCM, as the red dot's debug recordings are)."""

from __future__ import annotations

import io
import wave
from pathlib import Path

from .types import Recording, ServiceError


def read_wav(source: str | Path | bytes) -> Recording:
    """A WAV file (path or the file's bytes) as a Recording. Only 16-bit mono is accepted."""
    try:
        with wave.open(io.BytesIO(source) if isinstance(source, bytes) else str(source), "rb") as w:
            if w.getnchannels() != 1 or w.getsampwidth() != 2:
                raise ServiceError(f"expected 16-bit mono audio, got {w.getnchannels()} channel(s) "
                                   f"of {8 * w.getsampwidth()} bit")
            return Recording(w.readframes(w.getnframes()), w.getframerate())
    except (wave.Error, EOFError) as e:
        raise ServiceError(f"not a readable WAV file ({e})") from e


def to_wav(recording: Recording) -> bytes:
    """The Recording as WAV file bytes, for services that want a file upload."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(recording.sample_rate)
        w.writeframes(recording.pcm)
    return buffer.getvalue()
