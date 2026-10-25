import type { AudioOutput } from "./audio.js";
import { Emitter } from "./emitter.js";
import { SentenceAssembler, firstCut, isEndMark } from "./text.js";
import type { FreyaTts, Pcm } from "./tts.js";
import { wordTimings, type WordTiming } from "./words.js";

/** One piece of an answer as the app receives it, e.g. the text of one MQTT message. */
export interface Chunk {
  /**
   * Position in the answer, from 0. Left out, chunks are taken in arrival order. A whole-number
   * string ("3", as JSON from a queue may carry it) is read as that number; anything else drops
   * the chunk with an `error` event.
   */
  seq?: number | string;
  text: string;
  /** This is the answer's last chunk. */
  final?: boolean;
}

export interface ReaderOptions {
  /** Sentences per TTS request: 1 starts sooner, 2-3 makes fewer requests. */
  groupSize?: number;
  /** TTS requests in flight; more makes the first sentence wait. */
  parallel?: number;
  /** Voice a long first sentence's head (up to its first comma) on its own. */
  splitFirst?: boolean;
  /** A missing chunk is asked for again after this long (ms). */
  gapMs?: number;
  /** Attempts for a missing chunk before it is skipped. */
  resendTries?: number;
  /** How far past the next expected chunk a chunk may be held; one further ahead is dropped. */
  maxAhead?: number;
  /** Fetches a chunk that never arrived (e.g. from the answer store). Without it, the gap is skipped. */
  fetchMissing?: (seq: number, signal: AbortSignal) => Promise<Chunk>;
  voice?: string;
}

export interface ReaderSummary {
  chunks: number;
  sentences: number;
  late: number;
  lost: number;
  skipped: number;
  silent: number;
}

export interface ReaderEvents {
  /** A chunk was accepted (`late`: it came after a later one), held for its turn, or ignored as a repeat. */
  chunk: { seq: number; state: "ok" | "late" | "held" | "duplicate" };
  chunkMissing: { seq: number; attempt: number };
  chunkRecovered: { seq: number };
  chunkSkipped: { seq: number };
  /** A sentence group went to TTS. */
  sentenceQueued: { index: number; text: string };
  /** "This sentence is being read": its sound just started. Word times are estimated. */
  sentenceStart: { index: number; text: string; words: WordTiming[]; duration: number };
  word: { index: number; wordIndex: number; word: string };
  sentenceEnd: { index: number; text: string; interrupted: boolean };
  /** TTS failed twice for this sentence, or the device would not play it: show its text, no sound. */
  sentenceSilent: { index: number; text: string; error: string };
  done: ReaderSummary;
  /** A chunk was dropped (bad or far-off `seq`) or a sentence could not be played. Reading goes on. */
  error: { message: string };
}

