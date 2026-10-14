// A text conversation with a Freya workflow from Node, then the last answer saved as speech.
// Environment: FREYA_BASE_URL, FREYA_CHAT_KEY, FREYA_WORKFLOW_ID, optional FREYA_SPEECH_KEY.
// Run after `npm run build`: node examples/node-agent-chat.mjs
import { writeFileSync } from "node:fs";
import { AgentChat } from "../dist/agent.mjs";
import { FreyaSpeech, wavFromPcm } from "../dist/speech.mjs";

const chat = new AgentChat({
  baseUrl: process.env.FREYA_BASE_URL ?? "https://app.freyavoice.ai",
  token: process.env.FREYA_CHAT_KEY,
  workflowId: process.env.FREYA_WORKFLOW_ID,
});

let last = "";
for (const message of ["Merhaba", "Kartlarım neler?"]) {
  const turn = await chat.send(message);
  console.log(`> ${message}\n< ${turn.reply}`);
  last = turn.reply;
  if (turn.ended) break;
}
await chat.end();

if (process.env.FREYA_SPEECH_KEY) {
  const speech = new FreyaSpeech({ token: process.env.FREYA_SPEECH_KEY });
  writeFileSync("answer.wav", wavFromPcm(await speech.tts.synthesize(last)));
  console.log("wrote answer.wav");
}
