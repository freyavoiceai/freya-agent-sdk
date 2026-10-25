# Tokens and security

## Rule

A long-lived Freya key never ships inside an app. Your backend keeps it and gives the app something short-lived.

| Credential | Lives in | Lets you | Lifetime |
|---|---|---|---|
| Workspace API key with `calls:web-token` | your backend | mint embed tokens | until revoked |
| Workspace API key with `calls:chat-message` | your backend | call `/api/v2/chat/*` (`AgentChat`) | until revoked |
| Speech (model) key | your backend | call Freya STT and TTS | until revoked |
| Embed token | the app | start WebRTC sessions with one agent | 60 to 3600 s (default 3600; ask for less) |
| Your own session token | the app | call your backend, which adds the Freya key | your choice |

## WebRTC: embed tokens

Your backend asks the dashboard for a token bound to one agent and one web origin:

```http
POST https://app.freyavoice.ai/api/token/embed
Authorization: Bearer <workspace key with calls:web-token>
Content-Type: application/json

{ "agentId": "<agent or workflow id>", "allowedOrigin": "https://your-app.example", "ttlSeconds": 600 }
```

```json
{ "token": "…", "expiresAt": "2026-10-14T12:00:00.000Z" }
```

- `allowedOrigin` must be `https://` except for localhost.
- A workflow id is accepted; the token always carries the agent's id.
- The token is only valid for `/api/token/webrtc` (starting the call) and `/api/token/webrtc/ice-servers`. It does not work for `AgentChat` or for speech.
- It is a bearer token: whoever holds it can start calls with that agent until it expires. The origin check stops other web pages, not a script outside a browser. Mint one per call with a short `ttlSeconds` (60 to 300).
- `customerVariables` and `metadata` come from the app, so a user can change them. Do not let the agent's tools treat them as proof of who the caller is.

The app passes it to `new FreyaClient({ baseUrl, token })`. A call that is already connected keeps running when the token expires; mint a new one for the next call.

## REST and speech: your backend in between

[`examples/token-backend.mjs`](../examples/token-backend.mjs) is a starting point that already does what this section asks: it rebuilds every body (the app cannot pick the workflow, the customer variables, the STT model or a prompt), accepts JSON only as `application/json` (a cross-site form cannot post to it), ties each call to the user who started it (the last 20 per user), refuses redirects, caps bodies and times out upstream. It refuses to start without `APP_ORIGIN` unless `DEMO_AUTH=1`. Replace its `userOf` with your own session check and add a rate limit.

`AgentChat` needs a key with `calls:chat-message`, and speech needs the speech key. Both stay on your backend in one of two ways.

| Option | How | When |
|---|---|---|
| Proxy | Point `baseUrl` (`AgentChat`) or `stt.url` / `tts.url` (`FreyaSpeech`) at your backend. It checks the app's own session token, builds the upstream request itself and adds the Freya key. The app must not choose what it may not do: the backend fixes the agent or workflow, takes customer variables from the session, and continues or ends only calls this user started. | Mobile and web apps (recommended) |
| Server-side | Run `AgentChat` and `FreyaSpeech` in Node with the key from the environment. | Server-to-server integrations |

A minimal proxy is in [`examples/token-backend.mjs`](../examples/token-backend.mjs).

## Renewal

`token` may be a string or a function:

```js
const speech = new FreyaSpeech({
  token: async ({ refresh }) => (await fetch("/session", { method: refresh ? "POST" : "GET" }).then((r) => r.json())).token,
});
```

- The function is called once for the first request, then again with `{ refresh: true }` after a 401 or 403 (`renewOn` changes the list).
- The failed request is repeated once with the new token. A sentence being read aloud carries on from where it was.
- Requests running at the same time share one refresh.
- A second 401 or 403 after renewal throws `SpeechHttpError` with that `status`.
- Freya speech answers an invalid key with 403, not 401, which is why both statuses renew by default.
- When the function returns a JWT with `exp`, it is also called with `{ refresh: true }` shortly before that time: 60 s before by default, at most a fifth of the token's lifetime (`renewBeforeMs`, `0` turns it off). The check runs at the next request, without timers. The current token stays in use while the new one is fetched, and is kept if the token function fails.

## Checklist for production

- Keys only in your backend's secret store; never in the app bundle, logs or URLs.
- Embed tokens with the shortest `ttlSeconds` that covers connecting, bound to your exact origin.
- Your proxy forwards only the paths the SDK uses: `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/stream`, `/api/v2/chat/message`, `/api/v2/chat/end`.
- Your proxy builds the body: agent or workflow id from its own config, customer variables from the user's session, a `callId` only if this user started that call. It drops the query string, caps the body size and sets a timeout.
- Anything the app sends (customer variables, metadata) can be changed by the user. Never let it decide whose data the agent reads.
- All URLs are `https://`; the SDK refuses plain http except for localhost.
- Rate-limit the token and proxy endpoints per user.
- In browsers a WebSocket cannot send an `Authorization` header, so live STT from a browser must go through your proxy.
