import type { AudioOutput } from "./audio.js";
import { secureBase, TokenKeeper, type FetchLike, type TokenSource } from "./auth.js";
import { wavFromPcm } from "./stt.js";
import { errorFrom, type Pcm } from "./tts.js";
import { storeZip, type ZipEntry } from "./zip.js";

/** The dashboard's import endpoint refuses a bigger upload. */
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;

export interface RecorderOptions {
  /**
   * Where the finished conversation goes: your backend, which checks the session, adds a Freya key
   * with `calls:import` and forwards it to the dashboard's `/api/v2/call/import`. Never the
   * dashboard itself from an app: that key can write more than calls.
   */
  url: string;
  /** Your session token, or a function that returns one; renewed once after a 401 or 403. */
  token: TokenSource;
  fetch?: FetchLike;
  renewOn?: number[];
  /** Abort the upload after this long (ms, default 120 000). */
  timeoutMs?: number;
  /**
   * `"form"` (default) posts multipart with the archive in `file`, as the import endpoint takes it.
   * `"zip"` posts the archive itself as `application/zip`, for React Native, which cannot put
   * bytes in a form; your backend then builds the form.
   */
  format?: "form" | "zip";
  /** Rate of the recorded file (default 16 000); every clip is converted to it. */
  sampleRate?: number;
  /** Also store the customer's and the assistant's audio as separate tracks next to the merged file. */
  tracks?: boolean;
  /** The customer number the call is filed under in the dashboard, so it can be searched. */
  customerNumber?: string;
  /** Your own id for the conversation; the dashboard skips a second import with the same one. */
  externalCallId?: string;
  /** Extra fields stored on the call, e.g. the app version. Never put secrets here. */
  metadata?: Record<string, unknown>;
  /** Clock in ms; for tests. */
  now?: () => number;
}

/** What the import endpoint answered. */
export interface ImportResult {
  created: number;
  skipped: number;
  failed: number;
  errors: { index: number; id: string | null; error: string }[];
}

/**
 * The import did not leave a complete call. `rejected`: no call was created. `audio-lost`: the call
 * exists but without its audio; sending again does not add it. `too-large`: over 50 MB, not sent.
 */
export class RecordingError extends Error {
  constructor(
    public readonly reason: "rejected" | "audio-lost" | "too-large",
    message: string,
    public readonly result?: ImportResult,
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

interface Clip {
  pcm: Pcm;
  /** When its first sample was heard (ms). */
  at: number;
}

interface Turn {
  role: "user" | "bot";
  text: string;
  time: number;
  endTime: number;
  extra: Record<string, unknown>;
}

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 16-bit PCM from a WAV file; more than one channel is mixed down. */
export function pcmFromWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Audio must be PCM samples or a WAV file");
  let channels = 0;
  let sampleRate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      const format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      const bits = v.getUint16(body + 14, true);
      if ((format !== 1 && format !== 0xfffe) || bits !== 16 || channels < 1) throw new Error("Only 16-bit PCM WAV can be recorded");
    } else if (id === "data") {
      if (!channels) break;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) sum += v.getInt16(body + (i * channels + ch) * 2, true);
        samples[i] = Math.round(sum / channels);
      }
      return { samples, sampleRate };
    }
    at = body + size + (size % 2);
  }
  throw new Error("The WAV file has no PCM data");
}

function toPcm(audio: Pcm | Uint8Array | ArrayBuffer): Pcm {
  if (audio instanceof ArrayBuffer) return pcmFromWav(new Uint8Array(audio));
  if (audio instanceof Uint8Array) return pcmFromWav(audio);
  return audio;
}

/** Linear resampling; good enough for a speech recording someone listens to later. */
function resample(pcm: Pcm, rate: number): Int16Array {
  if (pcm.sampleRate === rate) return pcm.samples;
  const ratio = pcm.sampleRate / rate;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(n);
  const last = pcm.samples.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const a = pcm.samples[j];
    const b = pcm.samples[Math.min(j + 1, last)];
    out[i] = Math.round(a + (b - a) * (pos - j));
  }
  return out;
}

/** Lays clips on one timeline from `start`; where two overlap they are added. */
function mix(clips: Clip[], start: number, rate: number): Int16Array {
  const placed = clips.map((c) => ({ s: resample(c.pcm, rate), off: Math.max(0, Math.round(((c.at - start) / 1000) * rate)) }));
  const out = new Int16Array(placed.reduce((n, p) => Math.max(n, p.off + p.s.length), 0));
  for (const { s, off } of placed) {
    for (let i = 0; i < s.length; i++) out[off + i] = Math.max(-32768, Math.min(32767, out[off + i] + s[i]));
  }
  return out;
}

