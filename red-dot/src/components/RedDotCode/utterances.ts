// Cuts the stream of 100 ms chunks into utterances (one sentence each), in the browser.
// The same rules as the server's utterances.py (used with speech-to-text): it doesn't judge
// the audio itself, it gets speechDetector.ts's verdict with every chunk.
//
//             START_CHUNKS speech chunks in a row
//     WAITING ----------------------------------> RECORDING
//        ^                                            |
//        |   END_CHUNKS quiet chunks in a row,        |
//        +------------ or MAX_SECONDS reached <-------+
//                      -> "ended" (with the audio), or "discarded" if it had
//                         fewer than MIN_SPEECH_CHUNKS of speech
//
// Letting go of the dot (or R) also ends an utterance: see finish().

import { CHUNK_SAMPLES, SAMPLE_RATE } from './microphone.ts'

export const START_CHUNKS = 2         // 200 ms of speech starts an utterance
export const END_CHUNKS = 7           // 700 ms of quiet ends it
export const PRE_ROLL_CHUNKS = 3      // keep 300 ms from before the start, so the first syllable isn't cut
export const MIN_SPEECH_CHUNKS = 3    // shorter than 300 ms of speech: a click or a cough
export const MAX_SECONDS = 15

export type UtteranceEvent =
  | { event: 'started' }
  | { event: 'ended'; pcm: Int16Array; seconds: number }
  | { event: 'discarded'; seconds: number }

export interface UtteranceRecorder {
  readonly recording: boolean
  /** Add one chunk and its verdict; returns an event when an utterance starts or stops. */
  feed(chunk: ArrayBuffer, isSpeech: boolean): UtteranceEvent | null
  /** The dot (or R) was let go: end the utterance being recorded, if any. Also forgets the pre-roll. */
  finish(): UtteranceEvent | null
}

export function createUtteranceRecorder(): UtteranceRecorder {
  let recording = false
  let pre: ArrayBuffer[] = []         // the last PRE_ROLL_CHUNKS chunks while waiting
  let chunks: ArrayBuffer[] = []
  let speechRun = 0                   // WAITING: speech chunks in a row
  let quietRun = 0                    // RECORDING: quiet chunks in a row
  let speechTotal = 0                 // RECORDING: speech chunks in this utterance

  const seconds = () => chunks.length * CHUNK_SAMPLES / SAMPLE_RATE

  function end(): UtteranceEvent {
    const length = seconds()
    let event: UtteranceEvent
    if (speechTotal >= MIN_SPEECH_CHUNKS) {
      const pcm = new Int16Array(chunks.length * CHUNK_SAMPLES)
      chunks.forEach((c, i) => pcm.set(new Int16Array(c), i * CHUNK_SAMPLES))
      event = { event: 'ended', pcm, seconds: length }
    } else {
      event = { event: 'discarded', seconds: length }
    }
    recording = false
    pre = []
    chunks = []
    speechRun = quietRun = speechTotal = 0
    return event
  }

  function feed(chunk: ArrayBuffer, isSpeech: boolean): UtteranceEvent | null {
    if (!recording) {
      pre.push(chunk)
      if (pre.length > PRE_ROLL_CHUNKS) pre.shift()
      speechRun = isSpeech ? speechRun + 1 : 0
      if (speechRun >= START_CHUNKS) {
        recording = true
        chunks = pre
        pre = []
        speechTotal = speechRun
        quietRun = 0
        return { event: 'started' }
      }
      return null
    }
    chunks.push(chunk)
    if (isSpeech) {
      speechTotal += 1
      quietRun = 0
    } else {
      quietRun += 1
    }
    return quietRun >= END_CHUNKS || seconds() >= MAX_SECONDS ? end() : null
  }

  function finish(): UtteranceEvent | null {
    if (recording) return end()
    pre = []
    speechRun = 0
    return null
  }

  return { get recording() { return recording }, feed, finish }
}
