"""Google Cloud Speech-to-Text v2, model chirp_2.

Measured on German test audio for voice-input (2026-09-30), language fixed to de-DE:

    model       where         accuracy        confidence
    chirp_2     us-central1   best            yes (0.98 clear, 0.89 degraded, ~0.85 English)
    chirp_3     us / eu       as good         no, always 0.0
    long/short  global        worse on noise  yes, but high even for wrong words

Language: "de-DE" etc. as given; a bare "de" is sent as is too. language=None sends "auto", and
the language the model detected comes back in Transcript.language.

Streaming (mode 1): StreamingRecognize with interim results. Google sends guesses while you speak
(final=False) and settles a stretch of speech when it hears a pause (final=True); one stream can
hold several settled stretches. Word times count from the start of the stream. A stream may last
at most 5 minutes (Google's limit).

Streaming differs a lot between models (measured 2026-10-08, a 5 s German sentence sent in real time):

    model       partial results while speaking           final result
    chirp_2     none: the whole text comes at the end     ~1 s after the audio ends
    long        one per 100 ms, ~100 ms behind the audio  ~0.6 s after the audio ends

Models live in different regions; MODEL_LOCATIONS picks the endpoint per model.

Settings (environment): GOOGLE_PROJECT (required); GOOGLE_LOCATION overrides MODEL_LOCATIONS for
every model.

extras (mode 2):
    billed_seconds   what Google bills for this request (rounded up by Google)
    results          the parts a longer recording came back as: text, confidence, language, end
extras (mode 1):
    stability        partial results: how likely Google thinks the guess won't change, 0..1
    end              seconds from the start of the stream to the end of this text
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator

from google.api_core.client_options import ClientOptions
from google.api_core.exceptions import GoogleAPICallError
from google.cloud import speech_v2
from google.cloud.speech_v2 import types as st

from ..types import Capabilities, Params, Recording, ServiceError, Transcript, Word
from .base import QueueStream, Service, Stream


# Where each model is available (Speech-to-Text v2 locations). Other models: GOOGLE_LOCATION, or
# us-central1.
MODEL_LOCATIONS = {
    "chirp_2": "us-central1",
    "chirp_3": "us",
    "long": "global",
    "short": "global",
    "telephony": "global",
}


class GoogleSpeech(Service):
    name = "google"
    default_model = "chirp_2"
    capabilities = Capabilities(streaming=True, confidence=True, word_times=True, language_detection=True)

    def __init__(self, project: str, location: str | None = None) -> None:
        self._project = project
        self._location = location  # None: per model, from MODEL_LOCATIONS
        self._clients: dict[str, speech_v2.SpeechAsyncClient] = {}  # by location, created on first use

    def _endpoint(self, model: str) -> tuple[speech_v2.SpeechAsyncClient, str]:
        """The client for the model's location, and the recognizer to name in requests."""
        location = self._location or MODEL_LOCATIONS.get(model, "us-central1")
        if location not in self._clients:  # created on first use, inside the event loop
            self._clients[location] = speech_v2.SpeechAsyncClient(client_options=ClientOptions(
                api_endpoint="speech.googleapis.com" if location == "global" else f"{location}-speech.googleapis.com",
                # Bill this project, whatever the login's default quota project is.
                quota_project_id=self._project,
            ))
        # "_" is the default recognizer: all settings go with each request instead of being
        # stored in a named recognizer resource.
        return self._clients[location], f"projects/{self._project}/locations/{location}/recognizers/_"

    def _config(self, params: Params, sample_rate: int, model: str) -> st.RecognitionConfig:
        return st.RecognitionConfig(
            explicit_decoding_config=st.ExplicitDecodingConfig(
                encoding=st.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=sample_rate,
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

    async def transcribe(self, recording: Recording, params: Params) -> Transcript:
        model = params.model or self.default_model
        client, recognizer = self._endpoint(model)
        config = self._config(params, recording.sample_rate, model)
        start = time.monotonic()
        try:
            response = await client.recognize(
                request=st.RecognizeRequest(recognizer=recognizer, config=config, content=recording.pcm)
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
        words = [_word(w) for a in best for w in a.words]
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

    async def open_stream(self, params: Params, sample_rate: int = 16000) -> Stream:
        model = params.model or self.default_model
        stream = QueueStream()
        stream.run(self._stream(stream, self._config(params, sample_rate, model), model, params))
        return stream

    async def _stream(self, stream: QueueStream, config: st.RecognitionConfig, model: str, params: Params) -> None:
        client, recognizer = self._endpoint(model)
        last_sent = time.monotonic()  # when the newest audio went out: latency is measured from there

        async def requests() -> AsyncIterator[st.StreamingRecognizeRequest]:
            nonlocal last_sent
            # The first request carries only the settings; the audio follows in the next ones.
            yield st.StreamingRecognizeRequest(
                recognizer=recognizer,
                streaming_config=st.StreamingRecognitionConfig(
                    config=config,
                    streaming_features=st.StreamingRecognitionFeatures(interim_results=True),
                ),
            )
            while (chunk := await stream.audio.get()) is not None:
                last_sent = time.monotonic()
                yield st.StreamingRecognizeRequest(audio=chunk)

        def transcript(text: str, final: bool, **fields) -> Transcript:
            return Transcript(text=text.strip(), service=self.name, model=model,
                              latency_ms=int((time.monotonic() - last_sent) * 1000), final=final, **fields)

        try:
            responses = await client.streaming_recognize(requests=requests())
            async for response in responses:
                results = [r for r in response.results if r.alternatives]
                for r in results:
                    if r.is_final:
                        a = r.alternatives[0]
                        await stream.put(transcript(
                            a.transcript, True, confidence=a.confidence or None,
                            language=r.language_code or params.language,
                            words=[_word(w) for w in a.words],
                            extras={"end": r.result_end_offset.total_seconds()},
                        ))
                # The guesses for the stretch still being spoken, possibly in several pieces.
                partial = [r for r in results if not r.is_final]
                if partial:
                    await stream.put(transcript(
                        "".join(r.alternatives[0].transcript for r in partial), False,
                        confidence=None, language=partial[0].language_code or params.language,
                        extras={"stability": round(min(r.stability for r in partial), 2),
                                "end": partial[-1].result_end_offset.total_seconds()},
                    ))
        except GoogleAPICallError as e:
            raise ServiceError(f"Google Speech-to-Text: {e.message or e}") from e


def _word(w: st.WordInfo) -> Word:
    return Word(w.word, w.start_offset.total_seconds(), w.end_offset.total_seconds(), w.confidence or None)
