"""What goes into RecordingToText and what comes out, the same for every service."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Recording:
    """Audio as 16-bit mono PCM (what the red dot records: 16 kHz)."""

    pcm: bytes
    sample_rate: int = 16000

    @property
    def seconds(self) -> float:
        return len(self.pcm) / 2 / self.sample_rate


@dataclass
class Params:
    """How to transcribe. Everything is optional; a service fills in its own defaults."""

    # The spoken language as a BCP-47 code ("de-DE") or a bare language ("de"). None: no
    # language is given and the service detects it itself (if it can).
    language: str | None = None
    # The service's model, e.g. "chirp_2" or "whisper-1". None: the service's default.
    model: str | None = None
    # Anything service-specific, passed through as is (e.g. Whisper's "prompt").
    options: dict = field(default_factory=dict)


@dataclass
class Word:
    text: str
    start: float | None = None        # seconds from the start of the recording
    end: float | None = None
    confidence: float | None = None   # 0..1, if the service reports it per word


@dataclass
class Transcript:
    """One result. Mode 2 returns exactly one; a stream (mode 1) yields several."""

    text: str                    # "" when nothing intelligible was heard
    confidence: float | None     # 0..1, or None if the service can't tell
    language: str | None         # the language requested, or the one the service detected
    service: str                 # e.g. "google"
    model: str                   # e.g. "chirp_2"
    latency_ms: int              # from sending the audio to having the answer
    words: list[Word] = field(default_factory=list)
    # Service-specific information (e.g. Whisper's probability that it heard no speech at all).
    # The keys are documented in each service's module.
    extras: dict = field(default_factory=dict)
    # Streams only: False while the text can still change, True once it's settled.
    final: bool = True

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Capabilities:
    """What a service can do, so callers (and the UI) know what to expect."""

    streaming: bool              # native streaming (mode 1); otherwise per utterance
    confidence: bool             # reports a confidence for the text
    word_times: bool             # start/end of each word
    language_detection: bool     # works with language=None


class ServiceError(Exception):
    """A service couldn't be used or failed; the message says why, in plain words."""
