# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the public API.

## [Unreleased]

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
- `FreyaClient`: live voice or text session with a Freya agent or workflow over WebRTC (from `freya-dashboard/packages/freya-client` 0.3.0).
- `AgentChat`: turn-by-turn agent conversation over `/api/v2/chat/message` and `/api/v2/chat/end`, with `workflowId` or `agentId`.
- `FreyaSpeech`: speech to text (one request, or live over a WebSocket) and text to speech.
- `SpeechReader`: reads an answer arriving in chunks; reorders, refetches a lost chunk, retries TTS once, splits a long first sentence, estimates word timing, supports barge-in.
- `VoiceActivity`: local speech start and end detection from microphone frames.
- Token renewal on 401 and 403 with one shared refresh for parallel requests.
- Entry points `@freya/agent-sdk`, `/agent` and `/speech`, plus `dist/freya-agent-sdk.js` for a `<script>` tag.
- Guides in `docs/`, examples in `examples/`, TypeDoc API reference via `npm run docs`.
