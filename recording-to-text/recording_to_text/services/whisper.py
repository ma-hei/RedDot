"""Whisper, through the OpenAI transcription API (POST {base_url}/audio/transcriptions).

The same API is offered by OpenAI itself and by self-hosted Whisper servers (e.g. Speaches, the
faster-whisper server, or vLLM), so moving from OpenAI to your own GPU machine only changes the
settings, not this code:

    setting             OpenAI (now)                  own GPU machine (later)
    WHISPER_BASE_URL    https://api.openai.com/v1     https://whisper.example.com/v1
    WHISPER_API_KEY     your OpenAI key               whatever key your server checks
    WHISPER_MODEL       whisper-1                     e.g. Systran/faster-whisper-large-v3

WHISPER_API_KEY falls back to OPENAI_API_KEY.

Language: a bare language code ("de"); "de-DE" is shortened to "de". language=None sends none,
and Whisper detects it; the detected language comes back in Transcript.language.

Confidence: Whisper reports no confidence directly. For each segment it reports the average
log-probability of its tokens (avg_logprob); exp() of that is the average probability per token,
0..1. The confidence here is that, averaged over the segments weighted by their length. It's a
different measure from Google's and shouldn't be compared 1:1 across services.

Models: whisper-1 (and self-hosted Whisper) return segments and word times ("verbose_json").
gpt-4o-transcribe / gpt-4o-mini-transcribe don't; for them the confidence comes from per-token
log-probabilities instead (include[]=logprobs), and there are no word times.

options (Params.options), passed through: "prompt" (words or a style to expect), "temperature".

extras:
    duration          seconds of audio, as Whisper measured it
    no_speech_prob    the highest probability over the segments that a segment had no speech at all
    segments          per segment: start, end, text, avg_logprob, no_speech_prob, compression_ratio
                      (a high compression ratio, > 2.4, hints at repeated, made-up text)
"""

from __future__ import annotations

import math
import time

import httpx

from ..audio import to_wav
from ..types import Capabilities, Params, Recording, ServiceError, Transcript, Word
from .base import Service


class Whisper(Service):
    name = "whisper"
    capabilities = Capabilities(streaming=False, confidence=True, word_times=True, language_detection=True)

    def __init__(self, base_url: str, api_key: str, model: str = "whisper-1") -> None:
        self.default_model = model
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=httpx.Timeout(120, connect=10),
        )

    async def transcribe(self, recording: Recording, params: Params) -> Transcript:
        model = params.model or self.default_model
        detailed = not model.startswith("gpt-")  # whisper-1 and self-hosted Whisper: segments and word times
        data: dict = {"model": model, "response_format": "verbose_json" if detailed else "json"}
        if detailed:
            data["timestamp_granularities[]"] = ["word", "segment"]
        else:
            data["include[]"] = ["logprobs"]
        if params.language:
            data["language"] = params.language.split("-")[0].lower()
        for key in ("prompt", "temperature"):
            if key in params.options:
                data[key] = str(params.options[key])

        start = time.monotonic()
        try:
            response = await self._client.post(
                "/audio/transcriptions", data=data,
                files={"file": ("recording.wav", to_wav(recording), "audio/wav")},
            )
        except httpx.HTTPError as e:
            raise ServiceError(f"Whisper: can't reach {self._client.base_url} ({type(e).__name__})") from e
        latency_ms = int((time.monotonic() - start) * 1000)
        if response.status_code != 200:
            raise ServiceError(f"Whisper: HTTP {response.status_code}: {_error_message(response)}")
        body = response.json()

        if detailed:
            confidence, extras = _from_segments(body.get("segments") or [])
            extras["duration"] = body.get("duration")
            words = [Word(w["word"].strip(), w.get("start"), w.get("end")) for w in body.get("words") or []]
        else:
            logprobs = [t["logprob"] for t in body.get("logprobs") or [] if "logprob" in t]
            confidence = math.exp(sum(logprobs) / len(logprobs)) if logprobs else None
            extras, words = {}, []
        return Transcript(
            text=(body.get("text") or "").strip(),
            confidence=confidence,
            # Whisper names the language it detected ("german"); a requested language is a code.
            language=body.get("language") or params.language,
            service=self.name,
            model=model,
            latency_ms=latency_ms,
            words=words,
            extras=extras,
        )

    async def close(self) -> None:
        await self._client.aclose()


def _from_segments(segments: list[dict]) -> tuple[float | None, dict]:
    """The confidence (length-weighted average of exp(avg_logprob)) and the segment extras."""
    extras: dict = {
        "segments": [
            {k: s.get(k) for k in ("start", "end", "text", "avg_logprob", "no_speech_prob", "compression_ratio")}
            for s in segments
        ],
    }
    if not segments:
        return None, extras
    weights = [max((s.get("end") or 0) - (s.get("start") or 0), 0.01) for s in segments]
    confidence = sum(w * math.exp(s.get("avg_logprob", 0.0)) for w, s in zip(weights, segments)) / sum(weights)
    extras["no_speech_prob"] = max(s.get("no_speech_prob", 0.0) for s in segments)
    return confidence, extras


def _error_message(response: httpx.Response) -> str:
    try:
        return response.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return response.text[:200]
