import { secureBase, type TokenKeeper } from "./auth.js";
import { Emitter } from "./emitter.js";
import { errorFrom, type Pcm } from "./tts.js";

export const DEFAULT_STT_URL = "https://stt.freyavoice.ai";

export interface SttOptions {
  /** Speech service root, without /v1. Point it at your own backend to proxy Freya. */
  url?: string;
  model?: string;
  language?: string;
}

/** A React Native file reference, which RN's FormData accepts in place of a Blob. */
export interface FileRef {
  uri: string;
  name: string;
  type: string;
}

export type AudioInput = Blob | ArrayBuffer | Uint8Array | Pcm | FileRef;

export interface Transcript {
  text: string;
  language?: string;
  duration?: number;
  /** The service's full verbose_json answer. */
  raw: Record<string, unknown>;
}

export interface SttStreamEvents {
  open: Record<string, never>;
  partial: { text: string; final: boolean };
  result: { text: string };
  error: { message: string };
  close: Record<string, never>;
}

/** The part of WebSocket the stream uses; RN, browsers and Node 22 all provide it. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

const defaultWebSocket: WebSocketFactory = (url, headers) => {
  const WS = (globalThis as { WebSocket?: new (...args: unknown[]) => WebSocketLike }).WebSocket;
  if (!WS) throw new Error("No WebSocket available: pass createWebSocket");
  // RN takes headers as the third argument; browsers cannot send headers, so proxy there
  return new WS(url, undefined, { headers });
};

export function wavFromPcm(pcm: Pcm): Uint8Array {
  const data = new Uint8Array(pcm.samples.buffer, pcm.samples.byteOffset, pcm.samples.byteLength);
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + data.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

function isPcm(a: AudioInput): a is Pcm {
  return typeof a === "object" && a !== null && "samples" in a && "sampleRate" in a;
}

// React Native cannot build a Blob from bytes; there the recording goes in as a file.
function blobOf(bytes: Uint8Array): Blob {
  try {
    return new Blob([bytes as BlobPart], { type: "audio/wav" });
  } catch {
    throw new Error("This platform cannot send audio bytes (React Native): save the recording as a file and pass { uri, name, type }");
  }
}

function isFileRef(a: AudioInput): a is FileRef {
  return typeof a === "object" && a !== null && "uri" in a;
}

export class FreyaStt {
  readonly url: string;
  readonly model: string;
  readonly language: string;

  constructor(private readonly keeper: TokenKeeper, options: SttOptions = {}) {
    this.url = secureBase(options.url ?? DEFAULT_STT_URL, "stt.url").replace(/\/v1$/, "");
    this.model = options.model ?? "freya-stt";
    this.language = options.language ?? "tr";
  }

  /** One recording in, its text out (a single REST request). */
  async transcribe(audio: AudioInput, options: { language?: string; signal?: AbortSignal } = {}): Promise<Transcript> {
    const form = new FormData();
    if (isFileRef(audio)) {
      form.append("file", audio as unknown as Blob);
    } else {
      const bytes = isPcm(audio) ? wavFromPcm(audio) : audio instanceof ArrayBuffer ? new Uint8Array(audio) : audio;
      form.append("file", bytes instanceof Blob ? bytes : blobOf(bytes as Uint8Array), "audio.wav");
    }
    form.append("model", this.model);
    form.append("language", options.language ?? this.language);
    form.append("response_format", "verbose_json");
    const res = await this.keeper.fetch(`${this.url}/v1/audio/transcriptions`, { method: "POST", body: form, signal: options.signal });
    if (!res.ok) throw await errorFrom(res, "STT");
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      text: String(raw.text ?? "").trim(),
      language: typeof raw.language === "string" ? raw.language : undefined,
      duration: typeof raw.duration === "number" ? raw.duration : undefined,
      raw,
    };
  }

  /** Live transcription over a WebSocket: send 16 kHz PCM frames, get partials, then the result. */
  async stream(options: { language?: string; sampleRate?: number; createWebSocket?: WebSocketFactory } = {}): Promise<SttStream> {
    const token = await this.keeper.token();
    const url = this.url.replace(/^http/, "ws") + "/v1/audio/stream";
    const ws = (options.createWebSocket ?? defaultWebSocket)(url, { Authorization: `Bearer ${token}` });
    return new SttStream(ws, { type: "config", language: options.language ?? this.language, sample_rate: options.sampleRate ?? 16000 });
  }
}

export class SttStream extends Emitter<SttStreamEvents> {
  private queue: (ArrayBuffer | string)[] = [];
  private open = false;
  private done = false;
  private closed = false;

  constructor(private readonly ws: WebSocketLike, config: Record<string, unknown>) {
    super();
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      this.open = true;
      ws.send(JSON.stringify(config));
      for (const item of this.queue) ws.send(item);
      this.queue = [];
      this.emit("open", {});
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: { type?: unknown; text?: unknown; message?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const text = typeof msg.text === "string" ? msg.text : "";
      if ((msg.type === "partial" || msg.type === "final") && text) {
        this.emit("partial", { text, final: msg.type === "final" });
      } else if (msg.type === "result") {
        this.done = true;
        this.emit("result", { text: text.trim() });
        ws.close();
      } else if (msg.type === "error") {
        this.emit("error", { message: typeof msg.message === "string" ? msg.message : "STT error" });
      }
    };
    ws.onerror = () => this.emit("error", { message: "STT connection failed" });
    ws.onclose = () => {
      this.open = false;
      this.closed = true;
      if (!this.done) this.emit("error", { message: "STT connection closed before the result" });
      this.emit("close", {});
    };
  }

  /** One frame of 16-bit mono PCM at the configured rate. */
  send(frame: Int16Array | ArrayBuffer): void {
    const buf = frame instanceof ArrayBuffer ? frame : (frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
    if (this.open) this.ws.send(buf);
    else if (!this.closed) this.queue.push(buf);
  }

  /** The speaker is done: the service sends the final result, then the socket closes. */
  finish(): void {
    const msg = JSON.stringify({ type: "close" });
    if (this.open) this.ws.send(msg);
    else if (!this.closed) this.queue.push(msg);
  }

  cancel(): void {
    this.done = true;
    this.ws.close();
  }
}
