// Cuts the stream of 100 ms chunks into utterances (one sentence each), in the browser. It
// doesn't judge the audio itself: it gets speechDetector.ts's verdict with every chunk, and the
// chunk's number (link.ts numbers them), so each event says which chunks the utterance covers.
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
//
// With splitAtPauses off (speech-to-text Live and Per press), pauses and MAX_SECONDS don't end an
// utterance: everything said during one press is one utterance, which ends when the dot is let go
// (or after PRESS_MAX_SECONDS: a stream to Google may last at most 5 minutes).

import { CHUNK_SAMPLES, SAMPLE_RATE } from './microphone.ts'

export const START_CHUNKS = 2         // 200 ms of speech starts an utterance
export const END_CHUNKS = 7           // 700 ms of quiet ends it
export const PRE_ROLL_CHUNKS = 3      // keep 300 ms from before the start, so the first syllable isn't cut
export const MIN_SPEECH_CHUNKS = 3    // shorter than 300 ms of speech: a click or a cough
export const MAX_SECONDS = 15
export const PRESS_MAX_SECONDS = 280  // one utterance per press: ended before a stream's 5-minute limit

/** first, last: the numbers of the utterance's first and last chunk (the pre-roll included). */
export type UtteranceEvent =
  | { event: 'started'; first: number; seconds: number }   // seconds: its length so far
  | { event: 'ended'; first: number; last: number; pcm: Int16Array; seconds: number }
  | { event: 'discarded'; first: number; last: number; seconds: number }   // too little speech

export interface UtteranceRecorder {
  /** Whether pauses end an utterance (default); off: one utterance per press. Set it before a press. */
  splitAtPauses: boolean
  readonly recording: boolean
  /** Add one chunk, its number and its verdict; returns an event when an utterance starts or stops. */
  feed(chunk: ArrayBuffer, n: number, isSpeech: boolean): UtteranceEvent | null
  /** The dot (or R) was let go: end the utterance being recorded, if any. Also forgets the pre-roll. */
  finish(): UtteranceEvent | null
}

export function createUtteranceRecorder(): UtteranceRecorder {
  let recording = false
  let pre: ArrayBuffer[] = []         // the last PRE_ROLL_CHUNKS chunks while waiting
  let preFirst = 0                    // the number of pre's first chunk
  let chunks: ArrayBuffer[] = []
  let first = 0                       // RECORDING: the number of chunks[0]
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
      event = { event: 'ended', first, last: first + chunks.length - 1, pcm, seconds: length }
    } else {
      event = { event: 'discarded', first, last: first + chunks.length - 1, seconds: length }
    }
    recording = false
    pre = []
    chunks = []
    speechRun = quietRun = speechTotal = 0
    return event
  }

  function feed(chunk: ArrayBuffer, n: number, isSpeech: boolean): UtteranceEvent | null {
    if (!recording) {
      if (pre.length === 0) preFirst = n
      pre.push(chunk)
      if (pre.length > PRE_ROLL_CHUNKS) {
        pre.shift()
        preFirst += 1
      }
      speechRun = isSpeech ? speechRun + 1 : 0
      if (speechRun >= START_CHUNKS) {
        recording = true
        chunks = pre
        first = preFirst
        pre = []
        speechTotal = speechRun
        quietRun = 0
        return { event: 'started', first, seconds: seconds() }
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
    if (!recorder.splitAtPauses) return seconds() >= PRESS_MAX_SECONDS ? end() : null
    return quietRun >= END_CHUNKS || seconds() >= MAX_SECONDS ? end() : null
  }

  function finish(): UtteranceEvent | null {
    if (recording) return end()
    pre = []
    speechRun = 0
    return null
  }

  const recorder: UtteranceRecorder = { splitAtPauses: true, get recording() { return recording }, feed, finish }
  return recorder
}
