# Recording a conversation

`ConversationRecorder` keeps one conversation that runs on `FreyaSpeech` (your own assistant answers, Freya turns speech into text and text into speech) and files it in the Freya dashboard as a call when it ends: the transcript, what the customer sent and whether they corrected it, and one recording with both voices.

The voice agent records its own calls (`FreyaClient`), and `AgentChat` conversations are kept as text by the dashboard. This is for the speech-only path, where neither is in the loop.

```js
import { ConversationRecorder, FreyaSpeech, WebAudioOutput } from "@freyavoice/agent-sdk/speech";

const speech = new FreyaSpeech({ token, stt: { url: backend }, tts: { url: backend } });
const rec = new ConversationRecorder({ url: `${backend}/api/v2/call/import`, token });
const reader = speech.reader(rec.output(new WebAudioOutput()));   // what is played is recorded

const { text } = await speech.stt.transcribe(pcm);
rec.user(pcm, text);            // the customer's voice and what STT heard
rec.sent(textTheySent);         // what they sent, maybe corrected; for typed messages call only this
rec.bot(answer);                // the answer read back
reader.push({ text: answer, final: true });

// when the conversation is over
rec.end();
await rec.send();
```

## What is stored

| Field | Value |
|---|---|
| Call | One call of type `web`, status `ended`, the time it started and ended, `customerNumber` and `externalCallId` if given |
| Transcript | `User:` and `AI:` lines in time order |
| Messages | Each turn with its time; a customer turn also carries `heard` (what STT heard) and `edited`, or `typed: true`, or `sent: false` for dictation never sent |
| Recording | `recordings/<callId>.wav`: both voices on one timeline, 16 kHz mono, which the dashboard plays. `tracks: true` adds `_user` and `_assistant` files |
| Metadata | Your `metadata` plus `source: "freya-agent-sdk"` |

Audio goes in as PCM (`{ samples, sampleRate }`) or the bytes of a 16-bit WAV file. On React Native the SDK cannot read a file from its `uri`: read the recording's bytes and pass them.

## Sending

`send()` makes one request and resolves to the import result (`created`, `skipped`, `failed`, `errors`).

| Outcome | What it means |
|---|---|
| resolves | The call is in the dashboard (`skipped: 1` if an earlier attempt got through) |
| `RecordingError`, `reason: "rejected"` | No call was created. Fix the cause and call `send()` again: the same call is sent |
| `RecordingError`, `reason: "audio-lost"` | The call exists without its audio. Sending again does not add it |
| `RecordingError`, `reason: "too-large"` | Over the dashboard's 50 MB limit (about 25 minutes of audio with `tracks: false`); not sent |
| `SpeechHttpError` | Your backend or the dashboard answered with an error status |

Nothing is written to the device. If the app must survive a restart before sending, save `rec.archive()` yourself.

## Where it goes

The import endpoint needs a key with `calls:import`, which can also write agents and workflows. It must stay on your backend: point `url` at a route there that checks the session, checks the archive and forwards it. [`examples/token-backend.mjs`](../examples/token-backend.mjs) has one (`/freya/api/v2/call/import`): it accepts only `calls.json` with one web call and that call's WAV files, under the session's customer number. Use a workspace that holds nothing but these recordings.

`format: "zip"` sends the archive itself as `application/zip` instead of a form, for React Native, which cannot put bytes in a form; the example backend takes both.
