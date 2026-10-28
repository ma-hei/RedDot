// Voice input: microphone, speech detection and utterances, all in the browser; with speech-to-text
// also the connection to the backend, which only transcribes. No React.
//
//   const link = createLink({ transcription, onStatus, onVerdict, onUtterance, onText, onTranscription, onTextError })
//   await link.press()   // start listening (opens the mic on first use); false if it couldn't
//   link.release()       // stop listening; ends the utterance being recorded
//   link.cut()           // while listening: end the current utterance here and go on with a new one
//   link.configure(s)    // speech-to-text settings (kept, and sent again after a reconnect)
//   link.dispose()       // close everything (a React component unmounting)
//
// Every 100 ms chunk is judged by Silero VAD (speechDetector.ts) and cut into utterances
// (utterances.ts), one after another in a queue (judging is asynchronous, the order must stay).
// The page numbers the chunks it records, from 1, without ever starting over; an utterance is
// named (its key) by its first chunk's number.
//
// ---------------- with speech-to-text: the protocol (see server.py) ----------------
// Page -> server, while a press goes on (and the backend was reachable when it started):
//   {"type": "mic", "on": true, "chunk": n}       a press starts; the next audio chunk is number n
//   binary, 3200 bytes                             each 100 ms chunk of 16 kHz 16-bit mono PCM
//   {"type": "utterance", "event": "ended", "first": n, "last": m}   transcribe chunks n..m
//   {"type": "cut"}                                a new stream from here (a click with "Dot always
//                                                  on", the 280 s limit, new settings)
//   {"type": "mic", "on": false}                   the press is over (after its last utterance)
// And any time: {"type": "settings", ...} (see transcriber.py). Server -> page: "transcription"
// (available or not), "text" (for an utterance, or for what is still being said), "text_error".

import { openMicrophone, SAMPLE_RATE } from './microphone.ts'
import type { Microphone } from './microphone.ts'
import { createSpeechDetector } from './speechDetector.ts'
import type { SpeechDetector } from './speechDetector.ts'
import { createUtteranceRecorder } from './utterances.ts'
import type { UtteranceEvent as RecorderEvent } from './utterances.ts'

export interface Verdict {
  type: 'verdict'
  speech: boolean                    // this 100 ms chunk counted as speech
  rms: number                        // loudness of the chunk (16-bit scale)
}

/** An utterance, named by its key: its first chunk. "ended" carries its audio. */
export type UtteranceEvent =
  | { event: 'started'; key: number; seconds: number }
  | { event: 'ended'; key: number; seconds: number; recording: Recording | null }
  | { event: 'discarded'; key: number }

/** Speech-to-text for one utterance (by its key: the first chunk), or for what is still being said (null). */
export interface TextMessage {
  type: 'text'
  line: number | null
  text: string
  final: boolean
  confidence: number | null
}

/** How the server should transcribe (see transcriber.py and settings.ts). */
export interface TranscriptionSettings {
  mode: 'stream' | 'recording' | 'press' | 'off'
  service: string
  model: string | null
  language: string | null      // null: the service detects it
}

/** One finished utterance, ready to play: 16-bit mono PCM. */
export interface Recording {
  pcm: Int16Array
  sampleRate: number
  seconds: number
}

// A "discriminated union": the `type` field tells TypeScript which one it is.
type ServerMessage =
  | TextMessage
  | { type: 'transcription'; available: boolean }
  | { type: 'text_error'; message: string }

/** Whether the dot can listen: 'connecting' while the speech detector loads. */
export type LinkStatus = 'connecting' | 'connected' | `microphone blocked: ${string}` | `unavailable: ${string}`

export interface LinkCallbacks {
  onStatus?: (status: LinkStatus) => void
  onVerdict?: (verdict: Verdict) => void
  onUtterance?: (event: UtteranceEvent) => void
  onText?: (text: TextMessage) => void
  onTranscription?: (available: boolean) => void
  onTextError?: (message: string) => void
}

export interface LinkOptions extends LinkCallbacks {
  transcription?: boolean      // speech-to-text through the backend (VITE_SPEECH_TO_TEXT=1)
}