/** A non-negative whole number, also from a string of digits; null for anything else ("1e0", "0x3"). */
function wholeNumber(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// a sentence's sound is let go once it has played; a long answer would otherwise keep all of it
const PLAYED: Promise<null> = Promise.resolve(null);

interface Item {
  index: number;
  text: string;
  ready: Promise<Pcm | null>;
  resolve: (pcm: Pcm | null) => void;
  /** Why TTS gave no sound, told when the sentence's turn comes. */
  failed?: string;
}

/**
 * Reads an answer aloud as its chunks arrive: puts them in order, recovers a lost one, builds
 * sentences, asks TTS for each (a renewed token on 401 repeats the same request) and plays them in
 * order with events per sentence and word.
 */
export class SpeechReader extends Emitter<ReaderEvents> {
  private readonly o: Required<Omit<ReaderOptions, "fetchMissing" | "voice">> & Pick<ReaderOptions, "fetchMissing" | "voice">;
  private readonly abort = new AbortController();
  private readonly asm = new SentenceAssembler();
  private autoSeq = 0;
  private next = 0;
  private held = new Map<number, Chunk>();
  private lastSeq: number | null = null;
  private maxSeen = -1;
  private ended = false;
  private textClosed = false;
  private gap: ReturnType<typeof setTimeout> | null = null;
  private tries = new Map<number, number>();
  private group: string[] = [];
  private items: Item[] = [];
  private queued = 0;
  private inflight = 0;
  private pos = 0;
  private busy = false;
  private finished = false;
  private wordTimers: ReturnType<typeof setTimeout>[] = [];
  private playing = false;
  private fetching = false;
  private lastChar = "";
  private readonly stats: ReaderSummary = { chunks: 0, sentences: 0, late: 0, lost: 0, skipped: 0, silent: 0 };

  constructor(private readonly tts: FreyaTts, private readonly output: AudioOutput, options: ReaderOptions = {}) {
    super();
    this.o = {
      groupSize: Math.max(1, options.groupSize ?? 1),
      parallel: Math.max(1, options.parallel ?? 2),
      splitFirst: options.splitFirst ?? true,
      gapMs: options.gapMs ?? 1200,
      resendTries: options.resendTries ?? 3,
      maxAhead: Math.max(1, options.maxAhead ?? 50),
      fetchMissing: options.fetchMissing,
      voice: options.voice,
    };
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  /** The single input: hand every chunk here as it arrives, in any order. */
  push(chunk: Chunk): void {
    if (this.stopped) return;
    if (!chunk || typeof chunk !== "object") {
      this.emit("error", { message: "Chunk dropped: not an object" });
      return;
    }
    if (this.textClosed) {
      // a queue may deliver the last chunk twice: a repeat, not an error
      const repeat = wholeNumber(chunk.seq);
      if (repeat !== null && repeat < this.next) this.emit("chunk", { seq: repeat, state: "duplicate" });
      else this.emit("error", { message: "Chunk dropped: the answer has already ended" });
      return;
    }
    const seq = chunk.seq === undefined ? this.autoSeq : wholeNumber(chunk.seq);
    if (seq === null) {
      this.emit("error", { message: `Chunk dropped: seq ${JSON.stringify(chunk.seq)} is not a whole number` });
      return;
    }
    if (seq > this.next + this.o.maxAhead) {
      this.emit("error", { message: `Chunk dropped: seq ${seq} is more than ${this.o.maxAhead} ahead of ${this.next}` });
      return;
    }
    this.autoSeq = Math.max(this.autoSeq, seq + 1);
    this.take({ ...chunk, seq }, false);
  }

  /** The answer stream closed. `parts`: how many chunks it says it sent, when known. */
  end(parts?: number): void {
    if (this.stopped) return;
    this.ended = true;
    if (this.lastSeq === null) {
      const n = parts === undefined ? null : wholeNumber(parts);
      // a count that is not a number, or far beyond what arrived, would wait for chunks that never come
      this.lastSeq = n !== null && n > 0 && n - 1 <= this.maxSeen + this.o.maxAhead ? n - 1 : this.maxSeen;
    }
    this.check();
  }

  /** Barge-in: silence now, drop what is left, cancel requests. */
  stop(): void {
    if (this.stopped) return;
    this.abort.abort();
    this.clearGap();
    this.clearWords();
    // the output may be shared: another reader's sentence is not ours to cut
    if (this.playing) this.output.stop();
  }

  private take(c: Chunk & { seq: number }, resent: boolean): void {
    if (c.final) this.lastSeq = c.seq;
    if (c.seq < this.next || this.held.has(c.seq)) {
      this.emit("chunk", { seq: c.seq, state: "duplicate" });
      return;
    }
    const late = !resent && c.seq < this.maxSeen;
    this.maxSeen = Math.max(this.maxSeen, c.seq);
    if (late) this.stats.late++;
    if (c.seq > this.next) {
      this.held.set(c.seq, c);
      this.emit("chunk", { seq: c.seq, state: "held" });
      this.armGap();
      return;
    }
    this.accept(c, late ? "late" : "ok");
    this.drain();
    this.check();
  }

  private accept(c: Chunk & { seq: number }, state: "ok" | "late"): void {
    this.stats.chunks++;
    this.emit("chunk", { seq: c.seq, state });
    this.next = c.seq + 1;
    if (typeof c.text !== "string") {
      this.emit("error", { message: `Chunk ${c.seq} has no text` });
      return;
    }
    // chunks that are whole sentences ("Merhaba." then "Size nasıl...") would run together
    const text = isEndMark(this.lastChar) && /^[A-ZÇĞİÖŞÜ"“(]/.test(c.text) ? ` ${c.text}` : c.text;
    if (text) this.lastChar = text[text.length - 1];
    for (const s of this.asm.feed(text)) this.sentence(s);
  }

  private drain(): void {
    for (let h = this.held.get(this.next); h; h = this.held.get(this.next)) {
      this.held.delete(this.next);
      this.accept(h as Chunk & { seq: number }, "ok");
    }
  }

  private check(): void {
    this.clearGap();
    if (this.lastSeq !== null && this.next > this.lastSeq) {
      this.closeText();
      return;
    }
    if (this.held.size || this.ended) this.armGap();
  }

  private armGap(): void {
    if (!this.gap && !this.textClosed && !this.stopped) this.gap = setTimeout(() => this.recover(), this.o.gapMs);
  }

  private clearGap(): void {
    if (this.gap) clearTimeout(this.gap);
    this.gap = null;
  }

  private recover(): void {
    this.gap = null;
    if (this.stopped || this.textClosed) return;
    // a fetch is still running: look again once it has had its time
    if (this.fetching) {
      this.armGap();
      return;
    }
    const seq = this.next;
    const attempt = (this.tries.get(seq) ?? 0) + 1;
    this.tries.set(seq, attempt);
    if (attempt === 1) this.stats.lost++;
    this.emit("chunkMissing", { seq, attempt });
    const giveUp = () => {
      // without fetchMissing nothing would bring it: skip at once
      if (this.o.fetchMissing && attempt < this.o.resendTries) {
        this.armGap();
        return;
      }
      this.stats.skipped++;
      this.emit("chunkSkipped", { seq });
      this.next = seq + 1;
      this.drain();
      this.check();
    };
    if (!this.o.fetchMissing) {
      giveUp();
      return;
    }
    // one fetch at a time, and one that hangs counts as failed after gapMs
    this.fetching = true;
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    this.abort.signal.addEventListener("abort", onStop, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new Error("fetchMissing timed out"));
      }, this.o.gapMs);
    });
    Promise.race([this.o.fetchMissing(seq, ctl.signal), hung])
      .finally(() => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", onStop);
        this.fetching = false;
      })
      .then(
        (c) => {
          if (this.stopped || this.textClosed || seq < this.next) return;
          if (!c || typeof c.text !== "string") {
            giveUp();
            return;
          }
          this.emit("chunkRecovered", { seq });
          this.take({ ...c, seq }, true);
        },
        () => {
          if (!this.stopped && !this.textClosed && seq === this.next) giveUp();
        },
      );
  }

  private closeText(): void {
    if (this.textClosed) return;
    this.textClosed = true;
    this.clearGap();
    for (const s of this.asm.flush()) this.sentence(s);
    this.flushGroup();
    this.pump();
  }

  private sentence(text: string): void {
    if (this.o.splitFirst && !this.stats.sentences && !this.group.length) {
      const cut = firstCut(text);
      if (cut.length > 1) {
        this.group.push(cut[0]);
        this.flushGroup();
        text = cut[1];
      }
    }
    this.stats.sentences++;
    this.group.push(text);
    if (this.group.length >= this.o.groupSize) this.flushGroup();
  }

  private flushGroup(): void {
    if (!this.group.length) return;
    let resolve!: (pcm: Pcm | null) => void;
    const ready = new Promise<Pcm | null>((r) => (resolve = r));
    const item: Item = { index: this.items.length, text: this.group.join(" "), ready, resolve };
    this.group = [];
    this.items.push(item);
    this.emit("sentenceQueued", { index: item.index, text: item.text });
    this.startMore();
    this.pump();
  }

  // the earliest sentences first, at most `parallel` at a time
  private startMore(): void {
    while (!this.stopped && this.inflight < this.o.parallel && this.queued < this.items.length) {
      const item = this.items[this.queued++];
      this.inflight++;
      this.synth(item).then((pcm) => {
        this.inflight--;
        item.resolve(pcm);
        this.startMore();
      });
    }
  }

  private async synth(item: Item): Promise<Pcm | null> {
    let last = "";
    for (let attempt = 0; attempt < 2 && !this.stopped; attempt++) {
      try {
        return await this.tts.synthesize(item.text, { voice: this.o.voice, signal: this.abort.signal });
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
    }
    item.failed = last;
    return null;
  }

  private pump(): void {
    if (this.busy || this.stopped) return;
    const item = this.items[this.pos];
    if (!item) {
      if (this.textClosed && !this.finished) {
        this.finished = true;
        this.emit("done", { ...this.stats });
      }
      return;
    }
    this.busy = true;
    item.ready.then(async (pcm) => {
      if (this.stopped) return;
      item.ready = PLAYED;
      // the resolver holds the first promise, and with it the sound
      item.resolve = () => {};
      if (!pcm) {
        this.stats.silent++;
        this.emit("sentenceSilent", { index: item.index, text: item.text, error: item.failed ?? "" });
      } else {
        try {
          await this.play(item, pcm);
        } catch (err) {
          // the device would not play it: show the text and go on with the next sentence
          this.clearWords();
          const message = err instanceof Error ? err.message : String(err);
          this.stats.silent++;
          this.emit("error", { message: `Playback failed: ${message}` });
          this.emit("sentenceSilent", { index: item.index, text: item.text, error: message });
        }
      }
      if (this.stopped) return;
      this.pos++;
      this.busy = false;
      this.pump();
    });
  }

  private async play(item: Item, pcm: Pcm): Promise<void> {
    const duration = pcm.samples.length / pcm.sampleRate;
    const words = wordTimings(item.text, pcm);
    this.playing = true;
    let started = false;
    let result: "ended" | "stopped";
    try {
      result = await this.output.play(pcm, () => {
        started = true;
        this.emit("sentenceStart", { index: item.index, text: item.text, words, duration });
        words.forEach((w, wordIndex) => {
          this.wordTimers.push(
            setTimeout(() => this.emit("word", { index: item.index, wordIndex, word: w.word }), w.start * 1000),
          );
        });
      });
    } finally {
      this.playing = false;
    }
    this.clearWords();
    // stopped before its sound began (e.g. while the output waited to resume): it never started
    if (started) this.emit("sentenceEnd", { index: item.index, text: item.text, interrupted: result === "stopped" });
  }

  private clearWords(): void {
    for (const t of this.wordTimers) clearTimeout(t);
    this.wordTimers = [];
  }
}
