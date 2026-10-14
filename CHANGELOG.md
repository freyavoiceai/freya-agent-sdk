# Changelog

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/); before 1.0 a minor version may change the public API.

## [Unreleased]

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
