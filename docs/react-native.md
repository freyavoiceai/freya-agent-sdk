# React Native

## What runs today

| Part | React Native | Needs |
|---|---|---|
| `AgentChat` | yes | `fetch` (built in) |
| `FreyaSpeech.stt.transcribe` | yes | a file reference `{ uri, name, type }`. React Native cannot build a `Blob` from bytes, so save PCM or WAV to a file first (`wavFromPcm` makes the WAV bytes) |
| `FreyaSpeech.stt.stream` | yes | React Native's `WebSocket` (sends the `Authorization` header) |
| `FreyaSpeech.tts`, `SpeechReader` | yes | an `AudioContext` from `react-native-audio-api` for playback |
| `VoiceActivity` | yes | microphone frames from your recorder |
| `FreyaClient` (WebRTC) | not yet | a React Native WebRTC transport, planned |

Import speech from `@freyavoice/agent-sdk/speech`, which has no WebRTC code. `@freyavoice/agent-sdk/agent` also carries the browser WebRTC client (about 350 KB) even when you use only `AgentChat`; it imports without running it.

## Wiring audio

```tsx
import { AudioContext } from "react-native-audio-api";
import { FreyaSpeech, WebAudioOutput } from "@freyavoice/agent-sdk/speech";

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
