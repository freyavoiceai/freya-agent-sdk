# Agent chat over REST

`AgentChat` talks to a Freya agent or workflow one request per turn: no WebRTC, no open socket. Pair it with `FreyaSpeech` for a voice experience on a platform without WebRTC.

```js
import { AgentChat } from "@freya/agent-sdk/agent";

const chat = new AgentChat({
  baseUrl: "https://app.freyavoice.ai",   // or your backend that proxies it
  token: process.env.FREYA_CHAT_KEY,       // a key with calls:chat-message
  workflowId: "<workflow id>",             // or agentId
  workspaceId: "…",                       // optional when the key belongs to one workspace
});

const first = await chat.send("Merhaba", { customerVariables: { customer_name: "Ayşe" } });
console.log(first.reply, first.callId);

const next = await chat.send("Kart borcum ne kadar?");
if (next.ended) console.log("the agent ended the conversation");

await chat.end();
```

## Behaviour

| Step | Request |
|---|---|
| First `send` | `POST /api/v2/chat/message` with `message`, `workflowId` or `agentId`, and `customerVariables` |
| Later `send` | Same endpoint with `message` and the `callId` from the first answer |
| `end()` | `POST /api/v2/chat/end` with the `callId`; does nothing if no call was started |

`send` resolves to `{ reply, callId, messageId, ended }`. `reply` is trimmed; `ended` is true when the agent closed the conversation in that turn.

## Errors and tokens

- A 401 or 403 renews the token (when `token` is a function) and repeats the turn once.
- Any other non-2xx status throws an error with `status` and the service's message. Treat 4xx as "fix the request or ask the user again" and 5xx as "the service failed: retry later or fall back".
- `send(text, { signal })` takes an `AbortSignal` to cancel a turn.

## Where it runs

The key must not reach a user's device. From a mobile or web app set `baseUrl` to your backend, which checks the user's session and adds the key; see [`examples/token-backend.mjs`](../examples/token-backend.mjs).
