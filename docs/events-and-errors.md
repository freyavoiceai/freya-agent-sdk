# Events and errors

## FreyaClient (WebRTC)

Subscribe with `client.on(FreyaEvent.X, fn)` and unsubscribe with `client.off(FreyaEvent.X, fn)`.

| Event | Payload | When |
|---|---|---|
| `stateChanged` | transport state | The connection state changes |
| `botReady` | none | The agent is ready to talk |
| `userStartedSpeaking` / `userStoppedSpeaking` | none | The agent's voice detection heard the user start or stop |
| `userTranscript` | `{ text, final }` | Partial and final user transcripts |
| `botLlmStarted` / `botLlmText` / `botLlmStopped` | `{ text }` for text | The agent's model is writing an answer |
| `botMessage` | `{ text }` | The full answer, once per turn |
| `botTranscript` | `{ text }` | The answer sentence by sentence |
| `botOutput` | `{ text, spoken }` | Each spoken piece; use it for captions in sync with the voice |
| `botStartedSpeaking` / `botStoppedSpeaking` | none | The agent's voice starts or stops |
| `trackStarted` / `trackStopped` | `MediaStreamTrack` | Remote audio track |
| `toolCallStarted` / `toolCallInProgress` / `toolCallStopped` | `{ function_name, tool_call_id, arguments? }` | The agent calls a tool |
| `error` | `{ message, fatal }` | Something failed; `fatal: true` means the session cannot continue |
| `disconnected` | none | The session ended, for any reason |

## FreyaSpeech, SttStream, SpeechReader, VoiceActivity

Subscribe with `.on(name, fn)`; it returns a function that unsubscribes.

| Emitter | Events |
|---|---|
| `FreyaSpeech` | `tokenRefresh` |
| `SttStream` | `open`, `partial { text, final }`, `result { text }`, `error { message }`, `close` |
| `SpeechReader` | `chunk`, `chunkMissing`, `chunkRecovered`, `chunkSkipped`, `sentenceQueued`, `sentenceStart`, `word`, `sentenceEnd`, `sentenceSilent`, `done`, `error` |
| `VoiceActivity` | `speechStart`, `speechEnd`, `level` |

A listener that throws is logged and does not stop the emitter.

## Errors

| Error | From | Has | Meaning |
|---|---|---|---|
| `SpeechHttpError` | speech, `AgentChat` | `status`, `body` | A failed status; 401 or 403 means it still failed after one renewal. `body` holds the start of the service's answer, kept out of `message` |
| `Error` named `TimeoutError` | any request | | No answer within `timeoutMs` (default 30 s) |
| `Error("… must be an https:// URL …")` | constructors | | A plain http URL other than localhost |
| `Error("Agent chat: the answer has no callId")` | `AgentChat.send` | | The dashboard answered without a call id |
| `Error("Already connected…")` | `FreyaClient.connect` | | Call `disconnect()` first |

## Handling them

| Status | Do |
|---|---|
| 400, 404, 422 | A wrong request: fix the input, or ask the user again |
| 401, 403 | Renewed automatically once; if it still fails, the token source or the key's permissions are wrong |
| 402 | The workspace is out of credit; show a friendly message |
| 429 | Back off and retry later |
| 5xx | The service failed: retry later, or fall back (text without sound, a human agent) |
