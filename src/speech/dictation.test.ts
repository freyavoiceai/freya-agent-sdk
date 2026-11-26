import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dictation, DictationError, type DictationTransport, type DictationTransportResponse } from "./dictation.js";

const OK = { callId: "c1", turnId: 2, text: "merhaba", language: "tr", audioDurationMs: 1000, words: [{ word: "merhaba", confidence: 0.9 }] };

function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}): DictationTransportResponse {
  return {
    status,
    headers: { get: (n) => headers[n] ?? headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function scripted(...steps: DictationTransportResponse[]) {
  const calls: Parameters<DictationTransport>[0][] = [];
  const transport: DictationTransport = async (req) => {
    calls.push(req);
    return steps[Math.min(calls.length - 1, steps.length - 1)];
  };
  return { transport, calls };
}

function tone(seconds: number, rate = 16000): Int16Array {
  const x = new Int16Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) x[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return x;
}

const URL_ = "https://proxy.example/stt";

function make(transport: DictationTransport, extra: Partial<ConstructorParameters<typeof Dictation>[0]> = {}) {
  return new Dictation({ url: URL_, transport, random: () => 1, ...extra });
}

async function settle<T>(p: Promise<T>): Promise<T | DictationError> {
  const guarded = p.catch((e) => e as DictationError);
  await vi.runAllTimersAsync();
  return guarded;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("request", () => {
  it("posts one 16 kHz mono WAV with the caller's headers and returns the transcript", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const headers = vi.fn(async (i: { attempt: number }) => ({ "X-Call-Id": "c1", "X-Attempt": String(i.attempt) }));
    const d = make(transport, { headers });
    d.push(tone(0.5, 16000), 16000);
    const t = await d.finish();
    expect(t.text).toBe("merhaba");
    expect(t.turnId).toBe(2);
    expect(t.raw.words).toBeDefined();
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe(URL_);
    expect(c.method).toBe("POST");
    expect(c.headers).toEqual({ "X-Call-Id": "c1", "X-Attempt": "1", "Content-Type": "audio/wav" });
    const b = c.body;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(b.length - 8);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true)]).toEqual([1, 1, 16000, 32000]);
    expect([v.getUint16(32, true), v.getUint16(34, true), v.getUint32(40, true)]).toEqual([2, 16, 16000]);
    expect(headers).toHaveBeenCalledWith({ attempt: 1, durationMs: 500, bytes: 16044 });
  });

  it("resamples stereo Float32 at 48 kHz to 16 kHz mono across pushes", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const d = make(transport);
    const mono = new Float32Array(48000);
    for (let i = 0; i < mono.length; i++) mono[i] = 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const stereo = new Float32Array(mono.length * 2);
    mono.forEach((s, i) => ((stereo[2 * i] = s), (stereo[2 * i + 1] = s)));
    for (let i = 0; i < stereo.length; i += 9600) d.push(stereo.subarray(i, i + 9600), 48000, 2);
    await d.finish();
    const body = calls[0].body;
    const pcm = new Int16Array(body.buffer.slice(body.byteOffset + 44, body.byteOffset + body.length));
    expect(Math.abs(pcm.length - 16000)).toBeLessThanOrEqual(1);
    let worst = 0;
    for (let i = 400; i < pcm.length - 400; i++) {
      worst = Math.max(worst, Math.abs(pcm[i] / 32768 - 0.4 * Math.sin((2 * Math.PI * 1000 * i) / 16000)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("emits an attempt event with status and timing only", async () => {
    const { transport } = scripted(reply(200, OK));
    const d = make(transport);
    const seen: unknown[] = [];
    d.on("attempt", (e) => seen.push(e));
    d.push(tone(0.1), 16000);
    await d.finish();
    expect(seen).toEqual([{ attempt: 1, status: 200, ms: 0 }]);
  });

  it("rejects an empty dictation, a bad url and a changing sample rate", async () => {
    const { transport } = scripted(reply(200, OK));
    const err = await settle(make(transport).finish());
    expect(err).toMatchObject({ code: "no_audio" });
    expect(() => new Dictation({ url: "http://proxy.example/stt", transport })).toThrow(TypeError);
    const d = make(transport);
    d.push(tone(0.1), 16000);
    expect(() => d.push(tone(0.1, 8000), 8000)).toThrow(RangeError);
  });

  it("treats empty text as a normal result and a non-JSON 200 as invalid_response", async () => {
    const empty = make(scripted(reply(200, { ...OK, text: "" })).transport);
    empty.push(tone(0.1), 16000);
    expect((await empty.finish()).text).toBe("");
    const bad = make(scripted(reply(200, "<html>")).transport);
    bad.push(tone(0.1), 16000);
    expect(await settle(bad.finish())).toMatchObject({ code: "invalid_response", status: 200 });
  });
});

describe("duration and size caps", () => {
  it("stop mode (default) keeps exactly 20 s, signals the limit and returns false", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const d = make(transport);
    const onLimit = vi.fn();
    d.on("limit", onLimit);
    expect(d.push(tone(19), 16000)).toBe(true);
    expect(d.push(tone(3), 16000)).toBe(false);
    expect(d.push(tone(1), 16000)).toBe(false);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(d.seconds).toBe(20);
    await d.finish();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.length).toBe(44 + 20 * 16000 * 2);
  });

  it("cuts at the cap when audio arrives at another rate", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const d = make(transport, { maxSeconds: 2 });
    for (let i = 0; i < 5; i++) d.push(tone(1, 48000), 48000);
    await d.finish();
    expect(calls[0].body.length).toBe(44 + 2 * 16000 * 2);
  });

  it("reject mode throws too_long from push and finish, and sends nothing", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const d = make(transport, { onLimit: "reject" });
    const onError = vi.fn();
    d.on("error", onError);
    d.push(tone(19), 16000);
    expect(() => d.push(tone(2), 16000)).toThrow(DictationError);
    expect(await settle(d.finish())).toMatchObject({ code: "too_long" });
    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("never allows more than 30 s or 2 MB", () => {
    const { transport } = scripted(reply(200, OK));
    expect(() => make(transport, { maxSeconds: 30.5 })).toThrow(RangeError);
    expect(() => make(transport, { maxSeconds: 0 })).toThrow(RangeError);
    expect(() => make(transport, { maxSeconds: 30 })).not.toThrow();
  });

  it("a 30 s request stays under 2 MB", async () => {
    const { transport, calls } = scripted(reply(200, OK));
    const d = make(transport, { maxSeconds: 30 });
    d.push(tone(31), 16000);
    await d.finish();
    expect(calls[0].body.length).toBe(44 + 30 * 32000);
    expect(calls[0].body.length).toBeLessThan(2_000_000);
  });
});

describe("retry rules", () => {
  async function run(steps: DictationTransportResponse[], extra = {}) {
    const s = scripted(...steps);
    const attempts: number[] = [];
    const d = make(s.transport, { headers: (i) => (attempts.push(i.attempt), {}), ...extra });
    d.push(tone(0.1), 16000);
    const out = await settle(d.finish());
    return { out, calls: s.calls, attempts };
  }

  it("429 waits Retry-After seconds, then succeeds", async () => {
    const s = scripted(reply(429, { error: "busy" }, { "Retry-After": "7" }), reply(200, OK));
    const d = make(s.transport);
    d.push(tone(0.1), 16000);
    const p = d.finish();
    await vi.advanceTimersByTimeAsync(6999);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).text).toBe("merhaba");
    expect(s.calls).toHaveLength(2);
  });

  it("429 without Retry-After backs off, and stops after 3 retries", async () => {
    const { out, calls } = await run([reply(429, { error: "busy" })]);
    expect(calls).toHaveLength(4);
    expect(out).toMatchObject({ status: 429, code: "busy", attempts: 4 });
  });

  it("429 with a Retry-After beyond the cap fails at once, carrying retryAfterMs", async () => {
    const { out, calls } = await run([reply(429, { error: "busy" }, { "Retry-After": "120" })]);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ code: "busy", retryAfterMs: 120000 });
  });

  it.each([503, 504])("%i retries up to 3 times with the same bytes, then fails", async (status) => {
    const { out, calls, attempts } = await run([reply(status, { error: "stt_unavailable" })]);
    expect(calls).toHaveLength(4);
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(calls.every((c) => c.body === calls[0].body)).toBe(true);
    expect(out).toMatchObject({ status, attempts: 4 });
  });

  it("503 recovers on the third try", async () => {
    const { out, calls } = await run([reply(503, { error: "stt_unavailable" }), reply(504, { error: "stt_timeout" }), reply(200, OK)]);
    expect(calls).toHaveLength(3);
    expect(out).toMatchObject({ text: "merhaba" });
  });

  it("backoff grows between 503 retries", async () => {
    const s = scripted(reply(503, { error: "stt_unavailable" }));
    const d = make(s.transport);
    d.push(tone(0.1), 16000);
    const p = d.finish().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(499);
    expect(s.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(s.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.calls).toHaveLength(3);
    await vi.runAllTimersAsync();
    await p;
  });

  it("500 retries once", async () => {
    const { out, calls } = await run([reply(500, { error: "internal_error" })]);
    expect(calls).toHaveLength(2);
    expect(out).toMatchObject({ status: 500, code: "internal_error" });
    const ok = await run([reply(500, { error: "internal_error" }), reply(200, OK)]);
    expect(ok.out).toMatchObject({ text: "merhaba" });
  });

  it.each([
    [400, "invalid_audio"],
    [401, "unauthorized"],
    [409, "turn_conflict"],
    [413, "audio_too_large"],
    [404, "http_error"],
  ])("%i is never retried", async (status, code) => {
    const { out, calls } = await run([reply(status, status === 404 ? "nope" : { error: code })]);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ status, code, attempts: 1 });
  });

  it("keeps the response body out of the error message", async () => {
    const { out } = await run([reply(400, { error: "invalid_request", message: "secret words" })]);
    expect((out as DictationError).message).not.toContain("secret");
    expect((out as DictationError).body).toBe("");
  });

  it("emits error once and a headers failure is typed", async () => {
    const s = scripted(reply(200, OK));
    const d = make(s.transport, { headers: () => Promise.reject(new Error("no token")) });
    const onError = vi.fn();
    d.on("error", onError);
    d.push(tone(0.1), 16000);
    expect(await settle(d.finish())).toMatchObject({ code: "headers" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(0);
  });
});

