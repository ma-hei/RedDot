# RedDot

![RedDot: the red dot with four recorded utterances around it](docs/screenshot.png)

**RedDot is a frontend for voice input.** Hold the red dot and speak: the dot reacts while it hears speech, and a speech bubble pops up above it and grows while you talk, its tail pointing at the dot. Tap a bubble to hear what you said again, drag bubbles and the dot around the screen.

The goal of the project is a **testbed for AI agents that process voice recordings**: speech-to-text engines, language models and agents that act on what was said. Each utterance is a self-contained recording, which makes it easy to send the same audio to several agents and **compare their results side by side**. The voice input, speech detection and utterance handling are in place; connecting and comparing agents is the next step (see [Roadmap](#roadmap)).

## Features

- **Push to talk:** hold the dot (mouse, finger or the `R` key) to record; let go to stop.
- **Live speech detection:** a backend judges every 100 ms of audio (loudness + WebRTC voice activity detection); the dot turns a more intense red, glows and moves faster while speech is heard.
- **Utterances:** the audio is cut into utterances at pauses (0.7 s of quiet), when you let go, or after 15 s.
- **Speech bubbles:** each press of the dot gets a speech bubble. It pops up when the first utterance starts: above the dot, a little to the right or left, if there's room; only if older bubbles (or the screen's edge) take up the space above, below the dot. It grows with the seconds of speech it holds (all the utterances of that press) up to a full size (20 s). While the press goes on, it moves with the dot and its tail points at the dot; when you let go, it stays where it is and its tail keeps its direction. Tap it to play its utterances one after the other, drag it to arrange your bubbles, or drop it on the **bin** at the bottom of the screen to remove it (with its text).
- **Speech-to-text (optional):** the text of a bubble's utterances appears inside it, with the service's confidence; a text longer than the bubble shows its newest words, and the mouse wheel over the bubble scrolls back. **Per utterance** (mode 2): each pause ends an utterance, and its audio is sent right then; its text follows 1–2 s later. **Live** (mode 1): everything said during one press is one utterance; your words appear with the bubble and are revised as you go, and settle when you let go. **Dot always on** (an option for these two): the dot listens all the time, no holding (but not while the tab is hidden); **click the dot** (or press `R`) to end the current bubble there, and listening goes on into the next one. With Per utterance, pauses still end utterances by themselves (in the same bubble). Dragging the dot just moves it. **Per press** (mode 3): like Live, the whole press is one utterance, but nothing is sent while you hold the dot; when you let go, the press goes as one recording (Google: up to 1 minute). Service (Google long, Google chirp_2, Whisper) and language (German, English, detect) are chosen with the small settings button in the corner; it goes through [RecordingToText](recording-to-text/README.md).
- **Draggable dot:** pick up the dot while recording and move it around.
- **Full-screen WebGL:** the dot and bubbles are drawn by a fragment shader, on desktop and mobile.
- **Private by design:** recordings stay in the browser. The backend only judges the audio, and saves nothing unless debug recording is switched on.

## Architecture

```mermaid
flowchart LR
  subgraph browser["Browser (React + WebGL)"]
    mic["Microphone"] --> rec["pcm-recorder.js<br/>AudioWorklet: 16 kHz, 100 ms chunks"]
    rec --> link["link.ts<br/>WebSocket, numbers and keeps sent chunks"]
    link --> dot["RedDot.tsx<br/>state, pointer and keyboard input"]
    dot --> bubbles["speechBubbles.ts<br/>bubbles, growth, placement, playback"]
    dot --> gl["renderer.ts<br/>WebGL2 shader: dot + bubbles"]
    bubbles --> gl
  end
  subgraph backend["Backend (FastAPI)"]
    ws["/ws"] --> check["speech_check.py<br/>loudness + WebRTC VAD"]
    check --> utt["utterances.py<br/>start / end state machine"]
  end
  link -- "mic on/off, PCM chunks" --> ws
  ws -- "verdict per chunk,<br/>utterance ended: chunks first..last" --> link
```

### How a recording travels

1. **Recording:** while the dot is held, the AudioWorklet `pcm-recorder.js` turns the microphone into 16 kHz, 16-bit mono PCM and hands over 100 ms chunks. `link.ts` sends each chunk over a WebSocket, numbers it, and keeps the last 60 seconds of chunks in memory.
2. **Speech detection:** for every chunk, the backend checks two things: is it loud enough (RMS), and does WebRTC's voice detector hear a voice in most of its 20 ms frames? It answers with a **verdict** (`speech: true/false`), which drives the dot's look.
3. **Utterances:** a small state machine in the backend turns the verdicts into utterances: 200 ms of speech starts one (plus 300 ms of audio from just before, so the first syllable isn't cut), 700 ms of quiet, letting go or 15 seconds end it. With speech-to-text Per press, pauses and the 15 seconds don't end it: one press is one utterance. With Live, the same, and with "Dot always on" the page listens all the time and a click on the dot ends the utterance (`{"type": "cut"}`); after 280 s the backend starts a new one itself, because a stream to Google may last at most 5 minutes.
4. **Bubbles:** when an utterance starts, the backend says so, and it joins the bubble of the current press (the first one makes the bubble pop up); the bubble grows while it's spoken. When it ends, the backend only sends the **numbers of the chunks** it consists of. The browser assembles the audio from the chunks it kept and keeps it with the bubble. The audio never has to travel back, and the server stores nothing.
5. **Playback:** tapping a bubble plays its utterances with the Web Audio API.

### The protocol (WebSocket `/ws`)

| Direction | Message | Meaning |
|---|---|---|
| page → server | `{"type": "mic", "on": true \| false}` | the dot was pressed / released |
| page → server | binary, 3200 bytes | 100 ms of 16 kHz 16-bit mono PCM, only while pressed |
| server → page | `{"type": "verdict", "speech": bool, "rms": int}` | one per chunk |
| server → page | `{"type": "utterance", "event": "started", "first": n, "seconds": s}` | speech was heard: an utterance starts with chunk `n` (`s`: its length so far, including the audio from just before) |
| server → page | `{"type": "utterance", "event": "ended", "first": n, "last": m, "seconds": s}` | an utterance consists of the chunks numbered `first..last` (counted from 1 per connection) |
| server → page | `{"type": "utterance", "event": "discarded", "first": n}` | the utterance that started with chunk `n` had too little speech (a click, a cough): no `ended` will come |
| page → server | `{"type": "settings", "mode": "stream" \| "recording" \| "press" \| "off", "service": ..., "model": ..., "language": ... \| null}` | speech-to-text settings; sent on connect and on every change. A change while the dot listens ends the current line (finished with the old settings); the next line uses the new ones |
| server → page | `{"type": "transcription", "available": bool}` | once on connect: whether the backend has RecordingToText |
| server → page | `{"type": "text", "line": n \| null, "text": ..., "final": bool, "confidence": c \| null}` | the text for the line whose first chunk is `n`, or (`null`) for the line still being spoken; `final: false` while it can change |
| server → page | `{"type": "text_error", "message": ...}` | a speech-to-text problem, shown in the settings |
| page → server | `{"type": "cut"}` | "Dot always on": end the current line here and go on listening into a new one (a click on the dot) |

`GET /healthz` answers `{"ok": true}`; the page polls it while the backend is unreachable before opening the WebSocket (Firefox slows down repeated failed WebSocket attempts).

### Repository layout

```
red-dot/                              the React app (Vite, TypeScript)
├── public/pcm-recorder.js            AudioWorklet: microphone -> 100 ms PCM chunks
├── vite.config.ts                    dev proxy: /ws and /healthz -> backend on :8090
└── src/components/RedDotCode/
    ├── RedDotPage.tsx                full-screen page
    ├── RedDot.tsx                    the component: state, input, animation loop
    ├── looks.ts                      the dot's and the bubbles' look (design them here)
    ├── renderer.ts                   WebGL2: one full-screen shader draws everything
    ├── speechBubbles.ts              speech bubbles: growth, placement, hit testing, playback
    ├── bubbleLabels.ts               the text inside each bubble (HTML over the canvas)
    ├── SettingsPanel.tsx             the settings button and panel (speech-to-text)
    ├── settings.ts                   what the panel offers, remembered in the browser
    ├── uiText.ts                     the panel's texts in English and German (VITE_UI_LANGUAGE)
    ├── link.ts                       WebSocket, microphone, chunk store, recordings
    ├── useVoiceLink.ts               React hook around link.ts
    └── redDotServer/                 the backend (FastAPI)
        ├── server.py                 /healthz and /ws, origin check, logging
        ├── speech_check.py           is this 100 ms chunk speech?
        ├── utterances.py             cuts the stream into utterances
        ├── transcriber.py            optional: speech-to-text through RecordingToText, text to the page
        └── requirements.txt
recording-to-text/                    RecordingToText: one interface to several speech-to-text
                                      services (Google, Whisper); see its README
docs/screenshot.png
```

### Design decisions

- **React renders the canvas once; the animation runs outside React.** 60 frames and 10 verdicts per second live in refs, not in React state, so they never cause re-renders.
- **One shader draws everything.** For each pixel it computes the distance to the dot's (wobbling) edge and to every bubble's oval and tail. The looks are plain numbers in `looks.ts`.
- **The backend decides, the browser keeps the audio.** Speech detection runs in one place, so every client is judged the same way, while recordings stay on the device.
- **Only your own page may connect.** CORS covers `/healthz`, an explicit `Origin` check covers the WebSocket (`ALLOWED_ORIGINS`).

## Running it locally

**Requirements:** Node.js 22 or newer (developed with 24) and Python 3.10 or newer (developed with 3.12). Microphone access works on `http://localhost` and on `https://` pages.

### 1. Install

```bash
cd red-dot && npm install
cd src/components/RedDotCode/redDotServer && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

### 2. Start the backend (terminal 1)

```bash
cd red-dot/src/components/RedDotCode/redDotServer && .venv/bin/uvicorn server:app --port 8090
```

The terminal shows one log line per 100 ms chunk while you talk, and every utterance. Locally, each utterance is also saved as a WAV file in `debug-audio/` (see [Configuration](#configuration)).

**Optional: speech-to-text.** To see the text of what you say inside the bubbles, start
RecordingToText first (another terminal; setup in [recording-to-text/README.md](recording-to-text/README.md)):

```bash
cd recording-to-text && .venv/bin/uvicorn recording_to_text.server:app --port 8092
```

and start the backend with its address:

```bash
cd red-dot/src/components/RedDotCode/redDotServer && RECORDING_TO_TEXT_URL=http://localhost:8092 .venv/bin/uvicorn server:app --port 8090
```

Choose mode, service and language with the settings button in the bottom right corner of the
page (default: Live, Google long, German). The backend's terminal also logs the text, in lines
starting with `>>>`.

### 3. Start the frontend (terminal 2)

```bash
cd red-dot && npm run dev
```

Open **http://localhost:5173**. Use `localhost`, not `127.0.0.1`: the backend only accepts the origins listed in `ALLOWED_ORIGINS`.

### 4. Test it

1. The dot is **red** (connected); grey means the page can't reach the backend.
2. **Hold the dot and say a sentence.** The backend logs `SPEECH`, the dot turns a more intense red and moves faster.
3. **While you speak:** the backend logs `utterance started`, and a speech bubble pops up above the dot (a little to the side) and grows, its tail pointing at the dot. Pause and speak again: it keeps growing (up to its full size). Drag the dot while you speak: the bubble comes along. Let go: the bubble is complete and stays where it is (its tail too), and the next press gets a new one.
4. **Tap the bubble:** you hear what you said; its outline turns white while it plays.
5. **Drag the bubble and the dot** around the screen; they stay on screen. Drop a bubble on the bin to remove it.
6. **Hold `R`** to record without moving the dot.

There are no automated tests yet. `npm run build` type-checks the frontend (`tsc -b`) before building, and `npm run lint` runs the linter.

## Configuration

**Backend** (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `http://localhost:5173` | comma-separated list of origins whose pages may connect, e.g. `https://example.com` |
| `DEBUG_AUDIO_DIR` | `debug-audio` | where every utterance is saved as a WAV file; **empty: save nothing** (use that in production) |
| `VAD_MIN_RMS` | `200` | how loud a chunk must be to count as speech (16-bit scale; speech is typically 1000–5000) |
| `VAD_MODE` | `3` | WebRTC VAD strictness, 0 (lenient) to 3 (strictest) |
| `RECORDING_TO_TEXT_URL` | – (off) | where RecordingToText runs, e.g. `http://localhost:8092`; empty: no speech-to-text. Service, model and language are chosen on the page |

**Frontend** (build time, in `red-dot/.env.production`; for development in `red-dot/.env.local`, which git ignores, or in front of the command, e.g. `VITE_UI_LANGUAGE=de npm run dev`). Vite writes the values into the built page; they can't be changed in the page itself.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_BACKEND_URL` | – (the page's own address) | the backend's public address, e.g. `https://api.example.com`. Leave it unset for development: Vite's proxy forwards `/ws` and `/healthz` to `localhost:8090` |
| `VITE_UI_LANGUAGE` | `en` | the settings menu's language: `de` for German, otherwise English (`uiText.ts` has the texts) |

## Deployment

The frontend is a static site; the backend is a small Python service behind a reverse proxy. Two (sub)domains, both with HTTPS (browsers only allow the microphone on secure pages), for example `example.com` for the page and `api.example.com` for the backend.

### Backend

1. Copy `red-dot/src/components/RedDotCode/redDotServer/` to the server (without `.venv`, `__pycache__`, `debug-audio`), create the environment there and install `requirements.txt`.
2. Run it permanently, only reachable from the server itself, e.g. with a systemd unit:

   ```ini
   [Unit]
   Description=RedDot speech detector
   After=network.target

   [Service]
   User=reddot
   WorkingDirectory=/home/reddot/redDotServer
   Environment=ALLOWED_ORIGINS=https://example.com
   Environment=DEBUG_AUDIO_DIR=
   ExecStart=/home/reddot/redDotServer/.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8090
   Restart=always

   [Install]
   WantedBy=multi-user.target
   ```

3. Put a reverse proxy with HTTPS in front of it. For nginx, the WebSocket needs HTTP/1.1, the upgrade headers and a long timeout (the socket is silent while nobody talks):

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8090;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_read_timeout 3600s;
     proxy_send_timeout 3600s;
   }
   ```

4. Check: `curl https://api.example.com/healthz` answers `{"ok":true}`.

