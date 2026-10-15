# Getting started

## The pieces

```
your app ──────────────▶ your backend ──────────────▶ Freya
 (browser, RN, Node)     holds the Freya keys         dashboard: agents, workflows, calls
                         mints short-lived tokens      speech: STT and TTS
```

The app never holds a long-lived Freya key. It talks to Freya with a short-lived token, or through your backend. See [Tokens and security](tokens-and-security.md).

## Which part to use

| You want | Use | Notes |
|---|---|---|
| A live voice call with an agent in a web page | `FreyaClient`, `mode: "call"` | Lowest latency; the agent hears and speaks over WebRTC |
| A text chat with an agent in a web page | `FreyaClient`, `mode: "chat"` | Same connection, no microphone |
| An agent turn per request, no WebRTC | `AgentChat` | Runs on a server, or in an app through your backend |
| Dictation: the user speaks, text appears | `FreyaSpeech.stt` | One request per recording, or live over a WebSocket |
| An answer from somewhere else read aloud | `FreyaSpeech.reader()` | Chunks in any order, sentence by sentence |
| Know when the user starts or stops speaking | `VoiceActivity` | Runs locally on the frames you capture |

## Environments

Every part takes its server as a parameter, so the same code runs against any Freya environment, including an on-premises install.

| Part | Option | Default | Example |
|---|---|---|---|
| `FreyaClient` | `baseUrl` | none | `https://app.freyavoice.ai`, `https://tr-app.freyavoice.ai` |
| `AgentChat` | `baseUrl` | none | the dashboard, or your backend that proxies it |
| `FreyaSpeech` | `stt.url`, `tts.url` | `https://stt.freyavoice.ai`, `https://tts.freyavoice.ai` | your backend's speech proxy |

A token is only valid on the environment that issued it.

## First run

```bash
npm install github:freyavoiceai/freya-agent-sdk
```

```js
import { FreyaSpeech } from "@freya/agent-sdk/speech";

const speech = new FreyaSpeech({ token: process.env.FREYA_SPEECH_TOKEN });
const pcm = await speech.tts.synthesize("Merhaba, size nasıl yardımcı olabilirim?");
console.log(pcm.samples.length / pcm.sampleRate, "seconds of audio");
```

Next: [Tokens and security](tokens-and-security.md).
