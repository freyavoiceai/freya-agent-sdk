# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the public API.

## [Unreleased]

## [0.3.0] - 2026-10-30

### Added
- `ConversationRecorder`: keeps a speech-only conversation (the customer's dictation, what STT heard, what was sent and whether it was corrected, the answers and both voices) and files it in the dashboard as one call through the import endpoint, with a merged recording the dashboard can play. See [Recording a conversation](docs/recording.md).
- `pcmFromWav()`: 16-bit PCM from WAV bytes.
- `examples/token-backend.mjs`: `/freya/api/v2/call/import`, which checks a recording archive and forwards it with `FREYA_IMPORT_KEY`.

## [0.2.2] - 2026-10-25

### Added
- `dist/sbom.cdx.json`: a CycloneDX SBOM of the bundled third-party code, for scanners that cannot see it as dependencies. It is attached to each GitHub release too.
- `stt.stream()` options `openTimeoutMs` (10 s), `resultTimeoutMs` (15 s after `finish()`) and `maxQueuedBytes` (1 MB).

### Changed
- The release workflow publishes with npm trusted publishing; no npm token is stored.

### Fixed
- Live STT held unlimited audio while the socket opened, waited forever for a socket that never opened or a result that never came, reported one failure twice, reported an error after `cancel()`, and sent frames after `finish()`. An `error` message from the service now ends the stream.
- `SpeechReader` emitted `sentenceEnd` for a sentence stopped before its sound began, with no `sentenceStart`.
- `WebAudioOutput` played nothing on a suspended `AudioContext` while the reader reported each sentence as spoken. It now tries to resume, and otherwise fails the sentence with "Audio is blocked until the user taps".
- `examples/token-backend.mjs`: forwarded the app's multipart form as is (the app could pick the STT model or add a prompt); accepted JSON sent as `text/plain`, which a cross-site page can post with the user's cookie; bound tokens to localhost when `APP_ORIGIN` was missing; sent `Bearer undefined` for a missing key; kept every call id forever (now the last 20 per user, so `end()` still works after the agent ends a call). It keeps the recording's file extension and takes `tr-TR` as `tr`.

## [0.2.1] - 2026-10-25

First version on npm, after a second security and quality review.

### Added
- `FreyaClient` option `connectTimeoutMs` (default 30 s): `connect()` gives up on a handshake that does not finish.
- Published to npm as `@freyavoice/agent-sdk` with provenance; the bundles carry a license banner and the release attaches `THIRD_PARTY_NOTICES.txt`.

### Changed
- `AgentChat` waits up to 75 s for a turn by default (was 30 s), since the dashboard waits up to 70 s for the agent.
- `connect()` returns without a session, instead of throwing, when `disconnect()` comes during the handshake.
- `SpeechReader`: without `fetchMissing`, a lost chunk is skipped after one `gapMs`, as documented (it waited `gapMs × resendTries`). `sentenceSilent` now fires in the sentence's turn. `stop()` stops the output only while this reader is playing.
- A dot after an abbreviation (`Dr.`, `vb.`), an initial, an ordinal (`3. taksit`) or a list number no longer ends a sentence.

### Fixed
- Text with a long run of `.` `!` `?` froze the app: the sentence scan took seconds (minutes for repeated chunks). The scan no longer backtracks, the buffer stays small, and a sentence over 1000 characters is cut at a space.
- `FreyaClient.connect()` never settled when the user denied the microphone; it rejects with the browser's `NotAllowedError` and the client can connect again.
- Hanging up, calling again and hanging up quickly left the second call connected with the microphone open. Hanging up while the browser's microphone prompt is open now also lets the microphone go.
- Requests followed redirects, so a redirecting server could send the voice or a message to another host, even over plain http, and its answer was used. Requests now ask fetch not to follow them, and an answer that came through one is refused (React Native's fetch still follows a redirect before the SDK can refuse it).
- On React Native, `stt.transcribe` with bytes failed with an unclear error; it now says to pass a file reference.
- `SpeechReader` voiced "undefined" for a chunk without text, ran whole-sentence chunks together ("Merhaba.Size nasıl…") and read nothing until the answer ended; asked `fetchMissing` many times for one chunk and waited forever on one that never settled; kept every sentence's audio in memory; dropped a chunk pushed after the end silently; accepted `"1e0"` as a `seq`.
- `AgentChat` lost the conversation the server had started when a first turn failed, so the next message started a second one.
- A token function returning nothing gave a cryptic error (a trailing newline is now trimmed), and a token with invalid characters appeared in the error message. Both throw a `SpeechAuthError` that does not repeat the token.
- Each request left a listener on the caller's `AbortSignal`.
- `VoiceActivity` never detected speech when an option was passed as `undefined`.
- Word timing read a date such as `25.10.2026` as one large number.
- `THIRD_PARTY_NOTICES.txt` lacked the OpenAI MIT license of the wavtools code inside small-webrtc-transport and the BSD-2-Clause text for `@pipecat-ai/client-js`; the build now fails when a bundled package has no license text.
- Install instructions pointed at the git repository.

## [0.2.0] - 2026-10-25

Hardened for the first npm release (security and robustness review).

### Added
- A JWT with `exp` from the token function is renewed shortly before it expires (`renewBeforeMs`, default 60 s), so requests rarely meet a 401.
- `timeoutMs` (default 30 s) on `FreyaSpeech` and `AgentChat`: a request still running after it is aborted with a `TimeoutError`.
- `FreyaClient` option `logLevel` (default `"warn"`).
- `SpeechReader` option `maxAhead` (default 50), and its `error` event now fires for dropped chunks and failed playback.
- `WebAudioOutput.close()`.
- `dist/THIRD_PARTY_NOTICES.txt` with the licenses of the bundled packages.

### Changed
- Licensed under Apache-2.0 (was proprietary).
- The package is now `@freyavoice/agent-sdk` and has no runtime dependencies (Pipecat is bundled, as before; daily-js is no longer in the bundle).
- Service URLs must be `https://`; plain http is refused except for localhost.
- `SpeechHttpError.message` holds only the status; the start of the service's answer moved to `body`.
- `AgentChat` runs turns one after another and throws when an answer has no `callId`.
- Node 20 or newer.

### Fixed
- Text with `<` or `>` used as comparisons ("%3 < %5") is no longer cut out or held back; only real HTML tags are removed.
- A chunk whose `seq` is a numeric string no longer stops the reader after the first sentence.
- A sentence the device fails to play no longer stops the reader silently.
- The WebRTC layer no longer logs the conversation (transcripts, tool arguments) to the console.
- A `disconnected` event from an earlier session no longer clears a newer one, and `disconnect()` during `connect()` no longer leaves a session behind.
- A token that is already due for renewal (very short lifetime, device clock ahead) is no longer renewed on every request.
- Headers passed as a `Headers` object are kept.

## [0.1.0] - 2026-10-14

First internal release.

### Added
- `FreyaClient`: live voice or text session with a Freya agent or workflow over WebRTC (from the dashboard's embedded client 0.3.0).
- `AgentChat`: turn-by-turn agent conversation over `/api/v2/chat/message` and `/api/v2/chat/end`, with `workflowId` or `agentId`.
- `FreyaSpeech`: speech to text (one request, or live over a WebSocket) and text to speech.
- `SpeechReader`: reads an answer arriving in chunks; reorders, refetches a lost chunk, retries TTS once, splits a long first sentence, estimates word timing, supports barge-in.
- `VoiceActivity`: local speech start and end detection from microphone frames.
- Token renewal on 401 and 403 with one shared refresh for parallel requests.
- Entry points `@freya/agent-sdk`, `/agent` and `/speech`, plus `dist/freya-agent-sdk.js` for a `<script>` tag.
- Guides in `docs/`, examples in `examples/`, TypeDoc API reference via `npm run docs`.
