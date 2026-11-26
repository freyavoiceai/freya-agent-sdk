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
| `Dictation` | Sends PCM frames from your own recorder or a WebView's native microphone as one 16 kHz WAV request to your URL, with caps and retries; no Freya token | REST, to your proxy |
| `ConversationRecorder` | Files a speech-only conversation in the dashboard as a call: transcript and recording | REST, through your backend |

## Install

```bash
npm install --save-exact @freyavoice/agent-sdk
```

Every version is published from this repository's release workflow with npm provenance (`npm audit signatures` checks it). Pin the exact version and update on purpose.

| Entry point | Contains | Use it for |
|---|---|---|
| `@freyavoice/agent-sdk` | everything | web apps |
| `@freyavoice/agent-sdk/agent` | `FreyaClient`, `AgentChat` | agents only |
| `@freyavoice/agent-sdk/speech` | STT, TTS, `SpeechReader`, `VoiceActivity` (no WebRTC dependency, about 25 KB) | React Native, Node |
| `dist/freya-agent-sdk.js` (a file, not an import) | everything, as a `<script>` bundle exposing `window.Freya` | pages without a bundler: copy it from `node_modules/@freyavoice/agent-sdk/dist/` |

The package is ESM only, ships its own TypeScript types and has no runtime dependencies: the WebRTC libraries it uses are bundled, with their licenses in `dist/THIRD_PARTY_NOTICES.txt` and as a CycloneDX SBOM in `dist/sbom.cdx.json`. Node 20 or newer.

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

// Browsers start sound only after a user gesture: unlock the output in the tap handler.
const output = new WebAudioOutput();
await output.unlock();

// Your backend checks the session token and adds the Freya keys; the app never holds them.
const backend = "https://my-backend.example/freya";
const speech = new FreyaSpeech({ token: sessionToken, stt: { url: backend }, tts: { url: backend } });
const chat = new AgentChat({ baseUrl: backend, token: sessionToken, workflowId });

const { text } = await speech.stt.transcribe(recording);
const { reply, ended } = await chat.send(text);
speech.reader(output).push({ text: reply, final: true });
```

## Dictation in a WebView

`Dictation` takes PCM frames (any sample rate, mono or stereo), encodes one 16 kHz mono WAV and posts it to your URL with your headers. It holds no Freya token. In an app whose pages run in a WebView there is no `getUserMedia`: the native app opens the microphone and pushes frames into the page, and `BridgeMic` passes them to `Dictation`. The native side is `MicBridge.kt` (Android) or `MicBridge.swift` (iOS), see [Dictation](docs/dictation.md).

```ts
import { BridgeMic, Dictation, DictationError } from "@freyavoice/agent-sdk/speech";

const mic = new BridgeMic(); // once per page: installs window.freyaMic for the native app

export async function dictate(callId: string, turnId: number) {
  const dictation = new Dictation({
    url: "https://proxy.example/stt",
    headers: async () => ({ Authorization: `Bearer ${await appToken()}`, "X-Call-Id": callId, "X-Turn-Id": String(turnId), "X-Language": "tr" }),
  });
  if (!mic.start(dictation)) return askForMicrophonePermission();
  await waitForRelease();
  await mic.stop();
  try {
    return (await dictation.finish()).text;
  } catch (e) {
    if (e instanceof DictationError) showError(e.code, e.status);
  }
}
```

## Guides

| Guide | Covers |
|---|---|
| [Getting started](docs/getting-started.md) | Environments, `baseUrl`, the parts and when to use which |
| [Tokens and security](docs/tokens-and-security.md) | Which key lives where, short-lived tokens, renewal, a token backend |
| [Voice agent over WebRTC](docs/voice-agent-webrtc.md) | `FreyaClient`: connect, events, mute, text in a call, ICE servers |
| [Agent chat over REST](docs/agent-chat-rest.md) | `AgentChat`: turns, customer variables, ending a call |
| [Speech](docs/speech.md) | STT (REST and live), TTS, voice activity |
| [Dictation](docs/dictation.md) | `Dictation`: PCM frames from your recorder to one WAV request on your proxy, with caps, retries and no Freya token |
| [Reading a chunked answer](docs/reading-chunked-answers.md) | `SpeechReader`: order, lost chunks, retries, word timing, barge-in |
| [Recording a conversation](docs/recording.md) | `ConversationRecorder`: what is stored, sending, the backend route |
| [React Native](docs/react-native.md) | What runs on React Native today and how to wire audio |
| [Android WebView](docs/android-webview.md) | The microphone in a WebView page (https, permission only), or recorded in the app and passed to the page |
| [Events and errors](docs/events-and-errors.md) | Every event and error class, and what to do with each |

Runnable examples are in [`examples/`](examples/). The full API reference is generated from the source with `npm run docs` (output in `docs/api/`).

## Compatibility

| Runtime | `FreyaClient` (WebRTC) | `AgentChat` | Speech, `SpeechReader` |
|---|---|---|---|
| Modern browsers | yes | yes, through your backend | yes |
| React Native | not yet (needs a React Native WebRTC transport) | yes | yes, with `react-native-audio-api` for playback |
| Node 20+ | no | yes | STT and TTS yes; playback needs your own `AudioOutput` |

## Status

The public API may still change before 1.0; every version and change is listed in [CHANGELOG.md](CHANGELOG.md). Planned next: a React Native WebRTC transport, React hooks, client tools (the agent triggers an action in the app), and a disconnect reason on `disconnected`.

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

The agent client (`src/agent/client.ts`, `types.ts`, `native-media-manager.ts`) started as the client the Freya dashboard serves as `/freya-client.js`. Keep the two in step until the dashboard uses this package. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release steps.

## License

Apache-2.0. See [LICENSE](LICENSE).
