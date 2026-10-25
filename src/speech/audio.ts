import type { Pcm } from "./tts.js";

/** Where the reader's sentences are played. The SDK ships a Web Audio one; anything else can be plugged in. */
export interface AudioOutput {
  /** Plays one clip. `onStart` fires when sound starts; resolves once it ended or was stopped. */
  play(pcm: Pcm, onStart: () => void): Promise<"ended" | "stopped">;
  /** Stops the clip now playing (barge-in). */
  stop(): void;
}

/** The part of AudioBufferSourceNode the output uses. */
export interface BufferSourceLike {
  buffer: unknown;
  connect(dest: unknown): void;
  start(): void;
  stop(): void;
  onended: (() => void) | null;
}

/** The part of AudioContext the output uses; react-native-audio-api provides it too. */
export interface AudioContextLike {
  state?: string;
  destination: unknown;
  resume?(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(ch: number): Float32Array };
  createBufferSource(): BufferSourceLike;
  close?(): Promise<void>;
}

export interface WebAudioOutputOptions {
  /** An AudioContext to use. On React Native pass one from react-native-audio-api, which mirrors Web Audio. */
  context?: AudioContextLike;
  /** Or the constructor, created on first play (browsers allow audio only after a user gesture). */
  AudioContext?: new () => AudioContextLike;
}

export class WebAudioOutput implements AudioOutput {
  private ctx: AudioContextLike | null;
  private current: { src: BufferSourceLike; finish: (r: "ended" | "stopped") => void } | null = null;

  constructor(private readonly options: WebAudioOutputOptions = {}) {
    this.ctx = options.context ?? null;
  }

  /** Create or resume the context; call it from a tap so the first sentence is not blocked. */
  async unlock(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === "suspended" && ctx.resume) await ctx.resume();
  }

  private context(): AudioContextLike {
    if (!this.ctx) {
      const Ctor =
        this.options.AudioContext ??
        ((globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext as (new () => AudioContextLike) | undefined);
      if (!Ctor) throw new Error("No AudioContext: pass options.context or options.AudioContext");
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  play(pcm: Pcm, onStart: () => void): Promise<"ended" | "stopped"> {
    this.stop();
    const ctx = this.context();
    const length = pcm.samples.length;
    const buffer = ctx.createBuffer(1, Math.max(length, 1), pcm.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = pcm.samples[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    return new Promise((resolve) => {
      const finish = (result: "ended" | "stopped") => {
        if (this.current?.src !== src) return;
        this.current = null;
        clearTimeout(timer);
        resolve(result);
      };
      // backstop for runtimes whose onended never fires
      const timer = setTimeout(() => finish("ended"), (length / pcm.sampleRate) * 1000 + 500);
      this.current = { src, finish };
      src.onended = () => finish("ended");
      src.start();
      onStart();
    });
  }

  /** Stops playback and closes the context this output created (one passed in is left to its owner). */
  async close(): Promise<void> {
    this.stop();
    const ctx = this.ctx;
    if (!ctx || this.options.context) return;
    this.ctx = null;
    await ctx.close?.();
  }

  stop(): void {
    const cur = this.current;
    if (!cur) return;
    cur.src.onended = null;
    try {
      cur.src.stop();
    } catch {
      // already stopped
    }
    cur.finish("stopped");
  }
}
