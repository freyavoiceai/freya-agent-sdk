// Imports the built bundles the way a consumer would and checks their public exports.
import assert from "node:assert/strict";

const speech = await import("../dist/speech.mjs");
for (const name of ["FreyaSpeech", "SpeechReader", "WebAudioOutput", "VoiceActivity", "SpeechAuthError", "SpeechHttpError", "wavFromPcm", "wordTimings"]) {
  assert.ok(speech[name], `speech bundle is missing ${name}`);
}
const s = new speech.FreyaSpeech({ token: "t" });
assert.equal(s.stt.url, "https://stt.freyavoice.ai");
assert.equal(s.tts.url, "https://tts.freyavoice.ai");
assert.equal(speech.wavFromPcm({ samples: new Int16Array(4), sampleRate: 16000 }).length, 52);

// the agent bundle carries the WebRTC client, which needs browser APIs only once it connects
const agent = await import("../dist/agent.mjs");
for (const name of ["FreyaClient", "FreyaEvent", "AgentChat"]) assert.ok(agent[name], `agent bundle is missing ${name}`);
assert.equal(agent.FreyaEvent.BotOutput, "botOutput");

console.log("smoke ok");
