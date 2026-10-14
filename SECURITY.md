# Security

## Reporting a problem

Report a suspected vulnerability privately to the Freya engineering team (customers: through your Freya contact), not in an issue or pull request. Include the version, what you saw and how to reproduce it.

## How the SDK handles credentials

- The SDK never needs a long-lived Freya key inside an app. Keys stay on the customer's backend; the app gets an embed token or talks through the backend. See [docs/tokens-and-security.md](docs/tokens-and-security.md).
- Tokens are kept in memory only. The SDK writes nothing to storage and does not log tokens.
- A renewed token replaces the old one for every later request.
- Audio and text go only to the URLs the integrator configures (`baseUrl`, `stt.url`, `tts.url`).

## Supported versions

Only the latest 0.x release receives fixes until 1.0.
