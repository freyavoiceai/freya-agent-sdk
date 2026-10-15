/**
 * Where the bearer token comes from. A string is used as is; a function is asked again with
 * `refresh: true` after a 401, so a short-lived token from the app's own backend can be renewed
 * and the same request repeated. When the function returns a JWT with `exp`, it is also asked
 * shortly before that time, so a request rarely meets an expired token.
 */
export type TokenSource = string | ((options: { refresh: boolean }) => string | Promise<string>);

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AuthOptions {
  token: TokenSource;
  /** Inject a fetch (expo/fetch on React Native for streamed bodies). Defaults to the global one. */
  fetch?: FetchLike;
  /** Statuses that renew the token and repeat the request once. Freya speech answers a bad key with 403. */
  renewOn?: number[];
  /** Renew a JWT this long before its `exp` (ms, default 60 000; at most a fifth of its lifetime). 0 turns it off. */
  renewBeforeMs?: number;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64UrlToText(part: string): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of part.replace(/=+$/, "")) {
    const n = B64.indexOf(ch === "+" ? "-" : ch === "/" ? "_" : ch);
    if (n < 0) throw new Error("not base64url");
    value = (value << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  // UTF-8 without TextDecoder, which some React Native engines lack.
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, "0")}`).join(""));
}

/** When a JWT's renewal is due (ms since epoch), or null for a token that is not a JWT with `exp`. */
export function renewalTime(token: string, renewBeforeMs: number): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || renewBeforeMs <= 0) return null;
  try {
    const claims = JSON.parse(base64UrlToText(parts[1])) as { exp?: unknown; iat?: unknown };
    if (typeof claims.exp !== "number") return null;
    const exp = claims.exp * 1000;
    const life = typeof claims.iat === "number" ? exp - claims.iat * 1000 : Infinity;
    return exp - Math.min(renewBeforeMs, life / 5);
  } catch {
    return null;
  }
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
  private renewAt: number | null = null;
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
    const current = this.current;
    if (current && !this.refreshing && this.renewAt !== null && Date.now() >= this.renewAt) {
      // Renew early. The current token stays in use meanwhile and if the token source fails.
      this.renewAt = null;
      this.refreshing = this.resolve(true)
        .catch(() => current)
        .finally(() => {
          this.refreshing = null;
        });
      this.onRefresh?.();
      return this.refreshing;
    }
    if (current) return Promise.resolve(current);
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
    this.renewAt = renewalTime(value, this.options.renewBeforeMs ?? 60_000);
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
