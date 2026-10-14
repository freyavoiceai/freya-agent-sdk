import { describe, expect, it, vi } from "vitest";

import type { AudioOutput } from "./audio.js";
import { FreyaSpeech, type Chunk, type ReaderOptions, type ReaderSummary } from "./index.js";
import { TokenKeeper } from "./auth.js";
import { wavFromPcm } from "./stt.js";
import { SentenceAssembler } from "./text.js";
import type { Pcm } from "./tts.js";
import { VoiceActivity } from "./vad.js";
import { wordTimings } from "./words.js";

const RATE = 16000;

/** 0.3 s of tone per request, so word timing has speech to find. */
function tone(seconds = 0.3): ArrayBuffer {
  const s = new Int16Array(Math.round(RATE * seconds));
  for (let i = 0; i < s.length; i++) s[i] = Math.round(Math.sin(i / 8) * 8000);
  return s.buffer;
}

interface Call {
  url: string;
  token: string;
  body: unknown;
}

/** A TTS/STT stand-in: each token is good for `uses` requests, then 401. */
function fakeService(opts: { uses?: number; failText?: string } = {}) {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, token, body });
    const n = (used.get(token) ?? 0) + 1;
    used.set(token, n);
    if (opts.uses && n > opts.uses) return new Response("expired", { status: 401 });
    if (url.endsWith("/v1/audio/speech")) {
      if (opts.failText && (body as { input: string }).input.includes(opts.failText)) return new Response("boom", { status: 500 });
      return new Response(tone());
    }
    return Response.json({ text: " merhaba ", language: "tr", duration: 1.2 });
  });
  return { fetch, calls };
}

class FakeOutput implements AudioOutput {
  played: number[] = [];
  stopCalls = 0;
  async play(pcm: Pcm, onStart: () => void): Promise<"ended" | "stopped"> {
    this.played.push(pcm.samples.length);
    onStart();
    await new Promise((r) => setTimeout(r, 1));
    return "ended";
  }
  stop(): void {
    this.stopCalls++;
  }
}

function setup(service: ReturnType<typeof fakeService>, readerOptions: ReaderOptions = {}) {
  let issued = 0;
  const token = vi.fn(async () => `t${++issued}`);
  const speech = new FreyaSpeech({ token, fetch: service.fetch, tts: { url: "https://tts.test", sampleRate: RATE } });
  const output = new FakeOutput();
  const reader = speech.reader(output, { gapMs: 15, ...readerOptions });
  const said: string[] = [];
  const events: string[] = [];
  reader.on("sentenceStart", (e) => said.push(e.text));
  reader.on("chunk", (e) => events.push(`${e.seq}:${e.state}`));
  reader.on("chunkMissing", (e) => events.push(`${e.seq}:missing`));
  reader.on("chunkRecovered", (e) => events.push(`${e.seq}:recovered`));
  reader.on("chunkSkipped", (e) => events.push(`${e.seq}:skipped`));
  const done = new Promise<ReaderSummary>((r) => reader.on("done", r));
  return { speech, reader, output, said, events, done, token };
}

const ANSWER = ["Kart borcunuz 4.250 TL. ", "Son ödeme tarihi 20 Ekim. ", "Asgari tutar 1.200 TL."];

describe("SentenceAssembler", () => {
  it("joins chunks into sentences and waits when a period may be a thousands separator", () => {
    const a = new SentenceAssembler();
    expect(a.feed("Borcunuz 30.")).toEqual([]);
    expect(a.feed("000 TL. Son gün")).toEqual(["Borcunuz 30.000 TL."]);
    expect(a.feed(" yarın.<br>Teş")).toEqual(["Son gün yarın."]);
    expect(a.feed("ekkürler")).toEqual([]);
    expect(a.flush()).toEqual(["Teşekkürler"]);
  });

  it("drops bold markers and html tags split across chunks", () => {
    const a = new SentenceAssembler();
    expect(a.feed("***Tutar*** <b")).toEqual([]);
    expect(a.feed(">100</b> TL. ")).toEqual(["Tutar 100 TL."]);
  });
});

