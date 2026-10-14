import { TokenKeeper, type FetchLike, type TokenSource } from "../speech/auth.js";
import { errorFrom } from "../speech/tts.js";

export interface AgentChatConfig {
  /** Freya dashboard, e.g. https://app.freyavoice.ai or https://tr-app.freyavoice.ai, or a backend that proxies it. */
  baseUrl: string;
  /**
   * A key with the `calls:chat-message` permission, or a function returning one. A workspace key
   * must stay on a server: from a mobile app, point `baseUrl` at your own backend instead.
   */
  token: TokenSource;
  /** Sent as `?workspaceId=`; optional when the key belongs to one workspace. */
  workspaceId?: string;
  fetch?: FetchLike;
  renewOn?: number[];
}

export interface AgentTurn {
  reply: string;
  callId: string;
  messageId?: string;
  /** The agent ended the conversation in this turn. */
  ended: boolean;
}

/**
 * Text conversation with a Freya agent or workflow over REST, one request per turn. Pair it with
 * FreyaSpeech for a voice conversation without WebRTC: STT the user's audio, send the text here,
 * read the reply with a SpeechReader.
 */
export class AgentChat {
  private readonly keeper: TokenKeeper;
  private readonly baseUrl: string;
  private _callId: string | null = null;

  constructor(private readonly config: AgentChatConfig & ({ workflowId: string } | { agentId: string })) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.keeper = new TokenKeeper({ token: config.token, fetch: config.fetch, renewOn: config.renewOn });
  }

  get callId(): string | null {
    return this._callId;
  }

  /** Sends one user message; the first one starts the conversation. */
  async send(
    message: string,
    options: { customerVariables?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<AgentTurn> {
    const body: Record<string, unknown> = { message };
    if (this._callId) {
      body.callId = this._callId;
    } else {
      if ("workflowId" in this.config) body.workflowId = this.config.workflowId;
      else body.agentId = this.config.agentId;
      if (options.customerVariables) body.customerVariables = options.customerVariables;
    }
    const data = await this.post("/api/v2/chat/message", body, options.signal);
    this._callId = String(data.callId);
    return {
      reply: String(data.response ?? "").trim(),
      callId: this._callId,
      messageId: typeof data.messageId === "string" ? data.messageId : undefined,
      ended: data.endedByAgent === true,
    };
  }

  /** Ends the conversation; safe to call twice. */
  async end(): Promise<void> {
    if (!this._callId) return;
    await this.post("/api/v2/chat/end", { callId: this._callId });
    this._callId = null;
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const query = this.config.workspaceId ? `?workspaceId=${encodeURIComponent(this.config.workspaceId)}` : "";
    const res = await this.keeper.fetch(`${this.baseUrl}${path}${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw await errorFrom(res, "Agent chat");
    const json = (await res.json()) as { data?: { result?: Record<string, unknown> } };
    return json.data?.result ?? {};
  }
}
