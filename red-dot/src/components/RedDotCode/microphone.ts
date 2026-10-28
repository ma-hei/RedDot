// The microphone as 100 ms chunks of 16 kHz 16-bit mono PCM. No React. Used by link.ts.
//
//   const mic = await openMicrophone((chunk) => ...)   // asks for permission; throws if refused
//   mic.close()
//
// Open it once per page and keep the promise: a second call while the first waits for the
// permission would open a second microphone, and every chunk would arrive twice.

export const SAMPLE_RATE = 16000
export const CHUNK_SAMPLES = 1600     // 100 ms, as pcm-recorder.js makes them

export interface Microphone {
  close(): void
}

export async function openMicrophone(onChunk: (chunk: ArrayBuffer) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })  // the browser resamples the mic to 16 kHz
  // Started without a click or key (live speech-to-text listens from the start), browsers keep
  // audio paused until the page is first used: resume it then.
  if (ctx.state === 'suspended') {
    const resume = () => {
      void ctx.resume()
      document.removeEventListener('pointerdown', resume)
      document.removeEventListener('keydown', resume)
    }
    document.addEventListener('pointerdown', resume)
    document.addEventListener('keydown', resume)
  }
  await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}pcm-recorder.js?v=${Date.now()}`)
  const node = new AudioWorkletNode(ctx, 'pcm-recorder')
  node.port.onmessage = (e: MessageEvent<ArrayBuffer | { sampleRate: number }>) => {
    if (e.data instanceof ArrayBuffer) onChunk(e.data)
    else console.info(`microphone: the audio runs at ${e.data.sampleRate} Hz, recorded at ${SAMPLE_RATE} Hz`)
  }
  ctx.createMediaStreamSource(stream).connect(node)
  return {
    close() {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}
