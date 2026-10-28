// AudioWorklet that turns microphone audio into 16-bit PCM chunks of 100 ms at 16 kHz.
// The AudioContext is created with sampleRate: 16000, but not every browser honours that (the
// recordings then played back much too slowly). So this converts from whatever rate it really
// runs at (`sampleRate`, a global in worklets), by linear interpolation; at 16 kHz it only copies.
const TARGET_RATE = 16000;

class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSamples = 1600; // 100 ms at 16 kHz = 3200 bytes, the size ADK recommends
    this.buffer = new Int16Array(this.chunkSamples);
    this.offset = 0;
    this.step = sampleRate / TARGET_RATE; // input samples per output sample (1 at 16 kHz, 3 at 48 kHz)
    this.position = 0;                    // the next output sample, in input samples from this block's start
    this.previous = 0;                    // the previous block's last sample (position -1)
    this.port.postMessage({ sampleRate }); // once, so the page can log it (microphone.ts)
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    // Between two input samples: needs the one after it, so the last one waits for the next block.
    while (this.position < channel.length - 1) {
      const i = Math.floor(this.position);
      const a = i < 0 ? this.previous : channel[i];
      this.push(a + (channel[i + 1] - a) * (this.position - i));
      this.position += this.step;
    }
    this.position -= channel.length;
    this.previous = channel[channel.length - 1];
    return true;
  }

  push(value) {
    const s = Math.max(-1, Math.min(1, value));
    this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.offset === this.chunkSamples) {
      this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
      this.buffer = new Int16Array(this.chunkSamples);
      this.offset = 0;
    }
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
