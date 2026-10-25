import type { Pcm } from "./tts.js";

export interface WordTiming {
  word: string;
  /** Seconds from the start of the sentence's audio. */
  start: number;
  end: number;
}

// Freya TTS returns no word times, so they are estimated: each word weighs its spoken syllables
// plus a pause after it, and clause starts snap onto the real pauses found in the audio.

const ONES = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

function three(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return ((h > 1 ? ONES[h] + " " : "") + (h ? "yüz " : "") + TENS[Math.floor(r / 10)] + " " + ONES[r % 10]).trim();
}

export function numberWords(n: number): string {
  if (!n) return "sıfır";
  const out: string[] = [];
  const names = ["", "bin", "milyon", "milyar"];
  for (let i = 0; n > 0 && i < names.length; i++) {
    const g = n % 1000;
    if (g) out.unshift((i === 1 && g === 1 ? "" : three(g)) + (names[i] ? " " + names[i] : ""));
    n = Math.floor(n / 1000);
  }
  return out.join(" ").trim();
}

function spokenForm(word: string): string {
  const w = word.replace(/^[("'“]+|[)"'”.,;:!?…]+$/g, "");
  if (/^TL['’]/.test(w)) return "lira" + w.slice(3);
  if (w === "TL") return "Türk lirası";
  // a date: "25.10.2026" is three numbers, not twenty-five million
  if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(w)) return w.split(".").map((n) => numberWords(parseInt(n, 10))).join(" ");
  const m = w.match(/^%?(\d[\d.]*)(?:,(\d+))?(['’]\S*)?$/);
  if (m) {
    return (
      (w[0] === "%" ? "yüzde " : "") +
      numberWords(parseInt(m[1].replace(/\./g, ""), 10)) +
      (m[2] ? " virgül " + numberWords(parseInt(m[2], 10)) : "") +
      (m[3] ?? "").slice(1)
    );
  }
  return w;
}

function syllables(word: string): number {
  // nothing spoken is this long; its patterns would only cost time
  if (word.length > 64) return Math.max(1, Math.round(word.length / 3));
  return Math.max((spokenForm(word).toLowerCase().match(/[aeiıoöuüâîû]+/g) ?? []).length, 1);
}

function gapAfter(word: string): number {
  if (/(\.\.\.|…)$/.test(word)) return 1.75;
  if (/[.!?]$/.test(word)) return 1.45;
  if (/[,;:]$/.test(word)) return 0.85;
  return 0.25;
}

/** Speech spans in seconds: 10 ms frames, a pause is 100 ms or more under 6 % of the peak. */
export function speechSpans(pcm: Pcm): [number, number][] {
  const f = Math.max(1, Math.round(pcm.sampleRate / 100));
  const rms: number[] = [];
  let peak = 0;
  for (let i = 0; i + f <= pcm.samples.length; i += f) {
    let s = 0;
    for (let j = i; j < i + f; j++) s += (pcm.samples[j] / 32768) ** 2;
    const r = Math.sqrt(s / f);
    rms.push(r);
    if (r > peak) peak = r;
  }
  const th = peak * 0.06;
  const spans: [number, number][] = [];
  let start = -1;
  let quiet = 0;
  for (let k = 0; k < rms.length; k++) {
    if (rms[k] > th) {
      if (start < 0) start = k;
      quiet = 0;
    } else if (start >= 0 && ++quiet >= 10) {
      spans.push([start / 100, (k - quiet + 1) / 100]);
      start = -1;
      quiet = 0;
    }
  }
  if (start >= 0) spans.push([start / 100, rms.length / 100]);
  // a breath or click at either end is not speech
  while (spans.length > 1 && spans[spans.length - 1][1] - spans[spans.length - 1][0] < 0.1) spans.pop();
  while (spans.length > 1 && spans[0][1] - spans[0][0] < 0.1) spans.shift();
  return spans;
}

/** When each word starts and ends in the sentence's audio (estimated, see above). */
export function wordTimings(text: string, pcm: Pcm | null, seconds?: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const wt = words.map(syllables);
  const gap = words.map(gapAfter);
  const spans = pcm ? speechSpans(pcm) : [];
  const duration = pcm ? pcm.samples.length / pcm.sampleRate : (seconds ?? 0);
  const from = spans.length ? spans[0][0] : 0;
  let to = spans.length ? spans[spans.length - 1][1] : duration;
  // about five syllables a second when there is no audio to measure
  if (!to) to = words.reduce((a, _w, i) => a + wt[i] + gap[i], 0) / 5.2;

  const place = (a: number, b: number): number[] => {
    let w0 = 0;
    let tot = 0;
    const out: number[] = [];
    for (let i = a; i < b; i++) tot += wt[i] + (i < b - 1 ? gap[i] : 0);
    for (let i = a; i < b; i++) {
      out.push(w0);
      w0 += wt[i] + gap[i];
    }
    return out.map((x) => x / (tot || 1));
  };

  const ends = spans.slice(1).map((s) => s[0]);
  const guess = place(0, words.length).map((x) => from + x * (to - from));
  const anchors: [number, number, number][] = [[0, from, from]];
  let used = -1;
  for (let i = 0; i < words.length - 1; i++) {
    if (gap[i] < 0.8) continue;
    const t = guess[i + 1];
    let best = -1;
    let bestD = gap[i] >= 1.4 ? 0.8 : 0.45;
    for (let e = used + 1; e < ends.length; e++) {
      const d = Math.abs(ends[e] - t);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best >= 0) {
      anchors.push([i + 1, ends[best], spans[best][1]]);
      used = best;
    }
  }
  anchors.push([words.length, to, to]);

  const starts: number[] = [];
  for (let a = 0; a < anchors.length - 1; a++) {
    const [i0, t0] = anchors[a];
    const [i1, , t1] = anchors[a + 1];
    for (const x of place(i0, i1)) starts.push(t0 + x * (t1 - t0));
  }
  return words.map((word, i) => ({ word, start: starts[i], end: i + 1 < words.length ? starts[i + 1] : to }));
}
