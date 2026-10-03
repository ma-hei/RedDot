// The connection to the lab server: WebSocket, microphone, push-to-talk. No React.
//
//   const link = createLink({ onStatus, onVerdict, onRecording })
//   await link.press()   // start listening (opens the mic on first use); false if it couldn't
//   link.release()       // stop listening; the server ends the utterance
//   link.dispose()       // close everything (a React component unmounting)
//
// ---------------- the protocol (see server.py) ----------------
// Page -> server: {"type": "mic", "on": bool} and 100 ms PCM chunks (binary) while pressed.
// Server -> page: one verdict per chunk, and an "ended" message per finished utterance.
//
// Recordings: the page numbers the chunks it sends (from 1 per connection) and keeps the last
// KEEP_SECONDS of them. When the server says "utterance ended: chunks 12..38", the page
// assembles those chunks itself, so the audio never has to travel back from the server.

export interface Verdict {
  type: 'verdict'
  speech: boolean                    // this 100 ms chunk counted as speech
  rms: number                        // loudness of the chunk (16-bit scale)
}

export interface UtteranceEvent {
  type: 'utterance'
  event: 'ended'
  first: number                      // the utterance is the chunks numbered first..last
  last: number
  seconds: number
}

/** One finished utterance, ready to play: 16-bit mono PCM. */
export interface Recording {
  pcm: Int16Array
  sampleRate: number
  seconds: number
}

// A "discriminated union": the `type` field tells TypeScript which of the two it is.
type ServerMessage = Verdict | UtteranceEvent | { type: 'config' | 'partial' | 'transcript' }

export type LinkStatus = 'connecting' | 'connected' | 'disconnected' | `microphone blocked: ${string}`

export interface LinkCallbacks {
  onStatus?: (status: LinkStatus) => void
  onVerdict?: (verdict: Verdict) => void
  onRecording?: (recording: Recording) => void
}

export interface Link {
  press(): Promise<boolean>
  release(): void
  dispose(): void
}

// VITE_BACKEND_URL is read at build time (from .env.production).
// Empty, as in development: the page's own address, which Vite's proxy forwards to the backend.
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/+$/, '')

/** "/healthz" -> "https://reddot.culturalcapital.biz/healthz" (or just "/healthz" in development) */
function httpUrl(path: string): string {
  return BACKEND_URL + path
}

/** "/ws" -> "wss://reddot.culturalcapital.biz/ws" (https -> wss, http -> ws) */
function wsUrl(path: string): string {
  return (BACKEND_URL || location.origin).replace(/^http/, 'ws') + path
}

const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 1600            // 100 ms, as pcm-recorder.js makes them
const KEEP_SECONDS = 60               // utterances are at most 15 s; keep a generous margin
const KEEP_CHUNKS = KEEP_SECONDS * SAMPLE_RATE / CHUNK_SAMPLES

export function createLink({ onStatus = () => {}, onVerdict = () => {}, onRecording = () => {} }: LinkCallbacks = {}): Link {
  let ws: WebSocket | null = null
  let micCtx: AudioContext | null = null
  let micStream: MediaStream | null = null
  let held = false      // press() called, release() not yet
  let talking = false   // held, mic ready and the server told: audio is being sent
  let disposed = false
  // The chunks sent on this connection, numbered like the server counts them (see server.py).
  let sentChunks = 0
  const kept = new Map<number, ArrayBuffer>()

  // "Chunks first..last are an utterance": put them together. Returns null if some are missing
  // (older than KEEP_SECONDS, or from before a reconnect).
  function assemble(first: number, last: number): Int16Array | null {
    const pcm = new Int16Array((last - first + 1) * CHUNK_SAMPLES)
    for (let n = first; n <= last; n++) {
      const chunk = kept.get(n)
      if (!chunk) return null
      pcm.set(new Int16Array(chunk), (n - first) * CHUNK_SAMPLES)
    }
    return pcm
  }

  function send(data: string | ArrayBuffer): boolean {
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(data)
    return true
  }

  // While the server is unreachable, poll it with plain HTTP and only then open the
  // WebSocket: Firefox slows down repeated failed WebSocket attempts (up to ~1 min).
  async function waitForServer(): Promise<void> {
    onStatus('connecting')
    while (!disposed) {
      try {
	if ((await fetch(httpUrl('/healthz'), { cache: 'no-store' })).ok) break
      } catch { /* not up yet */ }
      if (disposed) return
      onStatus('disconnected')
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (!disposed) connect()
  }

  function connect(): void {
    const socket = new WebSocket(wsUrl('/ws'))
    ws = socket
    socket.binaryType = 'arraybuffer'
    sentChunks = 0                   // the server counts from 1 again on every new connection
    kept.clear()
    socket.onopen = () => onStatus('connected')
    socket.onmessage = (msg: MessageEvent<string>) => {
      // JSON.parse returns `any`: this is where we promise TypeScript what the server sends.
      const data = JSON.parse(msg.data) as ServerMessage
      if (data.type === 'verdict') onVerdict(data)          // here TypeScript knows: data is a Verdict
      else if (data.type === 'utterance' && data.event === 'ended') {  // ...and here an UtteranceEvent
        const pcm = assemble(data.first, data.last)
        if (pcm) onRecording({ pcm, sampleRate: SAMPLE_RATE, seconds: data.seconds })
      }
    }
    socket.onclose = () => {
      ws = null
      talking = false
      if (!disposed) waitForServer()
    }
  }

  async function startMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    const ctx = new AudioContext({ sampleRate: 16000 })  // the browser resamples the mic to 16 kHz
    micStream = stream
    micCtx = ctx
    await ctx.audioWorklet.addModule(`/pcm-recorder.js?v=${Date.now()}`)
    const node = new AudioWorkletNode(ctx, 'pcm-recorder')
    // 100 ms chunks of 16-bit PCM, only sent while pressed; numbered and kept for recordings
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!talking || !send(e.data)) return
      sentChunks += 1
      kept.set(sentChunks, e.data)
      kept.delete(sentChunks - KEEP_CHUNKS)  // forget what's older than KEEP_SECONDS
    }
    ctx.createMediaStreamSource(stream).connect(node)
  }

  async function press(): Promise<boolean> {
    if (held || disposed) return held
    if (ws?.readyState !== WebSocket.OPEN) return false
    held = true
    try {
      if (!micCtx) await startMic()  // first press: asks for permission; afterwards instant
    } catch (err) {
      held = false
      onStatus(`microphone blocked: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!held) return false          // released while the mic was starting
    talking = send(JSON.stringify({ type: 'mic', on: true }))
    return talking
  }

  function release(): void {
    if (!held) return
    held = false
    if (talking) {
      talking = false
      send(JSON.stringify({ type: 'mic', on: false }))
    }
  }

  function dispose(): void {
    release()
    disposed = true
    ws?.close()
    micStream?.getTracks().forEach((t) => t.stop())
    micCtx?.close()
  }

  waitForServer()
  return { press, release, dispose }
}
