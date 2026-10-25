/* ------------------------------------------------------------------ */
/*  Public config                                                      */
/* ------------------------------------------------------------------ */

/** Where a WebRTC session is: the transport's state machine. */
export type TransportState =
  | "disconnected"
  | "initializing"
  | "initialized"
  | "authenticating"
  | "authenticated"
  | "connecting"
  | "connected"
  | "ready"
  | "disconnecting"
  | "error";

export interface FreyaClientConfig {
  /** Base URL of the Freya dashboard, https:// (plain http only for localhost). */
  baseUrl: string;
  /** Short-lived embed token from POST /api/token/embed. */
  token: string;
  /** Whether the agent is voice ("call") or text ("chat"). Defaults to "call". */
  mode?: "call" | "chat";
  /** Extra key/value pairs forwarded to the backend in requestData. */
  metadata?: Record<string, unknown>;
  /** Initial customer variables for the session. */
  customerVariables?: Record<string, string>;
  /**
   * ICE servers (STUN/TURN) passed to the WebRTC transport. Optional: when
   * omitted the client fetches the ones the backend is configured with, which
   * is what most callers want. Set this only to override them.
   */
  iceServers?: RTCIceServer[];
  /**
   * How much the WebRTC layer writes to the console. Default "warn": at "debug" it logs every
   * message of the session, including what the user and the agent said and tool arguments.
   */
  logLevel?: "none" | "error" | "warn" | "info" | "debug";
}

/* ------------------------------------------------------------------ */
/*  Public events                                                      */
/* ------------------------------------------------------------------ */

/**
 * Events emitted by FreyaClient.
 * The string values are the event names you pass to `on()` / `off()`.
 */
export const FreyaEvent = {
  /** Transport state machine changed. */
  StateChanged: "stateChanged",
  /** Bot is fully ready to interact. */
  BotReady: "botReady",
  /** Bot started speaking. */
  BotStartedSpeaking: "botStartedSpeaking",
  /** Bot stopped speaking. */
  BotStoppedSpeaking: "botStoppedSpeaking",
  /** User started speaking (VAD). */
  UserStartedSpeaking: "userStartedSpeaking",
  /** User stopped speaking (VAD). */
  UserStoppedSpeaking: "userStoppedSpeaking",
  /** Partial / final user transcript. */
  UserTranscript: "userTranscript",
  /** Bot LLM turn started — a new response is being generated. */
  BotLlmStarted: "botLlmStarted",
  /** Bot LLM text chunk (streaming). */
  BotLlmText: "botLlmText",
  /** Bot LLM turn finished. */
  BotLlmStopped: "botLlmStopped",
  /**
   * Complete bot message — fires once per turn with the full text. In chat
   * mode, a turn that merely repeats the previous message with no user
   * message in between (post-tool platform echo) is suppressed.
   */
  BotMessage: "botMessage",
  /** Bot text aggregated per sentence — fires multiple times per turn. */
  BotTranscript: "botTranscript",
  /** Bot output chunk — fires for each TTS-spoken sentence with { text, spoken }. */
  BotOutput: "botOutput",
  /** Remote audio track is available. */
  TrackStarted: "trackStarted",
  /** Remote audio track ended. */
  TrackStopped: "trackStopped",
  /** An error occurred. */
  Error: "error",
  /** Session disconnected. */
  Disconnected: "disconnected",
  /** LLM started invoking a tool/function. */
  ToolCallStarted: "toolCallStarted",
  /** LLM tool/function call is in progress (includes name + arguments). */
  ToolCallInProgress: "toolCallInProgress",
  /** LLM tool/function call completed. */
  ToolCallStopped: "toolCallStopped",
} as const;

export type FreyaEventName = (typeof FreyaEvent)[keyof typeof FreyaEvent];

/** Map from FreyaEvent name → callback signature. */
export interface FreyaEventMap {
  stateChanged: (state: TransportState) => void;
  botReady: () => void;
  botStartedSpeaking: () => void;
  botStoppedSpeaking: () => void;
  userStartedSpeaking: () => void;
  userStoppedSpeaking: () => void;
  userTranscript: (data: { text: string; final: boolean }) => void;
  botLlmStarted: () => void;
  botLlmText: (data: { text: string }) => void;
  botLlmStopped: () => void;
  botMessage: (data: { text: string }) => void;
  botTranscript: (data: { text: string }) => void;
  botOutput: (data: { text: string; spoken: boolean }) => void;
  trackStarted: (track: MediaStreamTrack) => void;
  trackStopped: (track: MediaStreamTrack) => void;
  error: (error: { message: string; fatal: boolean }) => void;
  disconnected: () => void;
  toolCallStarted: (data: { function_name?: string; tool_call_id?: string }) => void;
  toolCallInProgress: (data: { function_name: string; tool_call_id: string; arguments: Record<string, unknown> }) => void;
  toolCallStopped: (data: { function_name?: string; tool_call_id?: string }) => void;
}
