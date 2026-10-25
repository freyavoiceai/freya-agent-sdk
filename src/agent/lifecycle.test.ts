import { beforeEach, describe, expect, it, vi } from "vitest";

// small-webrtc-transport builds an AudioWorklet blob URL at import time.
vi.hoisted(() => {
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:stub";
  }
});

const created: FakePc[] = [];
let micDenied = false;
let micPrompt: Promise<void> = Promise.resolve();

class FakePc {
  state = "disconnected";
  disconnected = false;
  private rejectConnect: ((e: Error) => void) | null = null;
  resolveConnect: (() => void) | null = null;
  constructor() {
    created.push(this);
  }
  on() {}
  needsInit() {
    return true;
  }
  async initDevices() {
    await micPrompt;
    if (micDenied) throw new DOMException("Permission denied", "NotAllowedError");
  }
  connect() {
    this.state = "connecting";
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = () => {
        this.state = "ready";
        resolve();
      };
      this.rejectConnect = reject;
    });
  }
  // like SmallWebRTCTransport.stop(): a pending connect fails from inside disconnect
  async disconnect() {
    this.disconnected = true;
    this.state = "disconnected";
    await Promise.resolve();
    this.rejectConnect?.(new Error("TransportStartError"));
    this.rejectConnect = null;
  }
  enableMic() {}
}

vi.mock("@pipecat-ai/client-js", async (original) => ({
  ...(await original<typeof import("@pipecat-ai/client-js")>()),
  PipecatClient: FakePc,
}));

const { FreyaClient } = await import("./client.js");
const { NativeMicManager } = await import("./native-media-manager.js");

const tick = () => new Promise((r) => setTimeout(r, 5));
const client = (connectTimeoutMs?: number) =>
  new FreyaClient({ baseUrl: "https://x", token: "t", iceServers: [], logLevel: "none", connectTimeoutMs });

beforeEach(() => {
  created.length = 0;
  micDenied = false;
  micPrompt = Promise.resolve();
  vi.restoreAllMocks();
});

describe("FreyaClient lifecycle", () => {
  it("rejects connect() when the microphone is denied, and can connect again later", async () => {
    micDenied = true;
    const c = client();
    await expect(c.connect()).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(c.state).toBe("disconnected");
    micDenied = false;
    const again = c.connect();
    await tick();
    created[1].resolveConnect?.();
    await again;
    expect(c.state).toBe("ready");
  });

  it("hang up, call again, hang up: the second call does not go live", async () => {
    const c = client();
    const first = c.connect();
    await tick();
    await c.disconnect();
    await first;
    const second = c.connect();
    await tick();
    await c.disconnect();
    expect(created[1].disconnected).toBe(true);
    created[1].resolveConnect?.();
    await second;
    expect(c.state).toBe("disconnected");
  });

  it("gives up on a handshake that never finishes", async () => {
    const c = client(20);
    await expect(c.connect()).rejects.toThrow(/timed out/);
    expect(created[0].disconnected).toBe(true);
    const again = c.connect();
    await tick();
    created[1].resolveConnect?.();
    await again;
    expect(c.state).toBe("ready");
  });

  it("reports the handshake state while it runs", async () => {
    const c = client();
    const pending = c.connect();
    await tick();
    expect(c.state).toBe("connecting");
    created[0].resolveConnect?.();
    await pending;
  });
});

describe("the microphone", () => {
  it("is opened once when Pipecat asks twice, and stopped on disconnect", async () => {
    const tracks: { readyState: string; enabled: boolean; stop(): void }[] = [];
    const getUserMedia = vi.fn(async () => {
      const track = { readyState: "live", enabled: true, stop() { this.readyState = "ended"; } };
      tracks.push(track);
      return { getAudioTracks: () => [track] };
    });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const mic = new NativeMicManager(true);
    await mic.initialize();
    await mic.initialize();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await mic.disconnect();
    expect(tracks[0].readyState).toBe("ended");
  });

  it("is let go when the call is hung up while the permission prompt is open", async () => {
    const released = vi.spyOn(NativeMicManager.prototype, "disconnect");
    let allow!: () => void;
    micPrompt = new Promise<void>((r) => (allow = r));
    const c = client();
    const pending = c.connect();
    await tick();
    await c.disconnect();
    allow();
    await pending;
    expect(released).toHaveBeenCalled();
    expect(c.state).toBe("disconnected");
  });
});
