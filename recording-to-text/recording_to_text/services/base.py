"""The contract every speech-to-text service fulfils.

A service gets a Recording and Params and returns a Transcript. Nothing else in RecordingToText
knows which engine is behind it, so services can be added, swapped and compared on the same audio.
Streaming (mode 1) is added to this contract in step 4.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..types import Capabilities, Params, Recording, Transcript


class Service(ABC):
    name: str                    # how callers pick it, e.g. "google"
    default_model: str
    capabilities: Capabilities

    @abstractmethod
    async def transcribe(self, recording: Recording, params: Params) -> Transcript:
        """Transcribe a whole recording (mode 2). Silence is not an error: return text=""."""

    async def close(self) -> None:
        """Release connections. Called once when RecordingToText shuts down."""
