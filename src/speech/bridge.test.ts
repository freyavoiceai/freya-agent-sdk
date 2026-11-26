import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeMic, type BridgeHost } from "./bridge.js";
import { Dictation } from "./dictation.js";

function b64(samples: Int16Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(samples.buffer)));
}

function frame(n = 800, v = 1000): Int16Array {
  return new Int16Array(n).fill(v);
}

const ok = async () => ({ status: 200, headers: { get: () => null }, text: async () => '{"text":"merhaba"}' });

function setup(start: () => boolean | void = () => true, extra: { maxSeconds?: number; onLimit?: "stop" | "reject" } = {}) {
  const calls: string[] = [];
  const bodies: Uint8Array[] = [];
  const host: BridgeHost = {
    FreyaMicNative: { start: () => (calls.push("start"), start()), stop: () => calls.push("stop") },
  };
  const mic = new BridgeMic({ host });
  const d = new Dictation({
    url: "https://p.example/stt",
    transport: async (r) => (bodies.push(r.body), ok()),
    ...extra,
  });
  return { host, mic, d, calls, bodies };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("BridgeMic", () => {
  it("pushes native frames into the dictation and posts them as WAV", async () => {
    const { host, mic, d, calls, bodies } = setup();
    expect(mic.start(d)).toBe(true);
    host.freyaMic!.onFrame(b64(frame(800, 1000)));
    host.freyaMic!.onFrame(b64(frame(800, 2000)));
    const stopped = mic.stop();
    host.freyaMic!.onEnd();
    await stopped;
    expect(calls).toEqual(["start", "stop"]);
    expect(d.seconds).toBeCloseTo(0.1);
    expect((await d.finish()).text).toBe("merhaba");
    const pcm = new Int16Array(bodies[0].buffer.slice(bodies[0].byteOffset + 44));
    expect([pcm.length, pcm[0], pcm[1600 - 1]]).toEqual([1600, 1000, 2000]);
  });

  it("reports a refused start and ignores frames after it", () => {
    const { host, mic, d } = setup(() => false);
    expect(mic.start(d)).toBe(false);
    host.freyaMic!.onFrame(b64(frame()));
    expect(d.seconds).toBe(0);
  });

  it("gives frames to level listeners", () => {
    const { host, mic, d } = setup();
    const seen: number[] = [];
    mic.onFrame((f) => seen.push(f.length));
    mic.start(d);
    host.freyaMic!.onFrame(b64(frame(400)));
    expect(seen).toEqual([400]);
  });

  it("stops the native side when the dictation reaches its cap", () => {
    const { host, mic, d, calls } = setup(() => true, { maxSeconds: 1 });
    mic.start(d);
    host.freyaMic!.onFrame(b64(frame(16000)));
    host.freyaMic!.onFrame(b64(frame(800)));
    host.freyaMic!.onFrame(b64(frame(800)));
    expect(calls).toEqual(["start", "stop"]);
    expect(d.seconds).toBe(1);
  });

  it("in reject mode stops the native side and lets finish() report too_long", async () => {
    const { host, mic, d, calls } = setup(() => true, { maxSeconds: 1, onLimit: "reject" });
    mic.start(d);
    host.freyaMic!.onFrame(b64(frame(16800)));
    expect(calls).toEqual(["start", "stop"]);
    await expect(d.finish()).rejects.toMatchObject({ code: "too_long" });
  });

  it("stop() gives up waiting for onEnd after the timeout", async () => {
    const { mic, d } = setup();
    mic.start(d);
    const p = mic.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
  });

  it("drives an iOS WKWebView handler with start and stop commands", async () => {
    const sent: unknown[] = [];
    const host: BridgeHost = { webkit: { messageHandlers: { FreyaMicNative: { postMessage: (m) => sent.push(m) } } } };
    const mic = new BridgeMic({ host });
    const d = new Dictation({ url: "https://p.example/stt", transport: ok });
    expect(mic.start(d)).toBe(true);
    host.freyaMic!.onFrame(b64(frame()));
    const p = mic.stop();
    host.freyaMic!.onEnd();
    await p;
    expect(sent).toEqual([{ command: "start" }, { command: "stop" }]);
    expect(d.seconds).toBeCloseTo(0.05);
  });

  it("throws when the page has no bridge, and dispose removes the callbacks", () => {
    const host: BridgeHost = {};
    const mic = new BridgeMic({ host });
    expect(() => mic.start(new Dictation({ url: "https://p.example/s", transport: ok }))).toThrow("bridge");
    mic.dispose();
    expect(host.freyaMic).toBeUndefined();
  });
});