### Frontend

1. Set the backend's address and the menu's language (`de` or leave it out for English), and build:

   ```bash
   cd red-dot && printf 'VITE_BACKEND_URL=https://api.example.com\nVITE_UI_LANGUAGE=de\n' > .env.production && npm run build
   ```

2. Upload `red-dot/dist/` to the web server's document root.
3. Serve the files, and send unknown paths to `index.html` (React Router decides in the browser what to show). `index.html` should not be cached; the hashed files in `assets/` can be cached forever:

   ```nginx
   location / {
     try_files $uri $uri/ /index.html;
   }
   location = /index.html {
     add_header Cache-Control "no-cache";
   }
   location ^~ /assets/ {
     expires 1y;
     add_header Cache-Control "public, immutable";
   }
   ```

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| The dot stays grey | backend not running; page origin not in `ALLOWED_ORIGINS` (backend log: `refused a WebSocket from ...`); right after a backend restart, wait a few seconds |
| WebSocket fails with HTTP 426 | the reverse proxy doesn't pass the upgrade: `proxy_http_version 1.1` and the `Upgrade` / `Connection` headers are missing |
| The connection drops every 60 s | the reverse proxy's read timeout is too short |
| "Could not start the microphone" | the page isn't served over HTTPS (or `localhost`), or microphone access was denied |
| No bubble while speaking, only once you let go | the backend is an older version that doesn't send `utterance started` |

