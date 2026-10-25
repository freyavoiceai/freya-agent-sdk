import { describe, expect, it, vi } from "vitest";

import type { AudioOutput } from "./audio.js";
import { WebAudioOutput, type AudioContextLike } from "./audio.js";
import { FreyaSpeech, SpeechHttpError, type ReaderOptions, type ReaderSummary } from "./index.js";
import { TokenKeeper, secureBase } from "./auth.js";
import { FreyaStt, type WebSocketLike } from "./stt.js";
import { SentenceAssembler } from "./text.js";

const ok = () => new Response(new Int16Array(1600).buffer);

function reading(options: ReaderOptions = {}, output?: AudioOutput) {
  const speech = new FreyaSpeech({ token: "t", fetch: vi.fn(async () => ok()), tts: { url: "https://tts.test", sampleRate: 16000 } });
  const out: AudioOutput = output ?? { play: async (_pcm, onStart) => (onStart(), "ended"), stop() {} };
  const reader = speech.reader(out, { gapMs: 5, ...options });
  const said: string[] = [];
  const silent: string[] = [];
  const errors: string[] = [];
  reader.on("sentenceStart", (e) => said.push(e.text));
  reader.on("sentenceSilent", (e) => silent.push(e.text));
  reader.on("error", (e) => errors.push(e.message));
  const done = new Promise<ReaderSummary>((r) => reader.on("done", r));
  return { reader, said, silent, errors, done };
}

describe("SentenceAssembler with < and >", () => {
  it("keeps comparison signs: only real tags are removed", () => {
    const a = new SentenceAssembler();
    expect(a.feed("Faiz oranı %3 < %5 oldu. Ayrıca > işareti var. ")).toEqual([
      "Faiz oranı %3 < %5 oldu.",
      "Ayrıca > işareti var.",
    ]);
  });

  it("does not hold every later sentence back after a lone <", () => {
    const a = new SentenceAssembler();
    expect(a.feed("Tutar 1 < 2 bin TL. ")).toEqual(["Tutar 1 < 2 bin TL."]);
    expect(a.feed("Ödeme yapıldı. ")).toEqual(["Ödeme yapıldı."]);
  });
});

describe("SpeechReader input checks", () => {
  it("reads chunks whose seq arrives as a numeric string, in order", async () => {
    const t = reading();
    t.reader.push({ seq: "1", text: "İki. " });
    t.reader.push({ seq: "0", text: "Bir. " });
    t.reader.push({ seq: "2", text: "Üç.", final: true });
    await t.done;
    expect(t.said).toEqual(["Bir.", "İki.", "Üç."]);
    expect(t.errors).toEqual([]);
  });

  it("drops a chunk whose seq is not a whole number, and says so", async () => {
    const t = reading();
    t.reader.push({ seq: "x", text: "Bozuk. " });
    t.reader.push({ seq: -1, text: "Eksi. " });
    t.reader.push({ seq: 0, text: "Bir.", final: true });
    await t.done;
    expect(t.said).toEqual(["Bir."]);
    expect(t.errors).toHaveLength(2);
  });

  it("drops a chunk far ahead instead of waiting for every chunk before it", async () => {
    const t = reading({ maxAhead: 5 });
    t.reader.push({ seq: 0, text: "Bir. " });
    t.reader.push({ seq: 500, text: "Uzak." });
    t.reader.end();
    const summary = await t.done;
    expect(t.said).toEqual(["Bir."]);
    expect(summary.skipped).toBe(0);
    expect(t.errors[0]).toMatch(/500/);
  });

  it("ignores a chunk count far beyond what arrived", async () => {
    const t = reading({ maxAhead: 5 });
    t.reader.push({ seq: 0, text: "Bir." });
    t.reader.end(10_000);
    const summary = await t.done;
    expect(t.said).toEqual(["Bir."]);
    expect(summary.skipped).toBe(0);
  });

  it("shows a sentence the device would not play as text and reads on", async () => {
    let calls = 0;
    const output: AudioOutput = {
      play: async (_pcm, onStart) => {
        if (++calls === 1) throw new Error("audio device busy");
        onStart();
        return "ended";
      },
      stop() {},
    };
    const t = reading({}, output);
    t.reader.push({ text: "Bir. İki.", final: true });
    const summary = await t.done;
    expect(t.silent).toEqual(["Bir."]);
    expect(t.said).toEqual(["İki."]);
    expect(t.errors).toEqual(["Playback failed: audio device busy"]);
    expect(summary.silent).toBe(1);
  });
});

