import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentChat } from "../agent/rest.js";
import type { AudioOutput } from "./audio.js";
import { TokenKeeper, SpeechAuthError } from "./auth.js";
import { FreyaSpeech, type Chunk, type ReaderOptions, type ReaderSummary } from "./index.js";
import { SentenceAssembler } from "./text.js";
import { VoiceActivity } from "./vad.js";
import { wordTimings } from "./words.js";

const pcm = () => new Response(new Int16Array(1600).buffer);
const sound: AudioOutput = { play: async (_pcm, onStart) => (onStart(), "ended"), stop() {} };

function reading(options: ReaderOptions = {}, output: AudioOutput = sound, synth?: (input: string) => Promise<Response>) {
  const inputs: string[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const input = (JSON.parse(String(init?.body)) as { input: string }).input;
    inputs.push(input);
    return synth ? synth(input) : pcm();
  });
  const speech = new FreyaSpeech({ token: "t", fetch, tts: { url: "https://tts.test", sampleRate: 16000 } });
  const reader = speech.reader(output, { gapMs: 10, ...options });
  const order: string[] = [];
  const errors: string[] = [];
  reader.on("sentenceStart", (e) => order.push(`start:${e.text}`));
  reader.on("sentenceSilent", (e) => order.push(`silent:${e.text}`));
  reader.on("error", (e) => errors.push(e.message));
  const done = new Promise<ReaderSummary>((r) => reader.on("done", r));
  return { reader, inputs, order, errors, done };
}

