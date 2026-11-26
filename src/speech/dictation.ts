import { Emitter } from "./emitter.js";
import { DICTATION_RATE, Resampler, floatToInt16, toMonoFloat } from "./pcm.js";
import { wavFromPcm } from "./stt.js";
import { SpeechHttpError } from "./tts.js";

/** What the service accepts per request; a dictation never goes past either. */
export const MAX_DICTATION_SECONDS = 30;
export const MAX_DICTATION_BYTES = 2_000_000;

export type DictationErrorCode =
  | "too_long"
  | "no_audio"
  | "timeout"
  | "network"
  | "headers"
  | "invalid_response"
  | "cancelled"
  | (string & {});

export class DictationError extends SpeechHttpError {
  /**
   * `status` is the HTTP status, or 0 when no answer came. `code` is the service's `error` value
   * (`busy`, `turn_conflict`, ...) or one of the client codes. The response body stays out of the
   * message so logs never carry what the user said.
   */
  constructor(
    status: number,
    public readonly code: DictationErrorCode,
    message: string,
    public readonly attempts = 0,
    public readonly retryAfterMs?: number,
  ) {
    super(status, message);
    this.name = "DictationError";
  }
}

/** The request about to be sent; passed to `headers` on every attempt. */
export interface DictationRequestInfo {
  /** 1 for the first try, 2 for the first retry. Do not count turns inside `headers`: it runs per attempt. */
  attempt: number;
  durationMs: number;
  bytes: number;
}

export interface DictationTransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
}

export interface DictationTransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** Sends one request. A `fetch` Response fits; swap it for multipart or another stack later. */
export type DictationTransport = (req: DictationTransportRequest) => Promise<DictationTransportResponse>;

export interface DictationTranscript {
  callId?: string;
  turnId?: number;
  text: string;
  language?: string;
  audioDurationMs?: number;
  /** The parsed response body, as sent. */
  raw: Record<string, unknown>;
}

export interface DictationRetry {
  /** Retries after 429, waiting `Retry-After` (default 3). */
  rateLimit?: number;
  /** Retries after 503 or 504 (default 3). */
  unavailable?: number;
  /** Retries after 500 (default 1). */
  internal?: number;
  /** First backoff step (ms, default 500); doubles per retry, with jitter, capped at 8 000. */
  backoffMs?: number;
  /** A `Retry-After` longer than this (ms, default 30 000) ends the dictation instead of waiting. */
  maxRetryAfterMs?: number;
}

export interface DictationOptions {
  /** Where the WAV is posted, `https://` (plain http only for localhost). */
  url: string;
  /** Extra request headers (callId, turnId, language, auth), called before every attempt. */
  headers?: (info: DictationRequestInfo) => Record<string, string> | Promise<Record<string, string>>;
  /** Default: global `fetch`. */
  transport?: DictationTransport;
  /** Longest dictation (s, default 20, at most 30). */
  maxSeconds?: number;
  /**
   * What happens to audio past `maxSeconds`. `"stop"` (default): `push` keeps the first
   * `maxSeconds`, ignores the rest, emits `limit` and returns false. `"reject"`: that `push`
   * throws a `too_long` DictationError and `finish()` rejects with it; nothing is sent.
   */
  onLimit?: "stop" | "reject";
  /** Abort one attempt after this long (ms, default 15 000). */
  timeoutMs?: number;
  retry?: DictationRetry;
  /** Test hook, default `Math.random`. */
  random?: () => number;
}

export interface DictationEvents {
  /** The cap was reached; further audio is ignored (stop mode). */
  limit: { seconds: number };
  /** One attempt ended: status is 0 when no answer came. No audio or text. */
  attempt: { attempt: number; status: number; ms: number };
  transcript: { transcript: DictationTranscript };
  error: { error: DictationError };
}

type Chunk = Int16Array;

function secureUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError("dictation url is not a valid URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new TypeError("dictation url must be https");
  return u.toString();
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function concat(chunks: Chunk[], length: number): Int16Array {
  const out = new Int16Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * One dictation: the app pushes PCM frames from its own recorder; `finish()` sends the audio as a
 * single 16 kHz mono 16-bit WAV request and resolves with the transcript JSON. Holds no Freya
 * token and does no capture, so it runs in React Native, browsers and Node.
 */
export class Dictation extends Emitter<DictationEvents> {
  private readonly url: string;
  private readonly maxSamples: number;
  private readonly maxSeconds: number;
  private readonly onLimit: "stop" | "reject";
  private readonly timeoutMs: number;
  private readonly retry: Required<DictationRetry>;
  private readonly random: () => number;
  private readonly transport: DictationTransport;
  private readonly controller = new AbortController();
  private resampler?: Resampler;
  private chunks: Chunk[] = [];
  private samples = 0;
  private capped = false;
  private failure?: DictationError;
  private result?: Promise<DictationTranscript>;

  constructor(private readonly options: DictationOptions) {
    super();
    this.url = secureUrl(options.url);
    this.maxSeconds = options.maxSeconds ?? 20;
    if (!(this.maxSeconds > 0) || this.maxSeconds > MAX_DICTATION_SECONDS) {
      throw new RangeError(`maxSeconds must be above 0 and at most ${MAX_DICTATION_SECONDS}`);
    }
    this.maxSamples = Math.floor(this.maxSeconds * DICTATION_RATE);
    if (44 + this.maxSamples * 2 > MAX_DICTATION_BYTES) throw new RangeError("maxSeconds would pass the 2 MB request limit");
    this.onLimit = options.onLimit ?? "stop";
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.random = options.random ?? Math.random;
    this.retry = {
      rateLimit: 3,
      unavailable: 3,
      internal: 1,
      backoffMs: 500,
      maxRetryAfterMs: 30000,
      ...options.retry,
    };
    const f = globalThis.fetch as typeof fetch | undefined;
    const transport =
      options.transport ??
      (f
        ? (req: DictationTransportRequest) => f(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit, signal: req.signal })
        : undefined);
    if (!transport) throw new Error("No fetch available: pass options.transport");
    this.transport = transport;
  }

  /** Seconds of 16 kHz audio held so far. */
  get seconds(): number {
    return this.samples / DICTATION_RATE;
  }

  /**
   * Adds interleaved PCM frames at any sample rate. Returns false once the cap is reached (stop
   * mode); the caller can stop its recorder then. Throws after `finish()` or `cancel()`.
   */
  push(samples: Int16Array | Float32Array, sampleRate: number, channels = 1): boolean {
    if (this.result || this.controller.signal.aborted) throw new Error("Dictation is finished");
    if (this.failure) throw this.failure;
    if (this.capped) return false;
    if (!this.resampler) this.resampler = new Resampler(sampleRate);
    else if (this.resampler.inRate !== sampleRate) throw new RangeError("sampleRate must not change within a dictation");
    this.take(floatToInt16(this.resampler.process(toMonoFloat(samples, channels))));
    if (this.failure) throw this.failure;
    return !this.capped;
  }

  /** Sends the audio and resolves with the transcript; rejects with a DictationError. */
  finish(): Promise<DictationTranscript> {
    this.result ??= this.send();
    return this.result;
  }

  /** Aborts the request in flight and drops the audio. `finish()` then rejects with `cancelled`. */
  cancel(): void {
    this.controller.abort();
    this.chunks = [];
    this.samples = 0;
  }

  private take(pcm: Int16Array): void {
    const room = this.maxSamples - this.samples;
    if (pcm.length <= room) {
      if (pcm.length) this.chunks.push(pcm);
      this.samples += pcm.length;
      return;
    }
    this.capped = true;
    if (this.onLimit === "reject") {
      this.failure = new DictationError(0, "too_long", `Dictation is longer than ${this.maxSeconds} s`);
      this.emit("error", { error: this.failure });
      return;
    }
    if (room > 0) this.chunks.push(pcm.subarray(0, room));
    this.samples = this.maxSamples;
    this.emit("limit", { seconds: this.maxSeconds });
  }

  private async send(): Promise<DictationTranscript> {
    const fail = (e: DictationError): never => {
      if (e !== this.failure) this.emit("error", { error: e });
      throw e;
    };
    if (this.failure) throw this.failure;
    if (this.controller.signal.aborted) return fail(new DictationError(0, "cancelled", "Dictation was cancelled"));
    if (this.resampler) this.take(floatToInt16(this.resampler.flush()));
    if (this.failure) throw this.failure;
    if (this.samples === 0) return fail(new DictationError(0, "no_audio", "Dictation holds no audio"));
    const wav = wavFromPcm({ samples: concat(this.chunks, this.samples), sampleRate: DICTATION_RATE });
    this.chunks = [];
    if (wav.length > MAX_DICTATION_BYTES) return fail(new DictationError(0, "too_long", "Dictation is larger than 2 MB"));
    try {
      return await this.post(wav);
    } catch (e) {
      return fail(e as DictationError);
    }
  }

  private async post(wav: Uint8Array): Promise<DictationTranscript> {
    const durationMs = Math.round(((wav.length - 44) / 2 / DICTATION_RATE) * 1000);
    const used = { rateLimit: 0, unavailable: 0, internal: 0 };
    for (let attempt = 1; ; attempt++) {
      let extra: Record<string, string>;
      try {
        extra = (await this.options.headers?.({ attempt, durationMs, bytes: wav.length })) ?? {};
      } catch {
        throw new DictationError(0, "headers", "The headers function failed", attempt);
      }
      const started = Date.now();
      let status = 0;
      let res: { status: number; retryAfter?: string | null; body: string } | undefined;
      let failure: DictationError | undefined;
      try {
        res = await this.once(wav, { ...extra, "Content-Type": "audio/wav" });
        status = res.status;
      } catch (e) {
        failure = e as DictationError;
      }
      this.emit("attempt", { attempt, status, ms: Date.now() - started });
      if (failure) throw new DictationError(0, failure.code, failure.message, attempt);
      if (!res) throw new DictationError(0, "network", "No response", attempt);
      if (status >= 200 && status < 300) return this.parse(res.body, status, attempt);

      const code = errorCode(res.body);
      const rule =
        status === 429 ? "rateLimit" : status === 503 || status === 504 ? "unavailable" : status === 500 ? "internal" : undefined;
      const retryAfterMs = status === 429 ? parseRetryAfter(res.retryAfter ?? null) : undefined;
      const message = `Dictation request failed ${status} ${code}`;
      if (!rule || used[rule] >= this.retry[rule]) throw new DictationError(status, code, message, attempt, retryAfterMs);
      if (retryAfterMs !== undefined && retryAfterMs > this.retry.maxRetryAfterMs) {
        throw new DictationError(status, code, message, attempt, retryAfterMs);
      }
      const wait = retryAfterMs ?? this.backoff(used[rule]);
      used[rule]++;
      await this.sleep(wait);
    }
  }

  private backoff(n: number): number {
    return Math.min(this.retry.backoffMs * 2 ** n, 8000) * (0.5 + 0.5 * this.random());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DictationError(0, "cancelled", "Dictation was cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async once(
    wav: Uint8Array,
    headers: Record<string, string>,
  ): Promise<{ status: number; retryAfter: string | null; body: string }> {
    const attemptAbort = new AbortController();
    const outer = this.controller.signal;
    if (outer.aborted) throw new DictationError(0, "cancelled", "Dictation was cancelled");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onOuter = () => undefined as void;
    const limit = new Promise<never>((_, reject) => {
      onOuter = () => {
        attemptAbort.abort();
        reject(new DictationError(0, "cancelled", "Dictation was cancelled"));
      };
      outer.addEventListener("abort", onOuter, { once: true });
      if (this.timeoutMs <= 0) return;
      timer = setTimeout(() => {
        attemptAbort.abort();
        reject(new DictationError(0, "timeout", `Dictation request timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
    });
    limit.catch(() => undefined);
    const run = (async () => {
      const res = await this.transport({ url: this.url, method: "POST", headers, body: wav, signal: attemptAbort.signal });
      const body = await res.text().catch(() => "");
      return { status: res.status, retryAfter: res.headers.get("Retry-After"), body };
    })();
    run.catch(() => undefined);
    try {
      return await Promise.race([run, limit]);
    } catch (e) {
      if (e instanceof DictationError) throw e;
      if (outer.aborted) throw new DictationError(0, "cancelled", "Dictation was cancelled");
      throw new DictationError(0, "network", "Dictation request failed before an answer");
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", onOuter);
    }
  }

  private parse(body: string, status: number, attempt: number): DictationTranscript {
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new DictationError(status, "invalid_response", "The answer is not JSON", attempt);
    }
    if (typeof raw !== "object" || raw === null || typeof (raw as { text?: unknown }).text !== "string") {
      throw new DictationError(status, "invalid_response", "The answer has no text field", attempt);
    }
    const r = raw as Record<string, unknown>;
    const transcript: DictationTranscript = {
      callId: typeof r.callId === "string" ? r.callId : undefined,
      turnId: typeof r.turnId === "number" ? r.turnId : undefined,
      text: r.text as string,
      language: typeof r.language === "string" ? r.language : undefined,
      audioDurationMs: typeof r.audioDurationMs === "number" ? r.audioDurationMs : undefined,
      raw: r,
    };
    this.emit("transcript", { transcript });
    return transcript;
  }
}

function errorCode(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof code === "string" && /^[a-z_]{1,40}$/.test(code)) return code;
  } catch {
    /* not JSON */
  }
  return "http_error";
}
