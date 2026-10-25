# Reading a chunked answer

An answer often arrives in parts: from a chat model's stream, an MQTT topic, a bank's own bot. `SpeechReader` takes every part through one input and reads the answer aloud sentence by sentence, in order, while it is still arriving.

```js
import { FreyaSpeech, WebAudioOutput } from "@freyavoice/agent-sdk";

const output = new WebAudioOutput();
await output.unlock();                       // from a tap: browsers allow audio only after a gesture

const reader = speech.reader(output, {
  groupSize: 1,
  fetchMissing: (seq, signal) => answers.getChunk(turnId, seq, { signal }),
});

reader.on("sentenceStart", ({ index, text, words }) => showReading(index, text, words));
reader.on("word", ({ index, wordIndex }) => highlight(index, wordIndex));
reader.on("sentenceSilent", ({ index, text }) => showWithoutSound(index, text));
reader.on("done", (summary) => log(summary));

mqtt.on("message", (m) => reader.push({ seq: m.seq, text: m.text, final: m.final }));
// the user starts speaking: reader.stop()
```

## What it handles

| Problem | What the reader does | Event |
|---|---|---|
| A chunk arrives after a later one | Holds the later one until the gap is filled | `chunk` with `state: "held"` or `"late"` |
| A chunk never arrives | After `gapMs` calls `fetchMissing(seq)`, up to `resendTries` times, then skips it | `chunkMissing`, `chunkRecovered`, `chunkSkipped` |
| The same chunk twice | Ignores the repeat | `chunk` with `state: "duplicate"` |
| A long first sentence | Voices its head up to the first comma on its own, so sound starts sooner (`splitFirst`) | `sentenceQueued` |
| TTS fails for a sentence | Tries once more, then shows the text without sound and goes on | `sentenceSilent` |
| The device will not play a sentence | Shows the text without sound and goes on | `error`, `sentenceSilent` |
| A `seq` that is not a whole number, or more than `maxAhead` past the next expected chunk | Drops the chunk | `error` |
| The token expires mid-answer | Renews it and repeats that sentence's request | `tokenRefresh` on `FreyaSpeech` |
| The user interrupts | `stop()` cancels requests in flight, drops what is left and stops the sound | `sentenceEnd` with `interrupted: true` |

## Options

| Option | Default | Meaning |
|---|---|---|
| `groupSize` | 1 | Sentences per TTS request. 1 starts sound soonest; 2 or 3 makes fewer requests |
| `parallel` | 2 | TTS requests in flight; more makes the first sentence wait |
| `splitFirst` | true | Voice a long first sentence's head separately |
| `gapMs` | 1200 | How long a missing chunk is waited for before it is asked for again |
| `resendTries` | 3 | Attempts for a missing chunk before it is skipped |
| `maxAhead` | 50 | How far past the next expected chunk a chunk may be held |
| `fetchMissing` | none | `(seq, signal) => Promise<Chunk>`; without it a gap is skipped after `gapMs` |
| `voice` | the TTS default | Voice for this answer |

## Input

`push({ seq?, text, final? })`: `seq` counts from 0; leave it out when the source is already in order. A whole-number string such as `"3"` counts as 3. `final: true` marks the last chunk. `end(parts)` tells the reader how many chunks there were when the source reports that separately.

## Summary

`done` carries `{ chunks, sentences, late, lost, skipped, silent }`, useful for monitoring how often the network reorders or drops parts.

## Word timing

Freya TTS returns no word times. `sentenceStart.words` are estimated from each word's syllables and the pauses found in the audio, good enough to highlight the word being spoken; do not use them for anything that needs exact timing.
