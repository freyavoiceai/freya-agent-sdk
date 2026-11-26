/** Sample rate every dictation request carries. */
export const DICTATION_RATE = 16000;

const ZEROS = 8;

function sinc(x: number): number {
  if (x === 0) return 1;
  const a = Math.PI * x;
  return Math.sin(a) / a;
}

/** Mixes interleaved frames down to mono floats in -1..1; Int16 and Float32 input are both accepted. */
export function toMonoFloat(samples: Int16Array | Float32Array, channels: number): Float32Array {
  if (!Number.isInteger(channels) || channels < 1) throw new RangeError("channels must be a positive integer");
  if (samples.length % channels !== 0) throw new RangeError("samples must hold whole frames for the channel count");
  const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
  const frames = samples.length / channels;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = (sum / channels) * scale;
  }
  return out;
}

export function floatToInt16(x: Float32Array | Float64Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = Math.round(x[i] * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * Streaming resampler for mono floats (windowed sinc, low-passed below the target Nyquist when
 * downsampling). `process` takes chunks as they arrive; `flush` returns the tail at the end.
 */
export class Resampler {
  private input = new Float32Array(0);
  private base = 0;
  private produced = 0;
  private total = 0;
  private readonly ratio: number;
  private readonly width: number;

  constructor(readonly inRate: number, readonly outRate: number = DICTATION_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new RangeError("sample rates must be positive");
    this.ratio = inRate / outRate;
    this.width = ZEROS * Math.max(1, this.ratio);
  }

  process(chunk: Float32Array): Float32Array {
    if (this.ratio === 1) return chunk;
    const merged = new Float32Array(this.input.length + chunk.length);
    merged.set(this.input);
    merged.set(chunk, this.input.length);
    this.input = merged;
    this.total += chunk.length;
    return this.run(false);
  }

  flush(): Float32Array {
    if (this.ratio === 1) return new Float32Array(0);
    return this.run(true);
  }

  private run(final: boolean): Float32Array {
    const out: number[] = [];
    const limit = final ? Math.floor((this.total * this.outRate) / this.inRate) : Infinity;
    const scale = Math.max(1, this.ratio);
    for (;;) {
      if (this.produced >= limit) break;
      const t = this.produced * this.ratio;
      if (!final && Math.ceil(t + this.width) >= this.total) break;
      const from = Math.ceil(t - this.width);
      const to = Math.floor(t + this.width);
      let acc = 0;
      let norm = 0;
      for (let k = from; k <= to; k++) {
        const u = (k - t) / scale;
        const w = sinc(u) * (0.5 + 0.5 * Math.cos((Math.PI * u) / ZEROS));
        norm += w;
        const idx = k - this.base;
        if (idx >= 0 && idx < this.input.length) acc += this.input[idx] * w;
      }
      out.push(acc / norm);
      this.produced++;
    }
    const keepFrom = Math.max(this.base, Math.ceil(this.produced * this.ratio - this.width));
    if (keepFrom > this.base) {
      this.input = this.input.slice(keepFrom - this.base);
      this.base = keepFrom;
    }
    return Float32Array.from(out);
  }
}
