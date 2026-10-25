import type { AudioOutput } from "./audio.js";
import { TokenKeeper, type FetchLike, type TokenSource } from "./auth.js";
import { Emitter } from "./emitter.js";
import { SpeechReader, type ReaderOptions } from "./reader.js";
import { FreyaStt, type SttOptions } from "./stt.js";
import { FreyaTts, type TtsOptions } from "./tts.js";

export interface FreyaSpeechConfig {
  /** A bearer token, or a function that returns one; called again with `refresh: true` after a 401 or 403. */
  token: TokenSource;
  stt?: SttOptions;
  tts?: TtsOptions;
  /** Inject a fetch; on React Native, expo/fetch. */
  fetch?: FetchLike;
  /** Statuses that renew the token and repeat the request once; default 401 and 403. */
  renewOn?: number[];
  /** Renew a JWT this long before its `exp` (ms, default 60 000). 0 turns it off. */
  renewBeforeMs?: number;
  /** Abort a request after this long (ms, default 30 000). 0 turns it off. */
  timeoutMs?: number;
}

export interface FreyaSpeechEvents {
  /** A new token is being fetched: a 401 or 403 came back, or a JWT is about to expire. */
  tokenRefresh: Record<string, never>;
}

/**
 * Freya speech without an agent: speech-to-text and text-to-speech as separate requests, plus a
 * reader that voices an answer arriving in chunks. Platform-free; it runs in browsers, React
 * Native and Node, given a fetch and (for playback) an AudioOutput.
 */
export class FreyaSpeech extends Emitter<FreyaSpeechEvents> {
  readonly stt: FreyaStt;
  readonly tts: FreyaTts;

  constructor(config: FreyaSpeechConfig) {
    super();
    const keeper = new TokenKeeper({
      token: config.token,
      fetch: config.fetch,
      renewOn: config.renewOn,
      renewBeforeMs: config.renewBeforeMs,
      timeoutMs: config.timeoutMs,
    });
    keeper.onRefresh = () => this.emit("tokenRefresh", {});
    this.stt = new FreyaStt(keeper, config.stt);
    this.tts = new FreyaTts(keeper, config.tts);
  }

  /** A reader for one answer; make a new one per answer, `stop()` it on barge-in. */
  reader(output: AudioOutput, options?: ReaderOptions): SpeechReader {
    return new SpeechReader(this.tts, output, options);
  }
}

export { SpeechAuthError, TokenKeeper, type AuthOptions, type FetchLike, type TokenSource } from "./auth.js";
export { WebAudioOutput, type AudioContextLike, type AudioOutput, type BufferSourceLike, type WebAudioOutputOptions } from "./audio.js";
export { SpeechReader, type Chunk, type ReaderEvents, type ReaderOptions, type ReaderSummary } from "./reader.js";
export {
  FreyaStt,
  SttStream,
  wavFromPcm,
  type AudioInput,
  type FileRef,
  type SttOptions,
  type SttStreamEvents,
  type SttStreamOptions,
  type Transcript,
  type WebSocketFactory,
  type WebSocketLike,
} from "./stt.js";
export { SentenceAssembler, cleanText, firstCut } from "./text.js";
export { FreyaTts, SpeechHttpError, type Pcm, type TtsOptions } from "./tts.js";
export { VoiceActivity, type VoiceActivityEvents, type VoiceActivityOptions } from "./vad.js";
export { wordTimings, type WordTiming } from "./words.js";