export interface Link {
  press(): Promise<boolean>
  release(): void
  cut(): void
  configure(settings: TranscriptionSettings): void
  dispose(): void
}

// VITE_BACKEND_URL is read at build time (from .env.production).
// Empty, as in development: the page's own address, which Vite's proxy forwards to the backend.
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/+$/, '')

/** "/healthz" -> "https://api.example.com/healthz" (or just "/healthz" in development) */
function httpUrl(path: string): string {
  return BACKEND_URL + path
}

/** "/ws" -> "wss://api.example.com/ws" (https -> wss, http -> ws) */
function wsUrl(path: string): string {
  return (BACKEND_URL || location.origin).replace(/^http/, 'ws') + path
}

const UNREACHABLE = 'Speech-to-text: the backend can\'t be reached (is it running?)'

export function createLink({ transcription = false, onStatus = () => {}, onVerdict = () => {}, onUtterance = () => {},
                             onText = () => {}, onTranscription = () => {}, onTextError = () => {} }: LinkOptions = {}): Link {
  // ---------------- in the browser: microphone, speech detection, utterances ----------------
  let detector: SpeechDetector | null = null
  let mic: Promise<Microphone> | null = null  // opened on the first press, kept (see microphone.ts)
  let held = false        // press() called, release() not yet
  let talking = false     // held and the mic is ready: chunks are recorded and judged
  let disposed = false
  let chunkNumber = 0     // the last recorded chunk's number
  const recorder = createUtteranceRecorder()
  let queue: Promise<void> = Promise.resolve()

  const later = (job: () => Promise<void> | void) => {
    queue = queue.then(job).catch((err) => console.error('speech detection:', err))
  }

  // An utterance started (a bubble pops up), ended (with its audio) or was dropped. With
  // speech-to-text, the backend gets each ended one to transcribe. fromFeed: the recorder ended it
  // while listening (a pause, or its time limit), not finish() (letting go, a click, new settings).
  function done(ev: RecorderEvent | null, fromFeed = false): void {
    if (!ev) return
    if (ev.event === 'started') {
      onUtterance({ event: 'started', key: ev.first, seconds: ev.seconds })
    } else if (ev.event === 'discarded') {
      onUtterance({ event: 'discarded', key: ev.first })
    } else {
      onUtterance({ event: 'ended', key: ev.first, seconds: ev.seconds,
                    recording: { pcm: ev.pcm, sampleRate: SAMPLE_RATE, seconds: ev.seconds } })
      if (streaming) {
        send(JSON.stringify({ type: 'utterance', event: 'ended', first: ev.first, last: ev.last }))
        // One utterance per press, but it reached its time limit while the press goes on: the
        // backend starts a new stream (a Google stream may last at most 5 minutes).
        if (fromFeed && !recorder.splitAtPauses) send(JSON.stringify({ type: 'cut' }))
      }
    }
  }

  async function judge(chunk: ArrayBuffer, n: number): Promise<void> {
    if (!detector || disposed) return
    const verdict = await detector.check(chunk)
    onVerdict({ type: 'verdict', speech: verdict.speech, rms: Math.round(verdict.rms) })
    done(recorder.feed(chunk, n, verdict.speech), true)
  }

  function onChunk(chunk: ArrayBuffer): void {
    if (!talking) return
    const n = ++chunkNumber
    if (streaming && !send(chunk)) streaming = false   // the connection broke: this press goes on without text
    later(() => judge(chunk, n))
  }

  onStatus('connecting')
  createSpeechDetector().then(
    (d) => {
      detector = d
      if (!disposed) onStatus('connected')
    },
    (err) => onStatus(`unavailable: ${err instanceof Error ? err.message : String(err)}`),
  )

  // ---------------- with speech-to-text: the backend ----------------
  let ws: WebSocket | null = null
  let streaming = false   // this press's audio goes to the backend (it was reachable when the press started)
  let available = false   // the backend has speech-to-text (its "transcription" message)
  let settings: TranscriptionSettings | null = null  // sent on every (re)connect

  function send(data: string | ArrayBuffer): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(data)
    return true
  }

  /** Whether pauses end an utterance: not in Live and Per press (where an utterance is a whole
   *  press), as long as the backend transcribes. */
  function splitsAtPauses(): boolean {
    return !(transcription && available && (settings?.mode === 'stream' || settings?.mode === 'press'))
  }

  // While the backend is unreachable, poll it with plain HTTP and only then open the WebSocket:
  // Firefox slows down repeated failed WebSocket attempts (up to ~1 min). Only {"ok": true}
  // counts: a site serving the page may answer unknown paths with a page (status 200).
  async function waitForServer(): Promise<void> {
    let reported = false
    while (!disposed) {
      try {
        const response = await fetch(httpUrl('/healthz'), { cache: 'no-store' })
        if (response.ok && ((await response.json()) as { ok?: unknown }).ok === true) break
      } catch { /* not up yet (or not JSON) */ }
      if (disposed) return
      if (!reported) onTextError(UNREACHABLE)
      reported = true
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!disposed) connect()
  }

  function connect(): void {
    const socket = new WebSocket(wsUrl('/ws'))
    ws = socket
    socket.binaryType = 'arraybuffer'
    let opened = false
    socket.onopen = () => {
      opened = true
      onTextError('')
      if (settings) send(JSON.stringify({ type: 'settings', ...settings }))
      // Already listening (e.g. "Dot always on" started before the backend was up, or after a
      // reconnect): stream from the next chunk on.
      if (talking) streaming = send(JSON.stringify({ type: 'mic', on: true, chunk: chunkNumber + 1 }))
    }
    socket.onmessage = (msg: MessageEvent<string>) => {
      // JSON.parse returns `any`: this is where we promise TypeScript what the server sends.
      const data = JSON.parse(msg.data) as ServerMessage
      if (data.type === 'text') onText(data)
      else if (data.type === 'transcription') {
        available = data.available
        onTranscription(data.available)
      }
      else if (data.type === 'text_error') onTextError(data.message)
    }
    socket.onclose = () => {
      ws = null
      streaming = false
      if (disposed) return
      onTextError(UNREACHABLE)
      // Refused although /healthz answers (e.g. an origin not in ALLOWED_ORIGINS): don't retry at once.
      if (opened) void waitForServer()
      else setTimeout(() => { if (!disposed) void waitForServer() }, 1000)
    }
  }

  if (transcription) void waitForServer()

  // ---------------- the dot ----------------
  async function press(): Promise<boolean> {
    if (held || disposed) return held
    if (!detector) return false      // still loading
    held = true
    try {
      await (mic ??= openMicrophone(onChunk))  // first press: asks for permission; afterwards instant
    } catch (err) {
      mic = null                     // refused: ask again on the next press
      held = false
      onStatus(`microphone blocked: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!held) return false          // released while the mic was starting
    later(() => {
      detector?.reset()              // a new press: Silero forgets the last one
      recorder.splitAtPauses = splitsAtPauses()
    })
    streaming = transcription && send(JSON.stringify({ type: 'mic', on: true, chunk: chunkNumber + 1 }))
    talking = true
    return true
  }

  function release(): void {
    if (!held) return
    held = false
    if (!talking) return
    talking = false
    // After the chunks still waiting to be judged: the last utterance, then (with speech-to-text)
    // the end of the press, in that order, so its text isn't lost.
    later(() => {
      done(recorder.finish())
      if (streaming) send(JSON.stringify({ type: 'mic', on: false }))
      streaming = false
    })
  }

  function cut(): void {
    if (!talking) return
    later(() => {
      done(recorder.finish())
      if (streaming) send(JSON.stringify({ type: 'cut' }))
    })
  }

  function configure(next: TranscriptionSettings): void {
    settings = next
    // While listening, the current utterance is finished with the old settings first.
    later(() => {
      if (talking) done(recorder.finish())
      recorder.splitAtPauses = splitsAtPauses()
      send(JSON.stringify({ type: 'settings', ...next }))  // if not connected now: on connect
    })
  }

  function dispose(): void {
    release()
    disposed = true
    ws?.close()
    void mic?.then((m) => m.close(), () => {})
  }

  return { press, release, cut, configure, dispose }
}
