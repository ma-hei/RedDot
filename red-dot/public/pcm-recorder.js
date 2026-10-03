// AudioWorklet that turns microphone audio into 16-bit PCM chunks.
// It runs inside an AudioContext created with sampleRate: 16000, so the
// browser has already resampled the mic to 16 kHz for us.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSamples = 1600; // 100 ms at 16 kHz = 3200 bytes, the size ADK recommends
    this.buffer = new Int16Array(this.chunkSamples);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.chunkSamples) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.chunkSamples);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