describe("TokenKeeper", () => {
  it("renews the token once on 401 and repeats the same request", async () => {
    const svc = fakeService({ uses: 1 });
    let n = 0;
    const keeper = new TokenKeeper({ token: async () => `k${++n}`, fetch: svc.fetch });
    expect((await keeper.fetch("https://x/v1/audio/speech", { method: "POST", body: "{}" })).status).toBe(200);
    expect((await keeper.fetch("https://x/v1/audio/speech", { method: "POST", body: "{}" })).status).toBe(200);
    expect(svc.calls.map((c) => c.token)).toEqual(["k1", "k1", "k2"]);
  });

  it("asks the token source once when requests start together", async () => {
    const svc = fakeService();
    const source = vi.fn(async () => "only");
    const keeper = new TokenKeeper({ token: source, fetch: svc.fetch });
    await Promise.all([1, 2, 3].map(() => keeper.fetch("https://x/v1/audio/speech", { method: "POST", body: "{}" })));
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh between parallel 401s", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      (init?.headers as Record<string, string>).Authorization === "Bearer old" ? new Response("", { status: 401 }) : new Response("ok"),
    );
    const source = vi.fn(async ({ refresh }: { refresh: boolean }) => (refresh ? "fresh" : "old"));
    const keeper = new TokenKeeper({ token: source, fetch });
    const res = await Promise.all([1, 2, 3].map(() => keeper.fetch("https://x/v1/audio/speech", { method: "POST", body: "{}" })));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(source.mock.calls.filter(([o]) => o.refresh)).toHaveLength(1);
  });
});

