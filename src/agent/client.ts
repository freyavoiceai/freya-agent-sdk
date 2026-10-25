import { LogLevel, PipecatClient, RTVIEvent, logger } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import { secureBase } from "../speech/auth.js";
import {
  type FreyaClientConfig,
  type FreyaEventMap,
  type FreyaEventName,
  FreyaEvent,
} from "./types.js";
import { NativeMicManager } from "./native-media-manager.js";

type Listener = (...args: unknown[]) => void;

/**
 * Maps Pipecat RTVIEvent values we care about to FreyaEvent names.
 * Events not in this map are silently ignored.
 */
const RTVI_TO_FREYA: Partial<Record<RTVIEvent, FreyaEventName>> = {
  [RTVIEvent.TransportStateChanged]: FreyaEvent.StateChanged,
  [RTVIEvent.BotReady]: FreyaEvent.BotReady,
  [RTVIEvent.BotStartedSpeaking]: FreyaEvent.BotStartedSpeaking,
  [RTVIEvent.BotStoppedSpeaking]: FreyaEvent.BotStoppedSpeaking,
  [RTVIEvent.UserStartedSpeaking]: FreyaEvent.UserStartedSpeaking,
  [RTVIEvent.UserStoppedSpeaking]: FreyaEvent.UserStoppedSpeaking,
  [RTVIEvent.UserTranscript]: FreyaEvent.UserTranscript,
  [RTVIEvent.BotLlmStarted]: FreyaEvent.BotLlmStarted,
  [RTVIEvent.BotLlmText]: FreyaEvent.BotLlmText,
  [RTVIEvent.BotLlmStopped]: FreyaEvent.BotLlmStopped,
  [RTVIEvent.BotTranscript]: FreyaEvent.BotTranscript,
  [RTVIEvent.BotOutput]: FreyaEvent.BotOutput,
  [RTVIEvent.TrackStarted]: FreyaEvent.TrackStarted,
  [RTVIEvent.TrackStopped]: FreyaEvent.TrackStopped,
  [RTVIEvent.Error]: FreyaEvent.Error,
  [RTVIEvent.Disconnected]: FreyaEvent.Disconnected,
  [RTVIEvent.LLMFunctionCallStarted]: FreyaEvent.ToolCallStarted,
  [RTVIEvent.LLMFunctionCallInProgress]: FreyaEvent.ToolCallInProgress,
  [RTVIEvent.LLMFunctionCallStopped]: FreyaEvent.ToolCallStopped,
};

const LOG_LEVELS = { none: LogLevel.NONE, error: LogLevel.ERROR, warn: LogLevel.WARN, info: LogLevel.INFO, debug: LogLevel.DEBUG };

/**
 * Headless SDK for embedding Freya voice/chat agents.
 *
 * ```ts
 * const client = new FreyaClient({ baseUrl, token, mode: "call" });
 * client.on("botTranscript", (d) => console.log(d.text));
 * await client.connect();
 * ```
 */
export class FreyaClient {
  // iceServers stays optional: an omitted option asks the backend, an explicit [] disables.
  private _config: Omit<Required<FreyaClientConfig>, "iceServers" | "logLevel" | "connectTimeoutMs"> &
    Pick<FreyaClientConfig, "iceServers" | "logLevel" | "connectTimeoutMs">;
  private _pc: PipecatClient | null = null;
  private _pendingPc: PipecatClient | null = null;
  // Set before the first await so disconnect() and a second connect() see it.
  private _connecting: AbortController | null = null;
  private _listeners = new Map<string, Set<Listener>>();
  private _audioEl: HTMLAudioElement | null = null;
  private _userSpokeSinceBot = false;

