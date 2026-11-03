# Android WebView

A page in an Android WebView gets the microphone only when both are true:

| Needs | Why |
|---|---|
| The page is served over `https://` (or `http://localhost`) | On `http://` or `file://` the WebView has no `navigator.mediaDevices` at all |
| The app has `RECORD_AUDIO` and grants the page's request in `WebChromeClient.onPermissionRequest` | Without it `getUserMedia` is refused |

While developing against `http://<your ip>`, either run `adb reverse tcp:3000 tcp:3000` and load `http://localhost:3000`, or record in the app instead.

## Microphone in the page (https)

On `https` the SDK opens the microphone itself with `getUserMedia`, as in a browser. The app only handles the permission, with no Freya-specific code, so any other web page in the same WebView can use it too.

[`MainActivity.kt`](../examples/android-webview-permission/MainActivity.kt): when the page asks for the microphone, the app shows Android's permission dialog the first time and then grants the page's request.

```kotlin
webView.webChromeClient = object : WebChromeClient() {
    override fun onPermissionRequest(request: PermissionRequest) {
        // RECORD_AUDIO granted: request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        // not yet: ask with RequestPermission, then grant or deny
    }
}
```

`AndroidManifest.xml` needs `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. The page code is the same as in a browser.

## Recording in the app

The speech APIs take audio from anywhere, so the app can keep the microphone and pass it to the page. The page then needs neither `https` nor a WebView permission.

| File | Does |
|---|---|
| [`MicBridge.kt`](../examples/android-webview-mic/MicBridge.kt) | Records 16 kHz mono PCM with `AudioRecord` and calls `window.freyaMic.onFrame(base64)` every 50 ms |
| [`native-mic.js`](../examples/android-webview-mic/native-mic.js) | Page side: `start()`, `stop()` (the whole recording as PCM), `onFrame()` for each 50 ms frame |
| [`usage.js`](../examples/android-webview-mic/usage.js) | Push to talk: the level for an animation from `VoiceActivity`, then `stt.transcribe` |

```kotlin
webView.settings.javaScriptEnabled = true
webView.addJavascriptInterface(MicBridge(webView), "FreyaMicNative")
```

`AndroidManifest.xml` needs `<uses-permission android:name="android.permission.RECORD_AUDIO" />`, asked at runtime before the first recording. If the app already has its own start and stop bridge, keep it: only the frames reaching `window.freyaMic.onFrame` matter.

`VoiceActivity` does not open the microphone; it reads the frames it is given, so its `level` and `speechStart` events work the same with the app's frames.

## Steps

1. In the page: `npm install --save-exact @freyavoice/agent-sdk`, and copy `native-mic.js` next to your code.
2. In the app: copy `MicBridge.kt`, change its `package` line to your app's package, add the `RECORD_AUDIO` permission, and register it with `addJavascriptInterface` as above.
3. In the page: on press call `mic.start()`, on release `await mic.stop()` and pass the PCM to `speech.stt.transcribe`, as in `usage.js`. The token and STT/TTS URLs are the same as in a browser.
4. Load the page in the WebView (`http://` works) and hold the button. If `mic.start()` returns `false`, the app has no microphone permission yet.

## Tested

On an Android 15 phone, in a small WebView app:

- With `MicBridge.kt`: frames reached the page, the `VoiceActivity` level moved, and the recording was transcribed.
- With the permission-only `MainActivity.kt`, page on `http://localhost` (a secure origin, like `https`): Android's permission dialog appeared on the first press, then the page opened the microphone and the recording was transcribed.
