"""RecordingToText: one interface to several speech-to-text services.

    from recording_to_text import Params, read_wav, transcribe

    transcript = await transcribe(read_wav("hello.wav"), "google", Params(language="de-DE"))
    transcript.text, transcript.confidence, transcript.words, transcript.extras

Mode 2 (a recording in, one Transcript out) is `transcribe`. Mode 1 (a stream of audio in, a
stream of Transcripts out) follows in step 4.
"""

from __future__ import annotations

from .audio import read_wav, to_wav
from .services import FACTORIES, close_all, get_service
from .types import Capabilities, Params, Recording, ServiceError, Transcript, Word

__all__ = ["Capabilities", "Params", "Recording", "ServiceError", "Transcript", "Word",
           "read_wav", "to_wav", "transcribe", "services", "close_all"]


async def transcribe(recording: Recording, service: str, params: Params | None = None) -> Transcript:
    """Mode 2: transcribe a whole recording with the named service."""
    return await get_service(service).transcribe(recording, params or Params())


def services() -> list[str]:
    return list(FACTORIES)
