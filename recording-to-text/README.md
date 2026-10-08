# RecordingToText

One interface to several speech-to-text services. It gets audio, the name of a service and its
parameters (language, model, options), and returns a `Transcript`: the text, a confidence (if the
service has one), the language, word times, and service-specific `extras`.

- **Mode 2** (a recording in, one result out): ready, with Google chirp_2 and Whisper.
- **Mode 1** (a stream of audio in, a stream of results out): next.

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

## Services

| Name | What | Confidence | Word times | No language (detection) | Streaming |
|---|---|---|---|---|---|
| `google` | Google Cloud Speech-to-Text v2, `chirp_2` (us-central1) | yes | yes | yes (`auto`) | yes (step 4) |
| `whisper` | Whisper through the OpenAI transcription API, `whisper-1` | derived from token probabilities | yes | yes | no: per utterance (step 5) |

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
| `GOOGLE_LOCATION` | `us-central1` | the Speech-to-Text region (chirp_2) |
| `WHISPER_BASE_URL` | `https://api.openai.com/v1` | where the Whisper API is |
| `WHISPER_MODEL` | `whisper-1` | also `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` (no word times) |
| `OPENAI_API_KEY` / `WHISPER_API_KEY` | – (in `.env`) | the key for the Whisper API |

## Layout

```
recording_to_text/
  types.py              Recording, Params, Transcript, Word, Capabilities, ServiceError
  audio.py              WAV in and out
  settings.py           loads settings.env and .env
  services/base.py      the contract every service fulfils
  services/google.py    Google chirp_2
  services/whisper.py   Whisper (OpenAI API or your own server)
  services/__init__.py  the services by name
  __main__.py           the command line (mode 2)
docs/setup.md           Google Cloud project and OpenAI key
```
