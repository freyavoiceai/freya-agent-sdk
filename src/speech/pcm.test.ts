import { describe, expect, it } from "vitest";
import { Resampler, floatToInt16, toMonoFloat } from "./pcm.js";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function resample(x: Float32Array, from: number, chunk = 4800): Float32Array {
  const r = new Resampler(from);
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += chunk) parts.push(r.process(x.subarray(i, i + chunk)));
  parts.push(r.flush());
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function maxError(y: Float32Array, freq: number, amp: number, skip = 400): number {
  let worst = 0;
  for (let i = skip; i < y.length - skip; i++) {
    worst = Math.max(worst, Math.abs(y[i] - amp * Math.sin((2 * Math.PI * freq * i) / 16000)));
  }
  return worst;
}

describe("Resampler", () => {
  it.each([48000, 44100, 8000, 22050])("keeps a 1 kHz sine at 16 kHz from %i Hz", (rate) => {
    const y = resample(sine(1000, rate, 1), rate);
    expect(Math.abs(y.length - 16000)).toBeLessThanOrEqual(1);
    expect(maxError(y, 1000, 0.5)).toBeLessThan(0.01);
  });

  it("gives the same output for any chunking", () => {
    const x = sine(440, 44100, 0.5);
    const a = resample(x, 44100, 4410);
    const b = resample(x, 44100, 333);
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 5);
  });

  it("removes content above the target Nyquist", () => {
    const y = resample(sine(20000, 48000, 1, 0.8), 48000);
    expect(Math.max(...y.slice(400, -400).map(Math.abs))).toBeLessThan(0.02);
  });

  it("passes 16 kHz through untouched", () => {
    const x = sine(300, 16000, 0.1);
    const r = new Resampler(16000);
    expect(r.process(x)).toBe(x);
    expect(r.flush().length).toBe(0);
  });
});

describe("toMonoFloat and floatToInt16", () => {
  it("averages stereo and scales Int16", () => {
    const m = toMonoFloat(Int16Array.from([16384, -16384, 16384, 16384]), 2);
    expect([...m]).toEqual([0, 0.5]);
  });

  it("takes Float32 as is and rejects a partial frame", () => {
    expect([...toMonoFloat(Float32Array.from([0.25, 0.75]), 1)]).toEqual([0.25, 0.75]);
    expect(() => toMonoFloat(new Int16Array(3), 2)).toThrow(RangeError);
  });

  it("clips and rounds", () => {
    expect([...floatToInt16(Float32Array.from([1.5, -1.5, 0.5, 0]))]).toEqual([32767, -32768, 16384, 0]);
  });
});
