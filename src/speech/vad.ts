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

  constructor(options: VoiceActivityOptions = {}) {
    super();
    // an option given as undefined (an unset React prop) keeps its default
    this.o = {
      startMs: options.startMs ?? 120,
      stopMs: options.stopMs ?? 700,
      minLevel: options.minLevel ?? 0.015,
      ratio: options.ratio ?? 3,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** One frame of mono audio: Float32 in -1..1 or Int16. */
  push(frame: Float32Array | Int16Array, sampleRate: number): void {
    const scale = frame instanceof Int16Array ? 1 / 32768 : 1;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += (frame[i] * scale) ** 2;
    const rms = Math.sqrt(sum / Math.max(frame.length, 1));
    const ms = (frame.length / sampleRate) * 1000;
    this.clock += ms;
    const loud = rms > Math.max(this.o.minLevel, this.noise * this.o.ratio);
    // the floor follows the room only while nobody speaks
    if (!loud && !this.speaking) this.noise = this.noise * 0.95 + rms * 0.05;
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
  }
}
