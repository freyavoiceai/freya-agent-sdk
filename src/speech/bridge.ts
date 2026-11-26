import type { Dictation } from "./dictation.js";

/** The page side of the native microphone bridge in docs/android-webview.md. */
export interface BridgeHost {
  /** Set by this class: the native app calls `onFrame(base64)` and `onEnd()`. */
  freyaMic?: { onFrame(base64: string): void; onEnd(): void };
  /** Android: `addJavascriptInterface(MicBridge(webView), "FreyaMicNative")`. */
  FreyaMicNative?: { start(): boolean | void; stop(): void };
  /** iOS: a `WKScriptMessageHandler` named `FreyaMicNative`. */
  webkit?: { messageHandlers?: { FreyaMicNative?: { postMessage(message: unknown): void } } };
}

export interface BridgeMicOptions {
  /** Rate of the frames the app sends (default 16000, what MicBridge.kt sends). */
  sampleRate?: number;
  /** `stop()` stops waiting for the app's `onEnd` after this long (ms, default 1000). */
  endTimeoutMs?: number;
  /** Default: `window`. */
  host?: BridgeHost;
}

/**
 * Feeds a `Dictation` from the app's microphone in a WebView: frames come in as
 * `window.freyaMic.onFrame(base64)` (little-endian Int16, as in MicBridge.kt), control goes out
 * through `FreyaMicNative`. The page needs no `getUserMedia`. Make one per page and reuse it.
 */
export class BridgeMic {
  private readonly host: BridgeHost;
  private readonly sampleRate: number;
  private readonly endTimeoutMs: number;
  private readonly listeners = new Set<(frame: Int16Array) => void>();
  private target?: Dictation;
  private ended?: () => void;
  private running = false;

  constructor(options: BridgeMicOptions = {}) {
    this.host = options.host ?? (globalThis as unknown as BridgeHost);
    this.sampleRate = options.sampleRate ?? 16000;
    this.endTimeoutMs = options.endTimeoutMs ?? 1000;
    this.host.freyaMic = {
      onFrame: (base64) => this.frame(base64),
      onEnd: () => {
        this.running = false;
        this.ended?.();
      },
    };
  }

  /** Every frame while recording, for `VoiceActivity` or a level meter. */
  onFrame(fn: (frame: Int16Array) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Starts the app's microphone and pushes its frames into `dictation`. Returns false when the app
   * has no microphone permission (Android). On iOS the app answers a refusal with `onEnd` instead.
   * The native side is stopped by itself once the dictation reaches its cap.
   */
  start(dictation: Dictation): boolean {
    this.target = dictation;
    const native = this.host.FreyaMicNative;
    const ios = this.host.webkit?.messageHandlers?.FreyaMicNative;
    let ok: boolean | void = true;
    if (native) ok = native.start();
    else if (ios) ios.postMessage({ command: "start" });
    else throw new Error("No native microphone bridge (FreyaMicNative) in this page");
    this.running = ok !== false;
    if (!this.running) this.target = undefined;
    return this.running;
  }

  /** Stops the app's microphone and waits for its last frames (`onEnd`, or the timeout). */
  async stop(): Promise<void> {
    if (!this.running) {
      this.target = undefined;
      return;
    }
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.endTimeoutMs);
      this.ended = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.sendStop();
    await done;
    this.ended = undefined;
    this.running = false;
    this.target = undefined;
  }

  /** Removes `window.freyaMic`. */
  dispose(): void {
    this.host.freyaMic = undefined;
    this.listeners.clear();
    this.target = undefined;
  }

  private sendStop(): void {
    const native = this.host.FreyaMicNative;
    if (native) native.stop();
    else this.host.webkit?.messageHandlers?.FreyaMicNative?.postMessage({ command: "stop" });
  }

  private frame(base64: string): void {
    if (!this.running && !this.ended) return;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length - (bin.length % 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
    const frame = new Int16Array(bytes.buffer);
    for (const fn of this.listeners) fn(frame);
    const target = this.target;
    if (!target) return;
    let open: boolean;
    try {
      open = target.push(frame, this.sampleRate);
    } catch {
      open = false; // the dictation failed or finished; finish() reports why
    }
    if (!open) {
      this.target = undefined;
      this.sendStop();
    }
  }
}
