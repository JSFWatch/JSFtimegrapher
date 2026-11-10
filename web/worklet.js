// Audio capture worklet: batches raw samples (no browser processing) and posts
// them to the page, two channels, about every 43 ms at 48 kHz, each block stamped
// with its frame number and the wall clock for device-clock calibration.
class OtgCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
    this.n = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const a = input[0], b = input[1] || null;
    for (let i = 0; i < a.length; i++) {
      this.buf[0][this.n] = a[i];
      this.buf[1][this.n] = b ? b[i] : 0;
      if (++this.n === this.size) {
        // Stamp the block in the audio thread: frame count at its last sample + wall clock.
        this.port.postMessage([this.buf[0], this.buf[1], currentFrame + i + 1, Date.now()],
                              [this.buf[0].buffer, this.buf[1].buffer]);
        this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("otg-capture", OtgCapture);
