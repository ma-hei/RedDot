# RecordingToText

One interface to several speech-to-text services. It gets audio, the name of a service and its
parameters (language, model, options), and returns a `Transcript`: the text, a confidence (if the
service has one), the language, word times, and service-specific `extras`.

- **Mode 2** (a recording in, one result out): Google and Whisper.
- **Mode 1** (a stream of audio in, a stream of results out): Google. Results are partial
  (`final: false`, may still change) while the audio comes in, and settled (`final: true`) once
  Google is sure. Whisper can't stream, so it's mode 2 only; asking for it in mode 1 gives an
  error.

## Use it

Setup (Google Cloud project, OpenAI key): [docs/setup.md](docs/setup.md). Then:

```bash
cd recording-to-text && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Transcribe the red dot's debug recordings with both services, once with German and once without a
language:

```bash
.venv/bin/python -m recording_to_text ../red-dot/src/components/RedDotCode/redDotServer/debug-audio/*.wav --service google,whisper --language de-DE,none
```

`--words` lists each word with its time and confidence; `--json` prints everything, including
the extras. From Python:

```python
from recording_to_text import Params, read_wav, transcribe

transcript = await transcribe(read_wav("hello.wav"), "whisper", Params(language=None))
```

### As a server

```bash
.venv/bin/uvicorn recording_to_text.server:app --port 8092
```

| Endpoint | Mode | What |
|---|---|---|
| `POST /transcribe?service=google&language=de-DE&model=...` | 2 | the body is a WAV file; answers a Transcript as JSON (`language=none`: detect) |
| WebSocket `/stream` | 1 | `{"type":"start","service":...,"language":...,"model":...}`, then binary PCM, then `{"type":"end"}`; answers `started`, `transcript` (many), `done` |
| `GET /services` | | the services and what each can do |
| `GET /health` | | `{"ok": true}` |

At startup, the server warms up every service before it answers: it logs in and opens the
connections with a free request (Google: each region; Whisper: the model list, which also checks
the key). That takes about 5 s, and then the first real request is as fast as the others; without
it, the first one took up to 7 s. The log says `warm-up: google ready`, or why a service isn't
usable (e.g. a rejected key); the server starts either way.

The protocol is described in full at the top of `recording_to_text/server.py`. One WebSocket can
carry any number of streams, one after another. There's no access check yet: localhost only until
it's deployed (step 7).

The red dot's backend is the first client: with `RECORDING_TO_TEXT_URL=ws://localhost:8092/stream`
it streams each press of the dot here and logs the text (see `transcriber.py` there and the main
README).

## Services

| Name | What | Confidence | Word times | No language (detection) | Streaming |
|---|---|---|---|---|---|
| `google` | Google Cloud Speech-to-Text v2, `chirp_2` by default; also `long`, `short`, `chirp_3` | yes | yes | yes (`auto`), not with `long` | yes |
| `whisper` | Whisper through the OpenAI transcription API, `whisper-1` | derived from token probabilities | yes | yes | no (mode 2 only) |

**Google's models stream very differently** (a 5 s German sentence, sent in real time):

| Model | Partial results while speaking | Final result |
|---|---|---|
| `chirp_2` | none: the whole text comes at the end | ~1 s after the audio ends |
| `long` | one per 100 ms, ~100 ms behind the audio | ~0.6 s after the audio ends |

`long` is the one for live text; it can't detect the language, though, and its confidence is high
even for wrong words. Each model is in a different region; the service picks the right one.

The two confidences are measured differently and aren't comparable 1:1; see the comments at the
top of each file in `recording_to_text/services/`.

**Your own Whisper server instead of OpenAI:** self-hosted Whisper servers (e.g. Speaches /
faster-whisper, vLLM) offer the same transcription API. Set `WHISPER_BASE_URL` and `WHISPER_MODEL`
in `settings.env` and the server's key as `WHISPER_API_KEY` in `.env`; the code stays the same.

**Adding a service:** a class implementing `Service` (`services/base.py`), registered in
`FACTORIES` (`services/__init__.py`).

## Settings

`settings.env` (committed, no secrets) and `.env` (secrets, ignored by git); environment
variables win over both.

| Setting | Default | Meaning |
|---|---|---|
| `GOOGLE_PROJECT` | `your-speech-project` | the Google Cloud project that is billed |
| `GOOGLE_LOCATION` | – (per model) | forces one Speech-to-Text region for every model |
| `WHISPER_BASE_URL` | `https://api.openai.com/v1` | where the Whisper API is |
| `WHISPER_MODEL` | `whisper-1` | also `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (no word times) |
| `OPENAI_API_KEY` / `WHISPER_API_KEY` | – (in `.env`) | the key for the Whisper API |

## Layout

```
recording_to_text/
  types.py              Recording, Params, Transcript, Word, Capabilities, ServiceError
  audio.py              WAV in and out
  settings.py           loads settings.env and .env
  services/base.py      the contract every service fulfils (mode 2 and mode 1)
  services/google.py    Google chirp_2
  services/whisper.py   Whisper (OpenAI API or your own server)
  services/__init__.py  the services by name
  __main__.py           the command line (mode 2)
  server.py             HTTP (mode 2) and WebSocket (mode 1)
docs/setup.md           Google Cloud project and OpenAI key
```
