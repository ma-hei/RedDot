"""Google Cloud Speech-to-Text v2, model chirp_2.

Measured on German test audio for voice-input (2026-09-30), language fixed to de-DE:

    model       where         accuracy        confidence
    chirp_2     us-central1   best            yes (0.98 clear, 0.89 degraded, ~0.85 English)
    chirp_3     us / eu       as good         no, always 0.0
    long/short  global        worse on noise  yes, but high even for wrong words

Language: "de-DE" etc. as given; a bare "de" is sent as is too. language=None sends "auto", and
the language the model detected comes back in Transcript.language.

Settings (environment): GOOGLE_PROJECT (required), GOOGLE_LOCATION (default us-central1).

extras:
    billed_seconds   what Google bills for this request (rounded up by Google)
    results          the parts a longer recording came back as: text, confidence, language, end
"""

from __future__ import annotations

import time

from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import GoogleAPICallError
from google.cloud import speech_v2
from google.cloud.speech_v2 import types as st

from ..types import Capabilities, Params, Recording, ServiceError, Transcript, Word
from .base import Service


class GoogleSpeech(Service):
    name = "google"
    default_model = "chirp_2"
    capabilities = Capabilities(streaming=True, confidence=True, word_times=True, language_detection=True)

    def __init__(self, project: str, location: str = "us-central1") -> None:
        # "_" is the default recognizer: all settings go with each request instead of being
        # stored in a named recognizer resource.
        self._recognizer = f"projects/{project}/locations/{location}/recognizers/_"
        self._options = ClientOptions(
            api_endpoint="speech.googleapis.com" if location == "global" else f"{location}-speech.googleapis.com",
            # Bill this project, whatever the login's default quota project is.
            quota_project_id=project,
        )
        self._client: speech_v2.SpeechAsyncClient | None = None  # created on first use, inside the event loop

    async def transcribe(self, recording: Recording, params: Params) -> Transcript:
        model = params.model or self.default_model
        if self._client is None:
            self._client = speech_v2.SpeechAsyncClient(client_options=self._options)
        config = st.RecognitionConfig(
            explicit_decoding_config=st.ExplicitDecodingConfig(
                encoding=st.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=recording.sample_rate,
                audio_channel_count=1,
            ),
            language_codes=[params.language or "auto"],
            model=model,
            features=st.RecognitionFeatures(
                enable_automatic_punctuation=params.options.get("punctuation", True),
                enable_word_time_offsets=True,
                enable_word_confidence=True,
            ),
        )
        start = time.monotonic()
        try:
            response = await self._client.recognize(
                request=st.RecognizeRequest(recognizer=self._recognizer, config=config, content=recording.pcm)
            )
        except GoogleAPICallError as e:
            raise ServiceError(f"Google Speech-to-Text: {e.message or e}") from e
        latency_ms = int((time.monotonic() - start) * 1000)

        results = [r for r in response.results if r.alternatives]
        best = [r.alternatives[0] for r in results]
        text = " ".join(a.transcript.strip() for a in best).strip()
        # A longer recording can come back in several parts; the least certain one decides.
        # Google reports 0.0 when a model has no confidence at all (e.g. chirp_3).
        scores = [a.confidence for a in best]
        confidence = min(scores) if scores and any(scores) else None
        words = [
            Word(w.word, w.start_offset.total_seconds(), w.end_offset.total_seconds(), w.confidence or None)
            for a in best for w in a.words
        ]
        detected = next((r.language_code for r in results if r.language_code), None)
        return Transcript(
            text=text,
            confidence=confidence,
            language=detected or params.language,
            service=self.name,
            model=model,
            latency_ms=latency_ms,
            words=words,
            extras={
                "billed_seconds": response.metadata.total_billed_duration.total_seconds(),
                "results": [
                    {"text": a.transcript.strip(), "confidence": a.confidence or None,
                     "language": r.language_code or None, "end": r.result_end_offset.total_seconds()}
                    for r, a in zip(results, best)
                ],
            },
        )