describe("TokenKeeper safety", () => {
  it("aborts a request that runs past timeoutMs", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    );
    const keeper = new TokenKeeper({ token: "t", fetch, timeoutMs: 20 });
    await expect(keeper.fetch("https://x/v1/audio/speech")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("still honours the caller's own abort", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // like fetch: a signal aborted before the call rejects at once
          if (init?.signal?.aborted) reject(new Error("aborted"));
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const keeper = new TokenKeeper({ token: "t", fetch });
    const ctl = new AbortController();
    const pending = keeper.fetch("https://x/v1/audio/speech", { signal: ctl.signal });
    ctl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("keeps headers given as a Headers object", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("ok"));
    const keeper = new TokenKeeper({ token: "t", fetch });
    await keeper.fetch("https://x/v1/audio/speech", { headers: new Headers({ "Content-Type": "application/json" }) });
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer t" });
  });

  it("does not renew on every request a token that is already due", async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const source = vi.fn(async () => `${part({ alg: "RS256" })}.${part({ exp: now + 30 })}.sig`);
    const keeper = new TokenKeeper({ token: source, fetch: vi.fn(async () => new Response("ok")) });
    for (let i = 0; i < 5; i++) await keeper.fetch("https://x/v1/audio/speech");
    expect(source).toHaveBeenCalledTimes(1);
  });
});

describe("secure URLs", () => {
  it("accepts https and plain http to this machine only", () => {
    expect(secureBase("https://stt.freyavoice.ai/", "stt.url")).toBe("https://stt.freyavoice.ai");
    expect(secureBase("http://localhost:8787/freya", "stt.url")).toBe("http://localhost:8787/freya");
    expect(secureBase("http://127.0.0.1:8787", "stt.url")).toBe("http://127.0.0.1:8787");
    expect(() => secureBase("http://bank.example/freya", "stt.url")).toThrow(/https/);
    expect(() => secureBase("http://localhost.evil.example", "stt.url")).toThrow(/https/);
    expect(() => secureBase("ftp://x", "stt.url")).toThrow(/https/);
  });

  it("refuses an http service URL when the client is built", () => {
    expect(() => new FreyaSpeech({ token: "t", tts: { url: "http://tts.example" } })).toThrow(/tts.url/);
  });
});

describe("errors keep the service's answer out of the message", () => {
  it("puts the body in `body`, not `message`", async () => {
    const speech = new FreyaSpeech({ token: "t", fetch: vi.fn(async () => new Response("input: Ayşe Yılmaz 5321", { status: 400 })) });
    const err = (await speech.tts.synthesize("x").catch((e) => e)) as SpeechHttpError;
    expect(err).toBeInstanceOf(SpeechHttpError);
    expect(err.message).toBe("TTS 400");
    expect(err.body).toContain("Ayşe");
  });
});

describe("SttStream with odd frames", () => {
  it("ignores frames that are not an object or carry no text", async () => {
    let socket!: WebSocketLike;
    const keeper = new TokenKeeper({ token: "t", fetch: vi.fn() });
    const stream = await new FreyaStt(keeper, { url: "https://stt.test" }).stream({
      createWebSocket: () => {
        socket = { binaryType: "", readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null };
        return socket;
      },
    });
    const partials: string[] = [];
    stream.on("partial", (e) => partials.push(e.text));
    socket.onopen?.({});
    for (const data of ["null", "42", '{"type":"partial","text":5}', '{"type":"partial","text":"merhaba"}']) {
      expect(() => socket.onmessage?.({ data })).not.toThrow();
    }
    expect(partials).toEqual(["merhaba"]);
  });
});

describe("WebAudioOutput.close", () => {
  it("closes a context it created and leaves one it was given", async () => {
    const make = () => {
      const ctx = {
        destination: {},
        close: vi.fn(async () => {}),
        createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
        createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {}, onended: null }),
      };
      return ctx as AudioContextLike & { close: ReturnType<typeof vi.fn> };
    };
    const own = make();
    const created = new WebAudioOutput({ AudioContext: function () { return own; } as unknown as new () => AudioContextLike });
    await created.unlock();
    await created.close();
    expect(own.close).toHaveBeenCalled();

    const given = make();
    await new WebAudioOutput({ context: given }).close();
    expect(given.close).not.toHaveBeenCalled();
  });
});
