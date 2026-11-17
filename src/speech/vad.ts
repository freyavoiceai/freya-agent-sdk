import { Emitter } from "./emitter.js";

export interface VoiceActivityOptions {
  /** Speech this long (ms) starts "speaking". */
  startMs?: number;
  /** Silence this long (ms) ends it. */
  stopMs?: number;
  /** Level (RMS, 0..1) under which nothing counts as speech, however quiet the room. */
  minLevel?: number;
  /** Speech must be this many times the room's noise floor. */
  ratio?: number;
  /**
   * When even the quietest moment of this long (ms, default 3000) is above the noise floor, the
   * room got louder: the floor rises to it, so steady noise does not count as speech for ever.
   * Speech pauses between syllables, so it is not affected. 0 turns it off.
   */
  floorWindowMs?: number;
}

export interface VoiceActivityEvents {
  speechStart: { at: number };
  speechEnd: { at: number; duration: number };
  /** Every frame's level, for a waveform or a dictation animation. */
  level: { rms: number; speaking: boolean };
}

/**
 * "The user is speaking" from microphone frames, by energy against an adaptive noise floor.
 * It takes PCM the app already captures, so it needs no audio API of its own.
 */
export class VoiceActivity extends Emitter<VoiceActivityEvents> {
  private readonly o: Required<VoiceActivityOptions>;
  private noise = 0.01;
  private speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private startedAt = 0;
  private clock = 0;
  // the quietest frame per quarter of floorWindowMs, newest last
  private blocks: { min: number; ms: number }[] = [];

  constructor(options: VoiceActivityOptions = {}) {
    super();
    // an option given as undefined (an unset React prop) keeps its default
    this.o = {
      startMs: options.startMs ?? 120,
      stopMs: options.stopMs ?? 700,
      minLevel: options.minLevel ?? 0.015,
      ratio: options.ratio ?? 3,
      floorWindowMs: options.floorWindowMs ?? 3000,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** One frame of mono audio: Float32 in -1..1 or Int16. */
  push(frame: Float32Array | Int16Array, sampleRate: number): void {
    const scale = frame instanceof Int16Array ? 1 / 32768 : 1;
    // the quietest 20 ms inside the frame as well: a frame of 100 ms or more averages over the dips
    // between syllables, which is what tells speech from steady noise
    const block = Math.max(1, Math.round(sampleRate / 50));
    let sum = 0;
    let part = 0;
    let quietest = Infinity;
    for (let i = 0; i < frame.length; i++) {
      const v = (frame[i] * scale) ** 2;
      sum += v;
      part += v;
      if ((i + 1) % block === 0) {
        quietest = Math.min(quietest, Math.sqrt(part / block));
        part = 0;
      }
    }
    const rms = Math.sqrt(sum / Math.max(frame.length, 1));
    if (quietest === Infinity) quietest = rms;
    const ms = (frame.length / sampleRate) * 1000;
    this.clock += ms;
    const loud = rms > Math.max(this.o.minLevel, this.noise * this.o.ratio);
    // the floor follows the room while nobody speaks
    if (!loud && !this.speaking) this.noise = this.noise * 0.95 + rms * 0.05;
    this.followLouderRoom(quietest, ms);
    if (loud) {
      this.loudMs += ms;
      this.quietMs = 0;
      if (!this.speaking && this.loudMs >= this.o.startMs) {
        this.speaking = true;
        this.startedAt = this.clock - this.loudMs;
        this.emit("speechStart", { at: this.startedAt });
      }
    } else {
      this.quietMs += ms;
      if (!this.speaking) this.loudMs = 0;
      if (this.speaking && this.quietMs >= this.o.stopMs) {
        this.speaking = false;
        this.loudMs = 0;
        const at = this.clock - this.quietMs;
        this.emit("speechEnd", { at, duration: at - this.startedAt });
      }
    }
    this.emit("level", { rms, speaking: this.speaking });
  }

  reset(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.quietMs = 0;
    this.blocks = [];
  }

  /**
   * The floor above only learns while nothing is loud, so a room that turns louder than
   * `ratio` times its old floor would stay "speaking" and never teach it. The quietest frame over
   * the last floorWindowMs is a floor too: speech dips between syllables, steady noise does not.
   */
  private followLouderRoom(rms: number, ms: number): void {
    const window = this.o.floorWindowMs;
    if (window <= 0) return;
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.ms < window / 4) {
      last.min = Math.min(last.min, rms);
      last.ms += ms;
    } else {
      this.blocks.push({ min: rms, ms });
    }
    let span = 0;
    for (const b of this.blocks) span += b.ms;
    // drop the oldest quarter once the rest still covers the window
    while (this.blocks.length > 1 && span - this.blocks[0].ms >= window) span -= this.blocks.shift()!.ms;
    if (span < window) return;
    let quietest = Infinity;
    for (const b of this.blocks) quietest = Math.min(quietest, b.min);
    if (quietest > this.noise) this.noise = quietest;
  }
}
