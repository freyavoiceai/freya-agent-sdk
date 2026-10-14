# React Native

## What runs today

| Part | React Native | Needs |
|---|---|---|
| `AgentChat` | yes | `fetch` (built in) |
| `FreyaSpeech.stt.transcribe` | yes | a file reference `{ uri, name, type }` or PCM |
| `FreyaSpeech.stt.stream` | yes | React Native's `WebSocket` (sends the `Authorization` header) |
| `FreyaSpeech.tts`, `SpeechReader` | yes | an `AudioContext` from `react-native-audio-api` for playback |
| `VoiceActivity` | yes | microphone frames from your recorder |
| `FreyaClient` (WebRTC) | not yet | a React Native WebRTC transport, planned |

Import from `@freya/agent-sdk/speech` and `@freya/agent-sdk/agent`; neither pulls in the browser WebRTC code.

## Wiring audio

```tsx
import { AudioContext } from "react-native-audio-api";
import { FreyaSpeech, WebAudioOutput } from "@freya/agent-sdk/speech";

const speech = new FreyaSpeech({ token: ({ refresh }) => api.speechToken(refresh), stt: { url: PROXY }, tts: { url: PROXY } });
const output = new WebAudioOutput({ context: new AudioContext() });

const reader = speech.reader(output);
reader.on("sentenceStart", ({ text }) => setCaption(text));
reader.push({ text: answer, final: true });
```

`react-native-audio-api` mirrors the Web Audio API, so `WebAudioOutput` uses it unchanged. Any other player works if it implements `AudioOutput` (`play(pcm, onStart)` and `stop()`).

## Dictation

```tsx
const { text } = await speech.stt.transcribe({ uri: recordingUri, name: "audio.wav", type: "audio/wav" });
```

## Not verified yet

The React Native paths are covered by unit tests with stand-ins, not yet on a device. Before a release that a customer app depends on, run the example in `examples/react-native-speech.tsx` on iOS and Android.