describe("timeout and cancel", () => {
  it("aborts an attempt after 15 s and does not retry it", async () => {
    let signal: AbortSignal | undefined;
    const transport: DictationTransport = (req) => {
      signal = req.signal;
      return new Promise(() => undefined);
    };
    const d = make(transport);
    d.push(tone(0.1), 16000);
    const p = d.finish().catch((e) => e as DictationError);
    await vi.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await p).toMatchObject({ code: "timeout", status: 0, attempts: 1 });
  });

  it("timeoutMs is configurable and the timer restarts for each attempt", async () => {
    let n = 0;
    const transport: DictationTransport = async () => {
      n++;
      if (n === 1) return reply(503, { error: "stt_unavailable" });
      return new Promise(() => undefined);
    };
    const d = make(transport, { timeoutMs: 1000 });
    d.push(tone(0.1), 16000);
    const p = d.finish().catch((e) => e as DictationError);
    await vi.advanceTimersByTimeAsync(500 + 999);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ code: "timeout", attempts: 2 });
  });

  it("a transport that throws becomes a network error", async () => {
    const d = make(async () => {
      throw new TypeError("Network request failed");
    });
    d.push(tone(0.1), 16000);
    expect(await settle(d.finish())).toMatchObject({ code: "network", status: 0 });
  });

  it("cancel aborts the request in flight", async () => {
    let signal: AbortSignal | undefined;
    const d = make((req) => ((signal = req.signal), new Promise(() => undefined)));
    d.push(tone(0.1), 16000);
    const p = d.finish().catch((e) => e as DictationError);
    await vi.advanceTimersByTimeAsync(10);
    d.cancel();
    expect(signal?.aborted).toBe(true);
    expect(await p).toMatchObject({ code: "cancelled" });
  });

  it("cancel during a retry wait stops the retry", async () => {
    const s = scripted(reply(503, { error: "stt_unavailable" }));
    const d = make(s.transport);
    d.push(tone(0.1), 16000);
    const p = d.finish().catch((e) => e as DictationError);
    await vi.advanceTimersByTimeAsync(100);
    d.cancel();
    expect(await p).toMatchObject({ code: "cancelled" });
    await vi.runAllTimersAsync();
    expect(s.calls).toHaveLength(1);
  });

  it("push after finish throws", async () => {
    const d = make(scripted(reply(200, OK)).transport);
    d.push(tone(0.1), 16000);
    await d.finish();
    expect(() => d.push(tone(0.1), 16000)).toThrow("finished");
  });
});
