# Voice agent over WebRTC

`FreyaClient` opens one live session with a Freya agent or workflow. In `call` mode the agent hears the microphone and plays its voice; in `chat` mode it is text only over the same connection.

```js
import { FreyaClient, FreyaEvent } from "@freyavoice/agent-sdk";

const client = new FreyaClient({
  baseUrl: "https://app.freyavoice.ai",
  token: embedToken,                       // from your backend, see tokens-and-security.md
  mode: "call",                            // or "chat"
  customerVariables: { customer_name: "Ayşe" },
  metadata: { channel: "mobile-web" },
});

client.on(FreyaEvent.StateChanged, (state) => setStatus(state));
client.on(FreyaEvent.UserTranscript, ({ text, final }) => final && addUserLine(text));
client.on(FreyaEvent.BotOutput, ({ text, spoken }) => spoken && addBotWords(text));
client.on(FreyaEvent.BotStartedSpeaking, () => showSpeaking(true));
client.on(FreyaEvent.BotStoppedSpeaking, () => showSpeaking(false));
client.on(FreyaEvent.Error, ({ message, fatal }) => fatal && showError(message));
client.on(FreyaEvent.Disconnected, () => showEnded());

await client.connect();
```

## Options

| Option | Required | Meaning |
|---|---|---|
| `baseUrl` | yes | The Freya dashboard the token came from, no trailing slash |
| `token` | yes | Embed token |
| `mode` | no | `"call"` (default) or `"chat"` |
| `customerVariables` | no | Values the workflow reads as customer variables. They come from the browser, so the user can change them: never use them to decide whose data the agent reads |
| `metadata` | no | Extra key/value pairs sent with the session request |
| `iceServers` | no | STUN/TURN servers. Leave it out to use the ones the dashboard is configured with; `[]` means none |
| `connectTimeoutMs` | no | Give up on a handshake after this long, default 30 000 ms; the microphone prompt does not count. `0` turns it off |
| `logLevel` | no | Console output of the WebRTC layer, default `"warn"`. `"debug"` prints every message of the session, including what was said and tool arguments: only for local debugging |

## Methods

| Method | Does |
|---|---|
| `connect()` | Starts the session. Throws if one is already open or connecting, if the user denies the microphone (the browser's `NotAllowedError`), or if the handshake takes longer than `connectTimeoutMs`. Returns without a session when `disconnect()` comes first |
| `disconnect()` | Ends it; safe to call more than once, also aborts a connect in progress |
| `sendMessage(text)` | Sends a user text message (both modes) |
| `mute()` / `unmute()`, `isMicEnabled` | Microphone on or off |
| `state` | The transport state, e.g. `connecting`, `ready`, `disconnected` |
| `on(event, fn)` / `off(event, fn)` | Subscribe and unsubscribe; both return the client, so calls chain |

Events are listed in [Events and errors](events-and-errors.md).

## Network

- The browser needs a reachable relay (TURN) on networks that block direct UDP. By default the client fetches the dashboard's ICE servers (`/api/token/webrtc/ice-servers`); pass `iceServers` to use your own, for example inside a bank's network.
- If the connection drops, the client does not reconnect the session; it ends with `disconnected`. Start a new one with a fresh token.
- Remote audio plays through a hidden `<audio>` element the client creates.

## Script tag

```html
<script src="freya-agent-sdk.js"></script>
<script>
  const client = new Freya.FreyaClient({ baseUrl, token, mode: "call" });
</script>
```
