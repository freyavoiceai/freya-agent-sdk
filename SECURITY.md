# Security

## Reporting a problem

Report a suspected vulnerability privately, not in an issue or pull request: open a report at https://github.com/freyavoiceai/freya-agent-sdk/security/advisories/new (customers can also go through their Freya contact). Include the version, what you saw and how to reproduce it.

## How the SDK handles credentials

- The SDK never needs a long-lived Freya key inside an app. Keys stay on the customer's backend; the app gets an embed token or talks through the backend. See [docs/tokens-and-security.md](docs/tokens-and-security.md).
- Tokens are kept in memory only. The SDK writes nothing to storage and does not log tokens.
- A renewed token replaces the old one for every later request.
- Audio and text go only to the URLs the integrator configures (`baseUrl`, `stt.url`, `tts.url`): they must be https (plain http only to this machine). Requests ask fetch not to follow redirects, and an answer that came through one is refused. React Native's fetch follows redirects before the SDK sees the answer, so make sure the services and your proxy do not redirect.

## Releases

Every npm version is built and published by this repository's release workflow after a maintainer approves it, with npm provenance. `npm audit signatures` verifies it. The package has no runtime dependencies; the third-party code it bundles is listed with its licenses in `dist/THIRD_PARTY_NOTICES.txt`.

## Supported versions

Only the latest 0.x release receives fixes until 1.0.
