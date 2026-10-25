# Freya Agent SDK

`@freyavoice/agent-sdk` is the TypeScript SDK for Freya voice AI agents. One package covers web, React Native and Node.

| Part | What it does | Transport |
|---|---|---|
| `FreyaClient` | Live voice or text conversation with a Freya agent or workflow | WebRTC |
| `AgentChat` | Text conversation with a Freya agent or workflow, one request per turn | REST |
| `FreyaSpeech.stt` | Speech to text: a recording in, its text out, or live over a WebSocket | REST, WebSocket |
| `FreyaSpeech.tts` | Text to speech | REST |
| `SpeechReader` | Reads an answer aloud as it arrives in chunks: orders them, recovers a lost one, plays sentence by sentence | REST |
| `VoiceActivity` | "The user is speaking" from microphone frames | local |

## Install

The package is not on npm yet. Install it from the GitHub repository; it builds on install:

```bash
npm install github:freyavoiceai/freya-agent-sdk
```

Once versions are tagged, pin one with `#v<x.y.z>` at the end.

| Entry point | Contains | Use it for |
|---|---|---|
| `@freyavoice/agent-sdk` | everything | web apps |
| `@freyavoice/agent-sdk/agent` | `FreyaClient`, `AgentChat` | agents only |
| `@freyavoice/agent-sdk/speech` | STT, TTS, `SpeechReader`, `VoiceActivity` (no WebRTC dependency, about 25 KB) | React Native, Node |
| `dist/freya-agent-sdk.js` (a file, not an import) | everything, as a `<script>` bundle exposing `window.Freya` | pages without a bundler: copy it from `node_modules/@freyavoice/agent-sdk/dist/` |

The package is ESM only, ships its own TypeScript types and has no runtime dependencies: the WebRTC libraries it uses are bundled, with their licenses in `dist/THIRD_PARTY_NOTICES.txt`. Node 20 or newer.

## Quick start

A voice agent in the browser over WebRTC. Your backend mints the embed token ([tokens](docs/tokens-and-security.md)):

```js
import { FreyaClient, FreyaEvent } from "@freyavoice/agent-sdk";

const { token } = await fetch("/my-backend/freya-token").then((r) => r.json());
const client = new FreyaClient({ baseUrl: "https://app.freyavoice.ai", token, mode: "call" });
client.on(FreyaEvent.BotOutput, ({ text, spoken }) => spoken && showCaption(text));
client.on(FreyaEvent.Error, ({ message, fatal }) => fatal && showError(message));
await client.connect();
// later: client.mute(), client.sendMessage("..."), await client.disconnect()
```

The same agent without WebRTC: speech to text, one REST turn, the answer read aloud:

```js
import { AgentChat, FreyaSpeech, WebAudioOutput } from "@freyavoice/agent-sdk";

// Your backend checks the session token and adds the Freya keys; the app never holds them.
const backend = "https://my-backend.example/freya";
const speech = new FreyaSpeech({ token: sessionToken, stt: { url: backend }, tts: { url: backend } });
const chat = new AgentChat({ baseUrl: backend, token: sessionToken, workflowId });

const { text } = await speech.stt.transcribe(recording);
const { reply, ended } = await chat.send(text);
speech.reader(new WebAudioOutput()).push({ text: reply, final: true });
```

## Guides

| Guide | Covers |
|---|---|
| [Getting started](docs/getting-started.md) | Environments, `baseUrl`, the parts and when to use which |
| [Tokens and security](docs/tokens-and-security.md) | Which key lives where, short-lived tokens, renewal, a token backend |
| [Voice agent over WebRTC](docs/voice-agent-webrtc.md) | `FreyaClient`: connect, events, mute, text in a call, ICE servers |
| [Agent chat over REST](docs/agent-chat-rest.md) | `AgentChat`: turns, customer variables, ending a call |
| [Speech](docs/speech.md) | STT (REST and live), TTS, voice activity |
| [Reading a chunked answer](docs/reading-chunked-answers.md) | `SpeechReader`: order, lost chunks, retries, word timing, barge-in |
| [React Native](docs/react-native.md) | What runs on React Native today and how to wire audio |
| [Events and errors](docs/events-and-errors.md) | Every event and error class, and what to do with each |

Runnable examples are in [`examples/`](examples/). The full API reference is generated from the source with `npm run docs` (output in `docs/api/`).

## Compatibility

| Runtime | `FreyaClient` (WebRTC) | `AgentChat` | Speech, `SpeechReader` |
|---|---|---|---|
| Modern browsers | yes | yes, through your backend | yes |
| React Native | not yet (needs a React Native WebRTC transport) | yes | yes, with `react-native-audio-api` for playback |
| Node 20+ | no | yes | STT and TTS yes; playback needs your own `AudioOutput` |

## Status

Version 0.2.0. The public API may still change before 1.0; every change is listed in [CHANGELOG.md](CHANGELOG.md). Planned next: a React Native WebRTC transport, React hooks, client tools (the agent triggers an action in the app), and a disconnect reason on `disconnected`.

## Development

```bash
npm install
npm run verify   # lint, typecheck, tests with coverage, build, smoke test, package checks
```

| Script | Does |
|---|---|
| `npm run build` | Bundles `dist/` with esbuild and writes type declarations with tsc |
| `npm test` / `npm run test:coverage` | Vitest (jsdom) |
| `npm run lint` | ESLint with typescript-eslint |
| `npm run smoke` | Imports the built speech and agent bundles in Node and checks their exports |
| `npm run check:package` | publint and Are The Types Wrong on the packed package |
| `npm run docs` | TypeDoc API reference into `docs/api/` |

The agent client (`src/agent/client.ts`, `types.ts`, `native-media-manager.ts`) was copied from `freya-dashboard/packages/freya-client`, which the dashboard still serves as `/freya-client.js`. Keep the two in step until the dashboard uses this package. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release steps.

## License

Apache-2.0. See [LICENSE](LICENSE).
