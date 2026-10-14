import { describe, expect, it, vi } from "vitest";

import { WebAudioOutput } from "./audio.js";
import { TokenKeeper } from "./auth.js";
import { FreyaStt, type WebSocketLike } from "./stt.js";

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

function stt(token = "t1", url = "https://stt.example.com/v1/") {
  const keeper = new TokenKeeper({ token, fetch: vi.fn() });
  return new FreyaStt(keeper, { url });
}

describe("FreyaStt.stream", () => {
  it("connects with the token, sends config first, then the frames queued before open", async () => {
    const ws = new FakeSocket();
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const stream = await stt().stream({
      sampleRate: 16000,
      createWebSocket: (url, headers) => {
        seen = { url, headers };
        return ws;
      },
    });
    expect(seen).toEqual({ url: "wss://stt.example.com/v1/audio/stream", headers: { Authorization: "Bearer t1" } });
    expect(ws.binaryType).toBe("arraybuffer");

    stream.send(new Int16Array([1, 2, 3]));
    stream.finish();
    expect(ws.sent).toHaveLength(0);

    const opened = vi.fn();
    stream.on("open", opened);
    ws.open();
    expect(opened).toHaveBeenCalledOnce();
    expect(JSON.parse(ws.sent[0] as string)).toEqual({ type: "config", language: "tr", sample_rate: 16000 });
    expect(new Int16Array(ws.sent[1] as ArrayBuffer)).toEqual(new Int16Array([1, 2, 3]));
    expect(JSON.parse(ws.sent[2] as string)).toEqual({ type: "close" });

    stream.send(new Int16Array([4]).buffer);
    expect(ws.sent).toHaveLength(4);
  });

  it("emits partials, then the result, and closes without an error", async () => {
    const ws = new FakeSocket();
    const stream = await stt().stream({ createWebSocket: () => ws });
    const events: string[] = [];
    stream.on("partial", (p) => events.push(`partial:${p.text}:${p.final}`));
    stream.on("result", (r) => events.push(`result:${r.text}`));
    stream.on("error", (e) => events.push(`error:${e.message}`));
    stream.on("close", () => events.push("close"));
    ws.open();
    ws.message({ type: "partial", text: "Kart" });
    ws.message({ type: "final", text: "Kart borcum" });
    ws.message("not json");
    ws.message({ type: "result", text: " Kart borcum ne kadar " });
    expect(events).toEqual(["partial:Kart:false", "partial:Kart borcum:true", "result:Kart borcum ne kadar", "close"]);
    expect(ws.closed).toBe(true);
  });

  it("reports a service error and a socket that closes before the result", async () => {
    const ws = new FakeSocket();
    const stream = await stt().stream({ createWebSocket: () => ws });
    const errors: string[] = [];
    stream.on("error", (e) => errors.push(e.message));
    ws.open();
    ws.message({ type: "error", message: "bad audio" });
    ws.onerror?.({});
    ws.close();
    expect(errors).toEqual(["bad audio", "STT connection failed", "STT connection closed before the result"]);
  });

  it("cancel closes quietly", async () => {
    const ws = new FakeSocket();
    const stream = await stt().stream({ createWebSocket: () => ws });
    const errors = vi.fn();
    stream.on("error", errors);
    stream.cancel();
    expect(ws.closed).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it("asks for a WebSocket factory when the runtime has none", async () => {
    const saved = globalThis.WebSocket;
    // @ts-expect-error simulate a runtime without WebSocket
    delete globalThis.WebSocket;
    try {
      await expect(stt().stream()).rejects.toThrow(/createWebSocket/);
    } finally {
      globalThis.WebSocket = saved;
    }
  });
});

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  connect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  state = "suspended";
  destination = {};
  sources: FakeSource[] = [];
  data: Float32Array | null = null;
  async resume() {
    this.state = "running";
  }
  createBuffer(_channels: number, length: number) {
    this.data = new Float32Array(length);
    return { getChannelData: () => this.data as Float32Array };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const pcm = { samples: new Int16Array([0, 16384, -32768]), sampleRate: 16000 };

describe("WebAudioOutput", () => {
  it("unlocks a suspended context and plays a clip to its end", async () => {
    const ctx = new FakeContext();
    const out = new WebAudioOutput({ context: ctx });
    await out.unlock();
    expect(ctx.state).toBe("running");

    const onStart = vi.fn();
    const done = out.play(pcm, onStart);
    expect(onStart).toHaveBeenCalledOnce();
    expect(ctx.sources[0].started).toBe(true);
    expect(Array.from(ctx.data ?? [])).toEqual([0, 0.5, -1]);
    ctx.sources[0].onended?.();
    await expect(done).resolves.toBe("ended");
  });

  it("stop ends the clip as stopped, and a new clip stops the old one", async () => {
    const ctx = new FakeContext();
    const out = new WebAudioOutput({ context: ctx });
    const first = out.play(pcm, () => {});
    const second = out.play(pcm, () => {});
    await expect(first).resolves.toBe("stopped");
    expect(ctx.sources[0].stopped).toBe(true);
    out.stop();
    await expect(second).resolves.toBe("stopped");
  });

  it("ends the clip on a timer when the runtime never fires onended", async () => {
    vi.useFakeTimers();
    try {
      const out = new WebAudioOutput({ context: new FakeContext() });
      const done = out.play(pcm, () => {});
      vi.advanceTimersByTime(1000);
      await expect(done).resolves.toBe("ended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the context on first use from the constructor it was given", async () => {
    const made: FakeContext[] = [];
    const out = new WebAudioOutput({
      AudioContext: class extends FakeContext {
        constructor() {
          super();
          made.push(this);
        }
      },
    });
    expect(made).toHaveLength(0);
    await out.unlock();
    expect(made).toHaveLength(1);
  });

  it("says what to pass when there is no AudioContext", () => {
    const saved = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    try {
      expect(() => new WebAudioOutput().play(pcm, () => {})).toThrow(/options.context/);
    } finally {
      (globalThis as { AudioContext?: unknown }).AudioContext = saved;
    }
  });
});