  constructor(config: FreyaClientConfig) {
    this._config = {
      mode: "call",
      metadata: {},
      customerVariables: {},
      ...config,
      baseUrl: secureBase(config.baseUrl, "baseUrl"),
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Event emitter                                                    */
  /* ---------------------------------------------------------------- */

  on<E extends FreyaEventName>(
    event: E,
    fn: FreyaEventMap[E],
  ): this {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(fn as Listener);
    return this;
  }

  off<E extends FreyaEventName>(
    event: E,
    fn: FreyaEventMap[E],
  ): this {
    this._listeners.get(event)?.delete(fn as Listener);
    return this;
  }

  private _emit(event: string, ...args: unknown[]) {
    this._listeners.get(event)?.forEach((fn) => {
      try {
        fn(...args);
      } catch (e) {
        console.error(`[FreyaClient] listener error on "${event}"`, e);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  /** Connect to the Freya agent via WebRTC. */
  async connect(): Promise<void> {
    if (this._pc || this._pendingPc || this._connecting) {
      throw new Error("Already connected. Call disconnect() first.");
    }
    const attempt = new AbortController();
    this._connecting = attempt;
    let pc: PipecatClient | null = null;
    let mic: NativeMicManager | null = null;
    // Before the peer connection exists the transport's stop() returns early and leaves the
    // microphone open, so the track is stopped here too.
    const release = async () => {
      try { await pc?.disconnect(); } catch { /* best-effort */ }
      await mic?.disconnect();
    };
    try {
      // Without a relay the browser offers only host candidates, which the agent
      // cannot reach; ask the backend for one rather than depending on the agent's.
      // Supplied wins, including an explicit [] meaning "no servers"; only an
      // omitted option asks the backend.
      const iceServers = this._config.iceServers !== undefined
        ? this._config.iceServers
        : await this._fetchIceServers(attempt.signal);
      if (attempt.signal.aborted) return;

      // Pipecat logs at debug by default, which prints the whole conversation to the console.
      logger.setLevel(LOG_LEVELS[this._config.logLevel ?? "warn"]);

      mic = new NativeMicManager(this._config.mode === "call");
      const transport = new SmallWebRTCTransport({
        ...(iceServers && iceServers.length > 0 ? { iceServers } : {}),
        waitForICEGathering: true,
        // Use native getUserMedia instead of @daily-co/daily-js so the ~10 MB
        // Daily call-machine-object-bundle is never downloaded.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mediaManager: mic as any,
      });

      // attemptReconnection(true) recreates the RTCPeerConnection and sends
      // restart_pc=true — the server treats it as a fresh session. Suppress it
      // and surface as a clean disconnect instead (matching the internal
      // use-small-webrtc-transport.ts behaviour).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = transport as any;
      const _origReconnect = t.attemptReconnection?.bind(transport);
      if (_origReconnect) {
        t.attemptReconnection = async (recreate = false) => {
          if (recreate) {
            await t.stop?.();
            return;
          }
          await _origReconnect(recreate);
        };
      }

      const client = new PipecatClient({
        enableCam: false,
        enableMic: this._config.mode === "call",
        transport,
      });
      pc = client;

      // Wire up events before connecting so none are missed.
      this._bindEvents(client);

      // Autoplay remote audio when a track arrives. Skip the local mic track
      // (SmallWebRTC fires TrackStarted for local mic too with participant.local=true).
      client.on(RTVIEvent.TrackStarted, (track: MediaStreamTrack, participant?: { local?: boolean }) => {
        if (track.kind === "audio" && !participant?.local) {
          this._attachAudio(track);
        }
      });

      // Track in-flight PC so disconnect() can abort a pending handshake.
      this._pendingPc = client;
      // Pipecat's own connect() asks for the microphone outside its error handling, so a denied
      // prompt would leave it pending forever. Asked here, the denial rejects this connect().
      if (client.needsInit()) await client.initDevices();
      if (attempt.signal.aborted) {
        await release();
        return;
      }
      await this._withTimeout(
        client.connect({
          webrtcRequestParams: {
            endpoint: `${this._config.baseUrl}/api/token/webrtc`,
            headers: new Headers({
              Authorization: `Bearer ${this._config.token}`,
            }),
            requestData: {
              ...this._config.metadata,
              customerVariables: this._config.customerVariables,
              callType: this._config.mode,
            },
          },
        }),
        this._config.connectTimeoutMs ?? 30_000,
      );
      // disconnect() came while the handshake was running: do not resurrect the session.
      if (attempt.signal.aborted) {
        await release();
        return;
      }
      // Only assign after a successful handshake so a failed connect()
      // call doesn't leave this._pc set and block retries.
      this._pc = client;
    } catch (e) {
      await release();
      // disconnect() already cleaned up, and a newer connect() may own the fields by now.
      if (attempt.signal.aborted) return;
      if (this._connecting === attempt) this._cleanup();
      throw e;
    } finally {
      if (pc && this._pendingPc === pc) this._pendingPc = null;
      if (this._connecting === attempt) this._connecting = null;
    }
  }

  private _withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Connection timed out after ${ms} ms`)), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  /** Disconnect the current session. Safe to call multiple times. */
  async disconnect(): Promise<void> {
    // Abort first: a connect still awaiting its relay config has no client yet.
    this._connecting?.abort();
    this._connecting = null;
    const pc = this._pc ?? this._pendingPc;
    if (!pc) {
      this._cleanup();
      return;
    }
    try {
      await pc.disconnect();
    } catch {
      // Already disconnected — swallow.
    }
    this._cleanup();
  }

  /* ---------------------------------------------------------------- */
  /*  Actions                                                          */
  /* ---------------------------------------------------------------- */

  /** Send a text message to the bot. Useful in "chat" mode. */
  async sendMessage(text: string): Promise<void> {
    if (!this._pc) throw new Error("Not connected");
    this._userSpokeSinceBot = true;
    await this._pc.sendText(text);
  }

  /** Mute the user's microphone. */
  mute(): void {
    this._pc?.enableMic(false);
  }

  /** Unmute the user's microphone. */
  unmute(): void {
    this._pc?.enableMic(true);
  }

  /** Returns whether the mic is currently enabled. */
  get isMicEnabled(): boolean {
    return this._pc?.isMicEnabled ?? false;
  }

  /** Returns the current transport state. */
  get state(): string {
    return this._pc?.state ?? this._pendingPc?.state ?? "disconnected";
  }

  /* ---------------------------------------------------------------- */
  /*  Internal                                                         */
  /* ---------------------------------------------------------------- */

  private _bindEvents(pc: PipecatClient) {
    // Clean up internal state on remote disconnect so connect() can be called again.
    pc.on(RTVIEvent.Disconnected, () => {
      // a late event from an earlier session must not clear the current one
      if (this._pc === pc || this._pendingPc === pc) this._cleanup();
    });

    // Aggregate streaming LLM chunks into one botMessage per turn.
    // Only accept text between started/stopped: output guardrails re-push
    // buffered text after bot-llm-stopped, which would otherwise duplicate.
    let llmBuffer = "";
    let llmActive = false;
    let lastMessage = "";
    this._userSpokeSinceBot = false;
    const squash = (s: string) => s.replace(/\s+/g, "");
    pc.on(RTVIEvent.BotLlmStarted, () => {
      llmActive = true;
      llmBuffer = "";
    });
    pc.on(RTVIEvent.BotLlmText, (data: { text?: string } | string) => {
      if (!llmActive) return;
      const text = typeof data === "string" ? data : data?.text;
      if (text) llmBuffer += text;
    });
    pc.on(RTVIEvent.BotLlmStopped, () => {
      llmActive = false;
      if (llmBuffer) {
        // Chat mode: after tool-using turns the platform can dispatch an extra
        // generation repeating the previous reply (sometimes twice-concatenated).
        // Drop it only when no user message arrived in between, so legitimate
        // repeats ("pardon?" re-asks) are never affected. Known ceiling: a
        // bot-initiated turn whose full text exactly equals the previous
        // message (or the previous message twice) is indistinguishable from
        // the echo and is dropped.
        const cur = squash(llmBuffer);
        const last = squash(lastMessage);
        const isEcho =
          this._config.mode === "chat" &&
          !this._userSpokeSinceBot &&
          last.length > 0 &&
          (cur === last || cur === last + last);
        if (!isEcho) {
          this._emit(FreyaEvent.BotMessage, { text: llmBuffer });
          lastMessage = llmBuffer;
        }
        this._userSpokeSinceBot = false;
      }
      llmBuffer = "";
    });

    // Map each RTVIEvent we care about to the corresponding FreyaEvent.
    for (const [rtviKey, freyaKey] of Object.entries(RTVI_TO_FREYA)) {
      const rtviEvent = rtviKey as RTVIEvent;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pc.on(rtviEvent, (...args: any[]) => {
        // SmallWebRTC fires TrackStarted/TrackStopped for the local mic too.
        // Callers only expect remote tracks on these events.
        if (
          (rtviEvent === RTVIEvent.TrackStarted || rtviEvent === RTVIEvent.TrackStopped) &&
          args[1]?.local
        ) return;
        // BotLlmText and BotTranscript emit a raw string from the RTVI protocol.
        // Normalise to { text } so callers match the documented FreyaEventMap types.
        if (
          rtviEvent === RTVIEvent.BotLlmText ||
          rtviEvent === RTVIEvent.BotTranscript
        ) {
          const text = args[0];
          if (typeof text === "string") {
            this._emit(freyaKey as string, { text });
            return;
          }
        }
        // Error is emitted with the full RTVI message object { data: { error, fatal } }.
        // Normalise to { message, fatal } to match FreyaEventMap types.
        if (rtviEvent === RTVIEvent.Error) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msg: any = args[0];
          const message: string = msg?.data?.error ?? msg?.message ?? String(msg ?? "Unknown error");
          const fatal: boolean = Boolean(msg?.data?.fatal);
          this._emit(freyaKey as string, { message, fatal });
          return;
        }
        this._emit(freyaKey as string, ...args);
      });
    }
  }

  private async _fetchIceServers(signal?: AbortSignal): Promise<RTCIceServer[] | undefined> {
    try {
      const res = await fetch(`${this._config.baseUrl}/api/token/webrtc/ice-servers`, {
        headers: new Headers({ Authorization: `Bearer ${this._config.token}` }),
        // a redirect could carry the request, and the servers it trusts, to another host
        redirect: "error",
        signal,
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { iceServers?: RTCIceServer[] };
      return Array.isArray(body.iceServers) && body.iceServers.length > 0 ? body.iceServers : undefined;
    } catch {
      return undefined;
    }
  }

  private _attachAudio(track: MediaStreamTrack) {
    if (!this._audioEl) {
      this._audioEl = document.createElement("audio");
      this._audioEl.autoplay = true;
      // Must be in the DOM for autoplay policies to respect the user-gesture grant
      // that triggered the connect() call.
      document.body.appendChild(this._audioEl);
    }
    const stream = new MediaStream([track]);
    this._audioEl.srcObject = stream;
  }

  private _cleanup() {
    if (this._audioEl) {
      this._audioEl.srcObject = null;
      this._audioEl.remove();
      this._audioEl = null;
    }
    this._pc = null;
    this._pendingPc = null;
    this._connecting = null;
  }
}
