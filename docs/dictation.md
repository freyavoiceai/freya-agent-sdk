# Dictation: your recorder, one request to your proxy

`Dictation` turns PCM frames from the app's own recorder into one WAV request. It does no capture, so it runs in a WebView, React Native, browsers and Node, and it holds no Freya token: the URL and the headers are yours.

```ts
import { Dictation } from "@freyavoice/agent-sdk/speech";

const dictation = new Dictation({
  url: "https://proxy.example/stt",
  headers: async ({ attempt }) => ({
    Authorization: `Bearer ${await appToken()}`,
    "X-Call-Id": sessionId,
    "X-Turn-Id": String(turnId),
    "X-Language": "tr",
  }),
});

recorder.onFrame((pcm, sampleRate) => {
  if (!dictation.push(pcm, sampleRate)) recorder.stop();
});
const { text } = await dictation.finish();
```

Make a new `Dictation` for every dictation.

## What it sends

- Frames: `Int16Array` or `Float32Array` (-1 to 1), any sample rate, interleaved mono or stereo (`push(samples, sampleRate, channels = 1)`). The sample rate must stay the same within one dictation.
- The body is one 16 kHz mono 16-bit WAV (RIFF), `Content-Type: audio/wav`, sent as raw bytes with `POST`. Your `headers` function adds the rest.
- `headers` runs before every attempt, so renew an expired token there. A retry sends the same bytes. Do not advance a turn counter inside `headers`: it runs again on a retry. Read the turn number before `finish()`.
- No audio or text goes to a log. The `attempt` event reports the attempt number, the status and the time only.

## Length cap

A dictation is one request of at most `maxSeconds` (default 20, never above 30 s or 2 MB). `onLimit` decides what happens to audio past the cap:

| `onLimit` | Behaviour |
|---|---|
| `"stop"` (default) | `push` keeps the first `maxSeconds`, ignores the rest, emits `limit` and returns `false`. `finish()` sends what was kept. Stop your recorder when `push` returns `false`. |
| `"reject"` | The `push` that crosses the cap throws `DictationError` with `code: "too_long"`, `finish()` rejects with it, and nothing is sent. |

## Retries and timeout

| Answer | Behaviour |
|---|---|
| 429 | Waits `Retry-After` (seconds or an HTTP date), up to 3 retries. A wait over `maxRetryAfterMs` (30 s) fails at once with `retryAfterMs` set. |
| 503, 504 | Up to 3 retries, backoff 0.5 s, 1 s, 2 s with jitter. |
| 500 | One retry. |
| 400, 401, 409, 413, others | Never retried. |
| No answer in 15 s (`timeoutMs`) | The attempt is aborted and fails with `code: "timeout"`; not retried. A network failure fails with `code: "network"`. |

Change the counts with `retry: { rateLimit, unavailable, internal, backoffMs, maxRetryAfterMs }`.

## Results and errors

`finish()` resolves with `{ callId, turnId, text, language, audioDurationMs, raw }` from the response JSON (`raw` is the whole body). An empty `text` with status 200 is a normal result.

It rejects with `DictationError` (a `SpeechHttpError`): `status` (0 when no answer came), `code` (the service's `error` value such as `busy` or `turn_conflict`, or `too_long`, `no_audio`, `timeout`, `network`, `headers`, `invalid_response`, `cancelled`), `attempts` and `retryAfterMs`. The message never carries the response body. The same events fire for apps that prefer them: `transcript`, `error`, `attempt`, `limit`.

`cancel()` aborts the request in flight and any retry wait; `finish()` then rejects with `cancelled`.

## Transport

`transport` defaults to `fetch`. Replace it to use another stack, for instance multipart, without changing the rest:

```ts
new Dictation({
  url,
  transport: async ({ url, headers, body, signal }) => fetch(url, { method: "POST", headers, body, signal }),
});
```

It returns anything with `status`, `headers.get()` and `text()`. A `fetch` `Response` fits. On React Native check that your `fetch` accepts a `Uint8Array` body; if not, pass a transport that wraps it (for example `expo/fetch`).

## WebView with a native microphone

When the page runs inside a native app's WebView there is no `navigator.mediaDevices`; the app opens the microphone and pushes frames into the page. This is the bridge from [Android WebView](android-webview.md), unchanged: the app calls `window.freyaMic.onFrame(base64)` with 16 kHz mono little-endian Int16 frames and `window.freyaMic.onEnd()` after stop. `BridgeMic` installs those two functions and starts and stops the app's microphone.

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

| Native side | File | Control from the page |
|---|---|---|
| Android | [`MicBridge.kt`](../examples/android-webview-mic/MicBridge.kt) | `window.FreyaMicNative.start()` (false without `RECORD_AUDIO`) and `.stop()`, registered with `addJavascriptInterface` |
| iOS | [`MicBridge.swift`](../examples/ios-webview-mic/MicBridge.swift) | `webkit.messageHandlers.FreyaMicNative.postMessage({ command: "start" \| "stop" })` |

`BridgeMic` uses `FreyaMicNative` when the page has it and the iOS message handler otherwise. `start(dictation)` returns false when Android refuses the microphone. On iOS `start` cannot return the answer, so a refused permission arrives as `onEnd` with no frames and `finish()` rejects with `no_audio`. `bridge.onFrame(fn)` gives the same frames to `VoiceActivity` for a level meter. When the dictation reaches its cap the native microphone is stopped for you.

iOS notes. The app needs `NSMicrophoneUsageDescription` in Info.plist and asks with `requestRecordPermission` before the first recording. `AVAudioSession` uses `.playAndRecord` so replies can still play, with mode `.measurement` to avoid voice processing; set `.voiceChat` instead if you want echo cancellation. The tap delivers the hardware rate (44.1 or 48 kHz) and `AVAudioConverter` converts it to 16 kHz mono Int16 before sending. The iOS example has not been tested on a device yet; the Android one has (see the Android WebView guide).
