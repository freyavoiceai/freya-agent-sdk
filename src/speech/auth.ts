/**
 * Where the bearer token comes from. A string is used as is; a function is asked again with
 * `refresh: true` after a 401, so a short-lived token from the app's own backend can be renewed
 * and the same request repeated.
 */
export type TokenSource = string | ((options: { refresh: boolean }) => string | Promise<string>);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthOptions {
  token: TokenSource;
  /** Inject a fetch (expo/fetch on React Native for streamed bodies). Defaults to the global one. */
  fetch?: FetchLike;
  /** Statuses that renew the token and repeat the request once. Freya speech answers a bad key with 403. */
  renewOn?: number[];
}

export class SpeechAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SpeechAuthError";
  }
}

/** One token per client; concurrent 401s share a single refresh. */
export class TokenKeeper {
  private current: string | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  onRefresh?: () => void;

  constructor(private readonly options: AuthOptions) {
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error("No fetch available: pass options.fetch");
    this.fetchImpl = (input, init) => f(input, init);
  }

  /** The current token; parallel first calls share one request to the token source. */
  token(): Promise<string> {
    if (this.current) return Promise.resolve(this.current);
    if (!this.refreshing) {
      this.refreshing = this.resolve(false).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** Called with the token that just failed, so a refresh started by a parallel request is reused. */
  refresh(failed: string): Promise<string> {
    if (this.current && this.current !== failed) return Promise.resolve(this.current);
    if (!this.refreshing) {
      this.current = null;
      this.refreshing = this.resolve(true).finally(() => {
        this.refreshing = null;
      });
      this.onRefresh?.();
    }
    return this.refreshing;
  }

  private async resolve(refresh: boolean): Promise<string> {
    const source = this.options.token;
    if (typeof source === "string") {
      if (refresh) throw new SpeechAuthError(401, "Token rejected and no token function to renew it");
      this.current = source;
      return source;
    }
    const value = await source({ refresh });
    this.current = value;
    return value;
  }

  /** fetch with the bearer token; on 401 or 403 the token is renewed once and the same request repeated. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const send = (token: string) =>
      this.fetchImpl(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    const first = await this.token();
    const res = await send(first);
    if (!(this.options.renewOn ?? [401, 403]).includes(res.status) || typeof this.options.token === "string") return res;
    return send(await this.refresh(first));
  }
}