describe("SpeechReader", () => {
  it("reads chunks that arrive out of order in the answer's order", async () => {
    const t = setup(fakeService());
    t.reader.push({ seq: 1, text: ANSWER[1] });
    t.reader.push({ seq: 0, text: ANSWER[0] });
    t.reader.push({ seq: 2, text: ANSWER[2], final: true });
    const summary = await t.done;
    expect(t.said).toEqual(["Kart borcunuz 4.250 TL.", "Son ödeme tarihi 20 Ekim.", "Asgari tutar 1.200 TL."]);
    expect(t.events).toEqual(["1:held", "0:late", "1:ok", "2:ok"]);
    expect(summary).toMatchObject({ chunks: 3, sentences: 3, late: 1, lost: 0 });
  });

  it("asks for a chunk that never arrived and continues from it", async () => {
    const fetchMissing = vi.fn(async (seq: number): Promise<Chunk> => ({ seq, text: ANSWER[seq] }));
    const t = setup(fakeService(), { fetchMissing });
    t.reader.push({ seq: 0, text: ANSWER[0] });
    t.reader.push({ seq: 2, text: ANSWER[2], final: true });
    await t.done;
    expect(fetchMissing).toHaveBeenCalledWith(1, expect.anything());
    expect(t.said).toHaveLength(3);
    expect(t.events).toContain("1:recovered");
  });

  it("skips a lost chunk when it cannot be fetched again", async () => {
    const t = setup(fakeService(), { resendTries: 2 });
    t.reader.push({ seq: 0, text: ANSWER[0] });
    t.reader.push({ seq: 2, text: ANSWER[2], final: true });
    const summary = await t.done;
    expect(t.events.filter((e) => e === "1:missing")).toHaveLength(2);
    expect(t.events).toContain("1:skipped");
    expect(t.said).toEqual(["Kart borcunuz 4.250 TL.", "Asgari tutar 1.200 TL."]);
    expect(summary.skipped).toBe(1);
  });

  it("survives a token that expires mid-answer: renews and reads every sentence", async () => {
    const svc = fakeService({ uses: 1 });
    const t = setup(svc);
    const refreshed = vi.fn();
    t.speech.on("tokenRefresh", refreshed);
    ANSWER.forEach((text, seq) => t.reader.push({ seq, text }));
    t.reader.end();
    await t.done;
    expect(t.said).toHaveLength(3);
    expect(refreshed).toHaveBeenCalled();
    expect(svc.calls.filter((c) => c.url.endsWith("/speech")).map((c) => (c.body as { input: string }).input)).toContain(
      "Son ödeme tarihi 20 Ekim.",
    );
  });

  it("shows a sentence whose TTS fails twice as text and goes on", async () => {
    const t = setup(fakeService({ failText: "Son" }));
    const silent: string[] = [];
    t.reader.on("sentenceSilent", (e) => silent.push(e.text));
    ANSWER.forEach((text, seq) => t.reader.push({ seq, text }));
    t.reader.end(3);
    const summary = await t.done;
    expect(silent).toEqual(["Son ödeme tarihi 20 Ekim."]);
    expect(t.said).toEqual(["Kart borcunuz 4.250 TL.", "Asgari tutar 1.200 TL."]);
    expect(summary.silent).toBe(1);
  });

  it("groups sentences per request with groupSize", async () => {
    const svc = fakeService();
    const t = setup(svc, { groupSize: 2, splitFirst: false });
    ANSWER.forEach((text, seq) => t.reader.push({ seq, text }));
    t.reader.end();
    await t.done;
    expect(t.said).toEqual(["Kart borcunuz 4.250 TL. Son ödeme tarihi 20 Ekim.", "Asgari tutar 1.200 TL."]);
  });

  it("stops at once on barge-in and plays nothing more", async () => {
    const t = setup(fakeService());
    let done = false;
    t.reader.on("done", () => (done = true));
    t.reader.push({ seq: 0, text: ANSWER[0] });
    t.reader.stop();
    t.reader.push({ seq: 1, text: ANSWER[1], final: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.output.stopCalls).toBe(1);
    expect(t.said).toEqual([]);
    expect(done).toBe(false);
  });

  it("emits word events in order for the sentence being read", async () => {
    const t = setup(fakeService());
    const words: string[] = [];
    t.reader.on("word", (e) => words.push(e.word));
    t.reader.push({ text: "Merhaba, size nasıl yardımcı olabilirim?", final: true });
    await t.done;
    await new Promise((r) => setTimeout(r, 400));
    expect(words[0]).toBe("Merhaba,");
  });
});

describe("FreyaStt", () => {
  it("sends one recording as multipart and returns its text", async () => {
    const svc = fakeService();
    const speech = new FreyaSpeech({ token: "k", fetch: svc.fetch, stt: { url: "https://stt.test/v1/" } });
    const pcm: Pcm = { samples: new Int16Array(tone(0.1)), sampleRate: RATE };
    const result = await speech.stt.transcribe(pcm);
    expect(result).toMatchObject({ text: "merhaba", language: "tr", duration: 1.2 });
    expect(svc.calls[0].url).toBe("https://stt.test/v1/audio/transcriptions");
    const form = svc.calls[0].body as FormData;
    expect(form.get("language")).toBe("tr");
    expect(form.get("response_format")).toBe("verbose_json");
  });

  it("wraps PCM in a valid WAV header", () => {
    const wav = wavFromPcm({ samples: new Int16Array(100), sampleRate: 16000 });
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(200);
  });
});

describe("wordTimings", () => {
  it("gives every word a start, in order, inside the audio", () => {
    const pcm: Pcm = { samples: new Int16Array(tone(2)), sampleRate: RATE };
    const w = wordTimings("Borcunuz 4.250 TL, son gün yarın.", pcm);
    expect(w.map((x) => x.word)).toEqual(["Borcunuz", "4.250", "TL,", "son", "gün", "yarın."]);
    for (let i = 1; i < w.length; i++) expect(w[i].start).toBeGreaterThan(w[i - 1].start);
    expect(w[w.length - 1].end).toBeLessThanOrEqual(2.01);
    // a spoken number is long: "dort bin iki yuz elli"
    expect(w[1].end - w[1].start).toBeGreaterThan(w[0].end - w[0].start);
  });
});

describe("VoiceActivity", () => {
  it("reports speaking after a loud stretch and stops after silence", () => {
    const vad = new VoiceActivity();
    const seen: string[] = [];
    vad.on("speechStart", () => seen.push("start"));
    vad.on("speechEnd", () => seen.push("end"));
    const frame = (amp: number) => new Float32Array(160).map((_, i) => Math.sin(i / 3) * amp);
    for (let i = 0; i < 30; i++) vad.push(frame(0.001), 16000);
    for (let i = 0; i < 30; i++) vad.push(frame(0.3), 16000);
    expect(seen).toEqual(["start"]);
    for (let i = 0; i < 80; i++) vad.push(frame(0.001), 16000);
    expect(seen).toEqual(["start", "end"]);
  });
});
