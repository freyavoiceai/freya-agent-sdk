import type { TokenKeeper } from "./auth.js";

export interface TtsOptions {
  /** Speech service root, without /v1. Point it at your own backend to proxy Freya. */
  url?: string;
  model?: string;
  voice?: string;
  /** The PCM rate the service returns for `response_format: "pcm"`. */
  sampleRate?: number;
}

/** 16-bit mono PCM, the form every audio output in this package plays. */
export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

export const DEFAULT_TTS_URL = "https://tts.freyavoice.ai";

export class SpeechHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SpeechHttpError";
  }
}

export async function errorFrom(res: Response, what: string): Promise<SpeechHttpError> {
  const body = await res.text().catch(() => "");
  return new SpeechHttpError(res.status, `${what} ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
}

export function pcmFromBytes(bytes: ArrayBuffer, sampleRate: number): Pcm {
  // an odd trailing byte would make Int16Array throw
  const even = bytes.byteLength - (bytes.byteLength % 2);
  return { samples: new Int16Array(bytes.slice(0, even)), sampleRate };
}

export class FreyaTts {
  readonly url: string;
  readonly model: string;
  readonly voice: string;
  readonly sampleRate: number;

  constructor(private readonly keeper: TokenKeeper, options: TtsOptions = {}) {
    this.url = (options.url ?? DEFAULT_TTS_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
    this.model = options.model ?? "freya-tts";
    this.voice = options.voice ?? "zeynep";
    this.sampleRate = options.sampleRate ?? 48000;
  }

  /** One text to speech request; returns the whole sentence as PCM. */
  async synthesize(text: string, options: { voice?: string; signal?: AbortSignal } = {}): Promise<Pcm> {
    const res = await this.keeper.fetch(`${this.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, model: this.model, voice: options.voice ?? this.voice, response_format: "pcm" }),
      signal: options.signal,
    });
    if (!res.ok) throw await errorFrom(res, "TTS");
    return pcmFromBytes(await res.arrayBuffer(), this.sampleRate);
  }
}
