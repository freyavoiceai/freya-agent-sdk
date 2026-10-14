# Speech: STT, TTS and voice activity

```js
import { FreyaSpeech } from "@freya/agent-sdk/speech";

const speech = new FreyaSpeech({
  token: ({ refresh }) => getSpeechToken(refresh),     // see tokens-and-security.md
  stt: { url: "https://stt.freyavoice.ai", language: "tr" },
  tts: { url: "https://tts.freyavoice.ai", voice: "zeynep" },
});
speech.on("tokenRefresh", () => console.log("renewing the speech token"));
```

| Option | Default | Meaning |
|---|---|---|
| `token` | required | String, or a function called again with `{ refresh: true }` after 401/403 |
| `stt.url`, `tts.url` | Freya cloud | Service root without `/v1`; point at your proxy in production |
| `stt.model`, `stt.language` | `freya-stt`, `tr` | |
| `tts.model`, `tts.voice`, `tts.sampleRate` | `freya-tts`, `zeynep`, `48000` | `sampleRate` is the rate of the PCM the service returns |
| `fetch` | global `fetch` | Inject one, e.g. `expo/fetch` |
| `renewOn` | `[401, 403]` | Statuses that renew the token and repeat the request once |

## Speech to text, one recording

```js
const { text, language, duration } = await speech.stt.transcribe(recording);
```

`recording` can be a `Blob`, `ArrayBuffer`, `Uint8Array` (a WAV file), `{ samples: Int16Array, sampleRate }` (raw PCM, wrapped as WAV for you), or on React Native a file reference `{ uri, name, type }`.

## Speech to text, live

```js
const stream = await speech.stt.stream({ sampleRate: 16000 });
stream.on("partial", ({ text, final }) => showDraft(text));
stream.on("result", ({ text }) => submit(text));
stream.on("error", ({ message }) => showError(message));

mic.onFrame((int16) => stream.send(int16));   // 16-bit mono PCM at sampleRate
stopButton.onclick = () => stream.finish();    // the service sends the result, then closes
cancelButton.onclick = () => stream.cancel();
```

- Frames sent before the socket opens are queued.
- The token goes in an `Authorization` header, which React Native and Node support and browsers do not; from a browser, point `stt.url` at a proxy. You can also pass `createWebSocket(url, headers)` to build the socket yourself.

## Text to speech

```js
const pcm = await speech.tts.synthesize("Bonus kartınızın dönem borcu dört bin iki yüz elli lira.");
// pcm: { samples: Int16Array, sampleRate }
await new WebAudioOutput().play(pcm, () => console.log("sound started"));
```

Errors throw `SpeechHttpError` (`status`, message) or, after a failed renewal, `SpeechAuthError`.

## Voice activity

```js
import { VoiceActivity } from "@freya/agent-sdk/speech";

const vad = new VoiceActivity({ startMs: 120, stopMs: 700 });
vad.on("speechStart", () => bargeIn());
vad.on("speechEnd", ({ duration }) => maybeSubmit(duration));
vad.on("level", ({ rms }) => drawLevel(rms));
mic.onFrame((frame) => vad.push(frame, 16000));
```

It compares each frame's energy with an adaptive noise floor. Options: `startMs` (speech this long starts speaking), `stopMs` (silence this long ends it), `minLevel`, `ratio`. `reset()` clears its state.

## Text helpers

| Function | Does |
|---|---|
| `cleanText(text)` | Drops HTML tags, `*` markers and double spaces that TTS would otherwise read |
| `new SentenceAssembler()` | `feed(text)` returns whole sentences as they complete, `flush()` the rest; a period followed by a space ends a sentence, so `30.000` stays whole |
| `firstCut(text)` | Splits a long first sentence at its first comma, so its head can be voiced sooner |
| `wordTimings(text, pcm)` | Estimated start and end of each word in a clip (Freya TTS returns no word times) |
