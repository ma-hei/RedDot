// Voice input without a server: microphone, speech detection and utterances all in the browser.
// The same interface as link.ts (which uses the server, for speech-to-text), so RedDot.tsx
// doesn't care which one it has (useVoiceLink.ts picks).
//
//   const link = createLocalLink({ onStatus, onVerdict, onUtterance })
//   await link.press()   // start listening (opens the mic on first use); false if it couldn't
//   link.release()       // stop listening; ends the utterance being recorded
//   link.cut()           // while listening: end the current utterance here
//   link.dispose()
//
// Status: 'connecting' while the speech detector loads, then 'connected' (ready).
// Chunks are judged one after another (a queue), so verdicts and utterances keep their order
// even though each judgement is asynchronous.

import type { Link, LinkCallbacks } from './link.ts'
import { openMicrophone, SAMPLE_RATE } from './microphone.ts'
import type { Microphone } from './microphone.ts'
import { createSpeechDetector } from './speechDetector.ts'
import type { SpeechDetector } from './speechDetector.ts'
import { PRE_ROLL_CHUNKS, START_CHUNKS, createUtteranceRecorder } from './utterances.ts'
import type { UtteranceEvent } from './utterances.ts'

export function createLocalLink({ onStatus = () => {}, onVerdict = () => {}, onUtterance = () => {} }: LinkCallbacks = {}): Link {
  let detector: SpeechDetector | null = null
  let mic: Promise<Microphone> | null = null  // opened on the first press, kept (see microphone.ts)
  let held = false        // press() called, release() not yet
  let talking = false     // held and the mic is ready: chunks are judged
  let disposed = false
  let nextKey = 1         // each utterance's key (RedDot.tsx uses it to match events and text to bubbles)
  let current: number | null = null   // the key of the utterance being recorded
  const recorder = createUtteranceRecorder()
  let queue: Promise<void> = Promise.resolve()

  const later = (job: () => Promise<void> | void) => {
    queue = queue.then(job).catch((err) => console.error('speech detection:', err))
  }

  // Like the server's messages (link.ts): started (the bubble pops up), then ended or discarded.
  function done(ev: UtteranceEvent | null): void {
    if (!ev) return
    if (ev.event === 'started') {
      current = nextKey++
      onUtterance({ event: 'started', key: current, seconds: (PRE_ROLL_CHUNKS + START_CHUNKS) * 0.1 })
      return
    }
    const key = current ?? nextKey++
    current = null
    if (ev.event === 'ended') {
      onUtterance({ event: 'ended', key, seconds: ev.seconds, recording: { pcm: ev.pcm, sampleRate: SAMPLE_RATE, seconds: ev.seconds } })
    } else onUtterance({ event: 'discarded', key })
  }

  async function judge(chunk: ArrayBuffer): Promise<void> {
    if (!detector || disposed) return
    const verdict = await detector.check(chunk)
    onVerdict({ type: 'verdict', speech: verdict.speech, rms: Math.round(verdict.rms) })
    done(recorder.feed(chunk, verdict.speech))
  }

  onStatus('connecting')
  createSpeechDetector().then(
    (d) => {
      detector = d
      if (!disposed) onStatus('connected')
    },
    (err) => onStatus(`unavailable: ${err instanceof Error ? err.message : String(err)}`),
  )

  async function press(): Promise<boolean> {
    if (held || disposed) return held
    if (!detector) return false      // still loading
    held = true
    try {
      await (mic ??= openMicrophone((chunk) => { if (talking) later(() => judge(chunk)) }))
    } catch (err) {
      mic = null                     // refused: ask again on the next press
      held = false
      onStatus(`microphone blocked: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (!held) return false          // released while the mic was starting
    later(() => detector?.reset())   // a new press: Silero forgets the last one
    talking = true
    return true
  }

  function release(): void {
    if (!held) return
    held = false
    if (!talking) return
    talking = false
    later(() => done(recorder.finish()))  // after the chunks still waiting to be judged
  }

  function cut(): void {
    if (talking) later(() => done(recorder.finish()))
  }

  function dispose(): void {
    release()
    disposed = true
    void mic?.then((m) => m.close(), () => {})
  }

  return { press, release, cut, configure: () => {}, dispose }
}
