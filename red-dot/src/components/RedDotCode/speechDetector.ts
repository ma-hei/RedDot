// Is this 100 ms chunk of microphone audio speech? Decided in the browser by Silero VAD, a small
// neural network (2 MB) run with ONNX Runtime (WebAssembly). The audio never leaves the device
// for this. (The server's detector, speech_check.py, is only used with speech-to-text: link.ts.)
//
//   const detector = await createSpeechDetector()   // loads the model (once)
//   const { speech, rms } = await detector.check(chunk)
//   detector.reset()                                // before a new press: forget the last one
//
// Silero judges 32 ms frames (512 samples), so a 100 ms chunk holds 3 or 4 of them (the rest
// waits for the next chunk). A chunk is speech if its frames' average speech probability is at
// least SPEECH_THRESHOLD.

import * as ort from 'onnxruntime-web/wasm'
// The model file comes with @ricky0123/vad-web (the package's own code isn't used). Vite copies
// it into the build and gives us its address.
import modelUrl from '@ricky0123/vad-web/dist/silero_vad_v5.onnx?url'
import { SAMPLE_RATE } from './microphone.ts'

export const SPEECH_THRESHOLD = 0.5   // Silero's recommended default
const FRAME_SAMPLES = 512             // what Silero v5 judges at 16 kHz
const CONTEXT_SAMPLES = 64            // the end of the previous frame, given with each frame (as in silero-vad)

export interface ChunkVerdict {
  speech: boolean
  probability: number                 // 0..1, the average of the chunk's frames
  rms: number                         // loudness, 16-bit scale (for the dot's look)
}

export interface SpeechDetector {
  check(chunk: ArrayBuffer): Promise<ChunkVerdict>
  reset(): void
}

// One thread: more would need a cross-origin isolated page, and one frame takes about a millisecond.
ort.env.wasm.numThreads = 1

export async function createSpeechDetector(): Promise<SpeechDetector> {
  const session = await ort.InferenceSession.create(modelUrl)
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]))
  let state = newState()
  let context = new Float32Array(CONTEXT_SAMPLES)
  let rest = new Float32Array(0)      // samples waiting for a whole frame

  async function frame(samples: Float32Array): Promise<number> {
    const input = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES)
    input.set(context, 0)
    input.set(samples, CONTEXT_SAMPLES)
    context = samples.slice(-CONTEXT_SAMPLES)
    const out = await session.run({ input: new ort.Tensor('float32', input, [1, input.length]), state, sr })
    state = out.stateN
    return (out.output.data as Float32Array)[0]
  }

  async function check(chunk: ArrayBuffer): Promise<ChunkVerdict> {
    const pcm = new Int16Array(chunk)
    const samples = new Float32Array(rest.length + pcm.length)
    samples.set(rest, 0)
    let sumSquares = 0
    for (let i = 0; i < pcm.length; i++) {
      samples[rest.length + i] = pcm[i] / 32768
      sumSquares += pcm[i] * pcm[i]
    }
    let total = 0
    let frames = 0
    let at = 0
    for (; at + FRAME_SAMPLES <= samples.length; at += FRAME_SAMPLES) {
      total += await frame(samples.subarray(at, at + FRAME_SAMPLES))
      frames += 1
    }
    rest = samples.slice(at)
    const probability = frames ? total / frames : 0
    return { speech: probability >= SPEECH_THRESHOLD, probability, rms: Math.sqrt(sumSquares / Math.max(1, pcm.length)) }
  }

  function reset(): void {
    state = newState()
    context = new Float32Array(CONTEXT_SAMPLES)
    rest = new Float32Array(0)
  }

  return { check, reset }
}

/** Silero's memory between frames: zeros at the start. */
function newState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])
}