const norm = (s: string) => s.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Keeps one conversation (what the customer said and sent, what was read back, and both voices)
 * and sends it to the dashboard as a call when it ends: one import request, with the transcript
 * and a merged recording the dashboard can play.
 *
 * ```js
 * const rec = new ConversationRecorder({ url: `${backend}/api/v2/call/import`, token });
 * const reader = speech.reader(rec.output(output));     // the voice that is played is recorded
 * const { text } = await speech.stt.transcribe(pcm);
 * rec.user(pcm, text);          // the customer's voice and what STT heard
 * rec.sent(finalText);          // what the customer sent, maybe corrected
 * rec.bot(answer);              // the answer that is read aloud
 * rec.end();
 * await rec.send();
 * ```
 */
export class ConversationRecorder {
  readonly callId = uuid();
  readonly startedAt: number;
  private endedAt: number | null = null;
  private endedReason = "session-ended";
  private readonly turns: Turn[] = [];
  private heard: { text: string; time: number; endTime: number } | null = null;
  private readonly userClips: Clip[] = [];
  private readonly botClips: Clip[] = [];
  private built: Uint8Array | null = null;
  private result: ImportResult | null = null;
  private lost: RecordingError | null = null;
  private readonly keeper: TokenKeeper;
  private readonly url: string;
  private readonly rate: number;
  private readonly now: () => number;