// Time limits are loose (coverage slows the code down); the old code took seconds to minutes here.
describe("text that would freeze the app", () => {
  it("handles a long run of marks in linear time", () => {
    const a = new SentenceAssembler();
    const t = Date.now();
    a.feed(".".repeat(40_000));
    for (let i = 0; i < 40; i++) a.feed("!".repeat(500));
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("cuts text that never ends a sentence, so the buffer stays small", () => {
    const a = new SentenceAssembler();
    const out: string[] = [];
    const t = Date.now();
    for (let i = 0; i < 8000; i++) out.push(...a.feed("kelime kelime kelime kelime kelime kelime kelime "));
    expect(Date.now() - t).toBeLessThan(2500);
    expect(out.length).toBeGreaterThan(300);
    expect(Math.max(...out.map((s) => s.length))).toBeLessThanOrEqual(1000);
  });

  it("stays fast when every chunk is a run of marks that cleaning shrinks", () => {
    const a = new SentenceAssembler();
    const t = Date.now();
    for (let i = 0; i < 10_000; i++) a.feed("!!!!!!!!!!");
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("cuts a long sentence even when it ends within one chunk", () => {
    const a = new SentenceAssembler();
    const out = [...a.feed(`${"kelime ".repeat(300)}bitti. Son.`), ...a.flush()];
    expect(Math.max(...out.map((s) => s.length))).toBeLessThanOrEqual(1000);
    expect(out.join(" ").replace(/\s+/g, " ")).toBe(`${"kelime ".repeat(300)}bitti. Son.`.replace(/\s+/g, " "));
  });

  it("estimates word times for a huge word without stalling", () => {
    const t = Date.now();
    wordTimings(`${".".repeat(20_000)}a`, null, 1);
    expect(Date.now() - t).toBeLessThan(200);
  });

  it("reads a date as three numbers, not one large number", () => {
    const [date] = wordTimings("25.10.2026 tarihinde", null, 3);
    const [number] = wordTimings("25102026 tarihinde", null, 3);
    expect(date.end - date.start).toBeLessThan(number.end - number.start);
  });
});

describe("Turkish sentence ends", () => {
  const split = (text: string) => {
    const a = new SentenceAssembler();
    return [...a.feed(text), ...a.flush()];
  };

  it("keeps titles and abbreviations inside the sentence", () => {
    expect(split("Sayın Dr. Ahmet Yılmaz, randevunuz hazır. Prof. Dr. Ayşe Kaya bekliyor. ")).toEqual([
      "Sayın Dr. Ahmet Yılmaz, randevunuz hazır.",
      "Prof. Dr. Ayşe Kaya bekliyor.",
    ]);
    expect(split("Kart, nakit vb. ödemeler alınır. Freya A.Ş. adına arıyorum. ")).toEqual([
      "Kart, nakit vb. ödemeler alınır.",
      "Freya A.Ş. adına arıyorum.",
    ]);
  });

  it("keeps ordinals and numbered lines, splits after a number that ends a sentence", () => {
    expect(split("3. taksitiniz yarın. ")).toEqual(["3. taksitiniz yarın."]);
    expect(split("Kalan taksit sayısı 3. Ödeme yarın. ")).toEqual(["Kalan taksit sayısı 3.", "Ödeme yarın."]);
    expect(split("Gerekenler:\n1. Kimlik\n2. Adres belgesi")).toEqual(["Gerekenler:\n1. Kimlik\n2. Adres belgesi"]);
  });

  it("splits after a suffix, a large number and before a list that follows a blank line", () => {
    expect(split("Son ödeme ayın 5'i. Başka sorunuz var mı? ")).toEqual(["Son ödeme ayın 5'i.", "Başka sorunuz var mı?"]);
    expect(split("Tutar nedir? 2500. Teşekkürler. ")).toEqual(["Tutar nedir?", "2500.", "Teşekkürler."]);
    expect(split("Belgeler:\n\n1. Kimlik\n2. Adres")).toEqual(["Belgeler:\n1. Kimlik\n2. Adres"]);
  });

  it("waits for the next word to decide after a number and a dot", () => {
    const a = new SentenceAssembler();
    expect(a.feed("Taksitiniz 3. ")).toEqual([]);
    expect(a.feed("ayda bitiyor. ")).toEqual(["Taksitiniz 3. ayda bitiyor."]);
  });
});

describe("SpeechReader with odd input", () => {
  it("never voices 'undefined' for a chunk without text", async () => {
    const t = reading();
    t.reader.push({ seq: 0, text: "Merhaba." });
    t.reader.push({ seq: 1 } as unknown as Chunk);
    t.reader.push({ seq: 2, text: "Görüşürüz.", final: true });
    await t.done;
    expect(t.inputs.join(" ")).not.toContain("undefined");
    expect(t.order).toEqual(["start:Merhaba.", "start:Görüşürüz."]);
    expect(t.errors).toEqual(["Chunk 1 has no text"]);
  });

  it("reads chunks that are whole sentences one by one, with a space between", async () => {
    const t = reading();
    t.reader.push({ text: "Merhaba." });
    t.reader.push({ text: "Size nasıl yardımcı olabilirim?" });
    t.reader.push({ text: "Hesabınız hazır.", final: true });
    await t.done;
    expect(t.order).toEqual(["start:Merhaba.", "start:Size nasıl yardımcı olabilirim?", "start:Hesabınız hazır."]);
  });

  it("still joins a number split across chunks", async () => {
    const t = reading();
    t.reader.push({ text: "Borcunuz 30." });
    t.reader.push({ text: "000 TL.", final: true });
    await t.done;
    expect(t.inputs).toEqual(["Borcunuz 30.000 TL."]);
  });

  it("drops a seq that only looks like a number", async () => {
    const t = reading();
    t.reader.push({ seq: "1e0", text: "Bir. " });
    t.reader.push({ seq: "0x3", text: "İki. " });
    t.reader.push({ seq: "0", text: "Üç.", final: true });
    await t.done;
    expect(t.inputs).toEqual(["Üç."]);
    expect(t.errors).toHaveLength(2);
  });

  it("takes a repeated last chunk as a repeat, not an error", async () => {
    const t = reading();
    const states: string[] = [];
    t.reader.on("chunk", (e) => states.push(e.state));
    t.reader.push({ seq: 0, text: "Bir.", final: true });
    await t.done;
    t.reader.push({ seq: 0, text: "Bir.", final: true });
    expect(states).toEqual(["ok", "duplicate"]);
    expect(t.errors).toEqual([]);
  });

  it("does not put a space before a suffix in the next chunk", async () => {
    const t = reading();
    t.reader.push({ text: "Freya A.Ş." });
    t.reader.push({ text: "'nin müşterisiniz.", final: true });
    await t.done;
    expect(t.order).toEqual(["start:Freya A.Ş.'nin müşterisiniz."]);
  });

  it("says so when a chunk comes after the answer ended", async () => {
    const t = reading();
    t.reader.push({ seq: 0, text: "Bir.", final: true });
    await t.done;
    t.reader.push({ seq: 1, text: "Geç." });
    expect(t.errors).toEqual(["Chunk dropped: the answer has already ended"]);
  });

  it("asks fetchMissing once at a time and skips when it finds nothing", async () => {
    const fetchMissing = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return null as unknown as Chunk;
    });
    const t = reading({ gapMs: 20, resendTries: 2, fetchMissing });
    t.reader.push({ seq: 0, text: "Bir. " });
    t.reader.push({ seq: 2, text: "Üç. " });
    t.reader.push({ seq: 3, text: "Dört.", final: true });
    const summary = await t.done;
    expect(fetchMissing).toHaveBeenCalledTimes(2);
    expect(summary.skipped).toBe(1);
    expect(t.inputs.join(" ")).not.toContain("undefined");
  });

  it("does not wait forever on a fetchMissing that never settles", async () => {
    const t = reading({ gapMs: 10, resendTries: 2, fetchMissing: () => new Promise<Chunk>(() => {}) });
    t.reader.push({ seq: 0, text: "Bir. " });
    t.reader.push({ seq: 2, text: "Üç.", final: true });
    const summary = await t.done;
    expect(summary.skipped).toBe(1);
  });

  it("tells a silent sentence in its turn, after the ones before it", async () => {
    const t = reading({ parallel: 3 }, sound, async (input) => {
      if (input === "İki.") return new Response("down", { status: 500 });
      await new Promise((r) => setTimeout(r, 20));
      return pcm();
    });
    t.reader.push({ text: "Bir. İki. Üç.", final: true });
    await t.done;
    expect(t.order).toEqual(["start:Bir.", "silent:İki.", "start:Üç."]);
  });

  it("stopping a finished reader leaves the next reader's sentence alone", async () => {
    let stops = 0;
    const shared: AudioOutput = {
      play: async (_pcm, onStart) => {
        onStart();
        await new Promise((r) => setTimeout(r, 20));
        return "ended";
      },
      stop: () => stops++,
    };
    const a = reading({}, shared);
    a.reader.push({ text: "Bir.", final: true });
    await a.done;
    const b = reading({}, shared);
    b.reader.push({ text: "İki.", final: true });
    await new Promise((r) => setTimeout(r, 5));
    a.reader.stop();
    await b.done;
    expect(stops).toBe(0);
  });
});

describe("TokenKeeper refuses what it should", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never follows a redirect", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    await new TokenKeeper({ token: "t", fetch }).fetch("https://x/v1/audio/speech", { redirect: "follow" });
    expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("refuses an answer that came through a redirect (React Native follows them)", async () => {
    const redirected = Object.defineProperty(new Response("pcm"), "redirected", { value: true });
    const keeper = new TokenKeeper({ token: "t", fetch: vi.fn(async () => redirected) });
    await expect(keeper.fetch("https://x/v1/audio/speech")).rejects.toThrow(/redirect/);
  });

  it("trims the newline a backend's text answer ends with", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    await new TokenKeeper({ token: async () => "eyJ.abc.def\n", fetch }).fetch("https://x/v1/audio/speech");
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer eyJ.abc.def");
  });

  it("rejects an empty token from the token function with a clear error", async () => {
    const keeper = new TokenKeeper({ token: async () => undefined as unknown as string, fetch: vi.fn() });
    await expect(keeper.fetch("https://x/v1/audio/speech")).rejects.toBeInstanceOf(SpeechAuthError);
  });

  it("does not repeat a malformed token in its error", async () => {
    const keeper = new TokenKeeper({ token: async () => "eyJsecret\ntail", fetch: vi.fn() });
    const err = (await keeper.fetch("https://x/v1/audio/speech").catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(SpeechAuthError);
    expect(err.message).not.toContain("secret");
  });

  it("adds nothing to the caller's signal, which a reader shares across requests", async () => {
    const ctl = new AbortController();
    const add = vi.spyOn(ctl.signal, "addEventListener");
    const keeper = new TokenKeeper({ token: "t", fetch: vi.fn(async () => new Response("ok")) });
    for (let i = 0; i < 20; i++) await keeper.fetch("https://x/v1/audio/speech", { signal: ctl.signal });
    expect(add).not.toHaveBeenCalled();
  });

  it("explains that React Native needs a file when it cannot build a Blob from bytes", async () => {
    vi.stubGlobal(
      "Blob",
      class {
        constructor() {
          throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
        }
      },
    );
    const speech = new FreyaSpeech({ token: "t", fetch: vi.fn() });
    await expect(speech.stt.transcribe(new Uint8Array(4))).rejects.toThrow(/uri/);
  });
});

describe("AgentChat on a slow first turn", () => {
  it("keeps the conversation the server started, so a retry continues it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1
        ? new Response(JSON.stringify({ data: { result: { callId: "call-1" } } }), { status: 504 })
        : new Response(JSON.stringify({ data: { result: { callId: "call-1", response: "Buyrun" } } }));
    });
    const chat = new AgentChat({ baseUrl: "https://x", token: "k", workflowId: "w", fetch });
    await expect(chat.send("Merhaba")).rejects.toMatchObject({ status: 504 });
    expect(chat.callId).toBe("call-1");
    await chat.send("Merhaba");
    expect(bodies[1]).toEqual({ message: "Merhaba", callId: "call-1" });
  });
});

describe("VoiceActivity options", () => {
  it("keeps the defaults for options given as undefined", () => {
    const vad = new VoiceActivity({ startMs: undefined, minLevel: undefined });
    const starts: number[] = [];
    vad.on("speechStart", (e) => starts.push(e.at));
    const loud = new Float32Array(160).fill(0.5);
    for (let i = 0; i < 30; i++) vad.push(loud, 16000);
    expect(starts).toHaveLength(1);
  });
});