## Roadmap

- **Agents behind one interface** (in progress: [RecordingToText](recording-to-text/README.md) does this for speech-to-text). Every finished utterance is a self-contained recording. The next step is a small interface for "processors" that take a recording and return a result (a transcript, a reply, an action), so that different speech-to-text engines (e.g. Google Cloud Speech-to-Text, Gemini, Whisper) and agents built on them can be plugged in and swapped without touching the UI.
- **Side-by-side comparison.** Send the same utterance to several processors at once and show their results, timings and confidence next to its bubble.
- **Speech detection in the browser.** Running voice activity detection locally (e.g. Silero VAD in WebAssembly) would make the dot react instantly and keep audio on the device, with the backend only needed for the agents.
- **Persistence.** Bubbles currently live in the page and disappear on reload.

## Privacy

Recordings stay in the browser's memory and are gone when the page is closed. The backend receives the audio only to judge it chunk by chunk; it doesn't store it unless `DEBUG_AUDIO_DIR` is set, which is the default for local development only. Set `DEBUG_AUDIO_DIR=` (empty) on any server other people use.

With `RECORDING_TO_TEXT_URL` set and speech-to-text on in the page's settings, the audio of each press also goes to RecordingToText, and from
there to the chosen speech-to-text service (Google Cloud or OpenAI), which processes it under its
own terms.