  constructor(private readonly options: RecorderOptions) {
    this.url = secureBase(options.url, "url");
    this.rate = options.sampleRate ?? 16_000;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.keeper = new TokenKeeper({
      token: options.token,
      fetch: options.fetch,
      renewOn: options.renewOn,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
  }

  private open(): void {
    if (this.endedAt !== null) throw new Error("The conversation has ended; start a new recorder");
  }

  /** The customer's voice (PCM, or a 16-bit WAV file's bytes) and what STT heard in it. */
  user(audio: Pcm | Uint8Array | ArrayBuffer, heard: string, options: { at?: number } = {}): void {
    this.open();
    const pcm = toPcm(audio);
    const duration = (pcm.samples.length / pcm.sampleRate) * 1000;
    const at = options.at ?? this.now() - duration;
    this.userClips.push({ pcm, at });
    const text = heard.trim();
    if (this.heard) {
      // dictated again before sending: one message, two clips
      this.heard = { text: `${this.heard.text} ${text}`.trim(), time: this.heard.time, endTime: at + duration };
    } else {
      this.heard = { text, time: at, endTime: at + duration };
    }
  }

  /** What the customer sent. After `user()` it records whether the text was corrected; without it, that it was typed. */
  sent(text: string): void {
    this.open();
    const now = this.now();
    const h = this.heard;
    this.heard = null;
    this.turns.push(
      h
        ? { role: "user", text, time: h.time, endTime: h.endTime, extra: { heard: h.text, edited: norm(h.text) !== norm(text) } }
        : { role: "user", text, time: now, endTime: now, extra: { typed: true } },
    );
  }

  /** The answer the customer gets (C-Bot's text, as read aloud). */
  bot(text: string, options: { at?: number } = {}): void {
    this.open();
    const at = options.at ?? this.now();
    this.turns.push({ role: "bot", text, time: at, endTime: at, extra: {} });
  }

  /** The assistant's voice, when it is not played through `output()`. */
  botAudio(pcm: Pcm, options: { at?: number } = {}): void {
    this.open();
    this.botClips.push({ pcm, at: options.at ?? this.now() });
  }

  /** Wraps an output so every clip it plays is recorded; a clip stopped by barge-in is kept up to where it stopped. */
  output(inner: AudioOutput): AudioOutput {
    return {
      play: async (pcm, onStart) => {
        let at = 0;
        const result = await inner.play(pcm, () => {
          at = this.now();
          onStart();
        });
        if (at && this.endedAt === null) {
          const heard = result === "stopped" ? Math.round(((this.now() - at) / 1000) * pcm.sampleRate) : pcm.samples.length;
          const samples = pcm.samples.subarray(0, Math.max(0, Math.min(heard, pcm.samples.length)));
          if (samples.length) this.botClips.push({ pcm: { samples, sampleRate: pcm.sampleRate }, at });
        }
        return result;
      },
      stop: () => inner.stop(),
    };
  }

  /** Closes the conversation. Dictated text that was never sent is kept, marked `sent: false`. */
  end(reason = "session-ended"): void {
    if (this.endedAt !== null) return;
    const h = this.heard;
    this.heard = null;
    if (h) this.turns.push({ role: "user", text: h.text, time: h.time, endTime: h.endTime, extra: { heard: h.text, sent: false } });
    this.endedReason = reason;
    this.endedAt = this.now();
  }

  /** The archive the import endpoint takes: `calls.json` and `recordings/<callId>.wav`. Ends the conversation first. */
  archive(): Uint8Array {
    this.end();
    if (this.built) return this.built;
    const start = this.startedAt;
    const turns = [...this.turns].sort((a, b) => a.time - b.time);
    const clips = [...this.userClips, ...this.botClips];
    const entries: ZipEntry[] = [];
    const tracks: { track: "single" | "user" | "assistant"; ext: "wav" }[] = [];
    const wav = (samples: Int16Array) => wavFromPcm({ samples, sampleRate: this.rate });
    if (clips.length) {
      entries.push({ name: `recordings/${this.callId}.wav`, data: wav(mix(clips, start, this.rate)) });
      tracks.push({ track: "single", ext: "wav" });
      if (this.options.tracks) {
        entries.push({ name: `recordings/${this.callId}_user.wav`, data: wav(mix(this.userClips, start, this.rate)) });
        entries.push({ name: `recordings/${this.callId}_assistant.wav`, data: wav(mix(this.botClips, start, this.rate)) });
        tracks.push({ track: "user", ext: "wav" }, { track: "assistant", ext: "wav" });
      }
    }
    const call = {
      id: this.callId,
      externalCallId: this.options.externalCallId ?? null,
      customerNumber: this.options.customerNumber ?? null,
      type: "web",
      modality: "voice",
      status: "ended",
      endedReason: this.endedReason,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(this.endedAt ?? start).toISOString(),
      transcript: turns.map((t) => `${t.role === "bot" ? "AI" : "User"}: ${t.text}`).join("\n"),
      messages: turns.map((t) => ({
        role: t.role,
        message: t.text,
        time: t.time,
        endTime: t.endTime,
        secondsFromStart: Math.max(0, (t.time - start) / 1000),
        duration: t.endTime - t.time,
        ...t.extra,
      })),
      metadata: { ...this.options.metadata, source: "freya-agent-sdk" },
      recordingTracks: tracks,
    };
    const json = new TextEncoder().encode(JSON.stringify({ version: 1, calls: [call] }));
    this.built = storeZip([{ name: "calls.json", data: json }, ...entries]);
    return this.built;
  }

  /**
   * Sends the conversation (ending it first). Safe to call again after a failure: the same call is
   * sent, and the dashboard skips it if the first attempt got through after all.
   */
  async send(options: { signal?: AbortSignal } = {}): Promise<ImportResult> {
    if (this.result) return this.result;
    // a resend would be skipped as a duplicate and look like success
    if (this.lost) throw this.lost;
    const archive = this.archive();
    if (archive.length > MAX_RECORDING_BYTES) {
      throw new RecordingError("too-large", `The recording is ${Math.ceil(archive.length / 1048576)} MB; the limit is 50 MB`);
    }
    let init: RequestInit;
    if (this.options.format === "zip") {
      init = { method: "POST", headers: { "Content-Type": "application/zip" }, body: archive as unknown as BodyInit };
    } else {
      let blob: Blob;
      try {
        blob = new Blob([archive as BlobPart], { type: "application/zip" });
      } catch {
        throw new Error('This platform cannot put bytes in a form (React Native): use format: "zip"');
      }
      const form = new FormData();
      form.append("file", blob, `${this.callId}.zip`);
      init = { method: "POST", body: form };
    }
    const res = await this.keeper.fetch(this.url, { ...init, signal: options.signal });
    if (!res.ok) throw await errorFrom(res, "Recording");
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // the import endpoint answers the result itself; a wrapping backend may nest it
    const wrapped = (body?.data as { result?: unknown } | undefined)?.result;
    const result = (typeof body?.created === "number" ? body : wrapped) as ImportResult | undefined;
    if (!result || typeof result.created !== "number") throw new RecordingError("rejected", "The recording endpoint answered without an import result");
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (result.created + result.skipped !== 1 || result.failed > 0) {
      throw new RecordingError("rejected", errors[0]?.error ?? "The dashboard did not create the call", result);
    }
    if (result.created === 1 && errors.length) {
      this.lost = new RecordingError("audio-lost", errors[0].error, result);
      throw this.lost;
    }
    this.result = result;
    return result;
  }
}
