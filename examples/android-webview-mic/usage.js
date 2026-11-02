// Push to talk in a page inside an Android WebView, with the app's microphone (MicBridge.kt).
import { FreyaSpeech, VoiceActivity } from "@freyavoice/agent-sdk/speech";
import { nativeMic } from "./native-mic.js";

const speech = new FreyaSpeech({ token: () => api.speechToken(), stt: { url: PROXY, language: "tr" }, tts: { url: PROXY } });
const mic = nativeMic();

// level for the animation, from the same frames
const vad = new VoiceActivity();
vad.on("level", ({ rms }) => setLevel(rms));
mic.onFrame((frame) => vad.push(frame, 16000));

export function onPressIn() {
  if (!mic.start()) askForMicrophonePermission(); // your existing native permission flow
}

export async function onPressOut() {
  const pcm = await mic.stop();
  vad.reset();
  const { text } = await speech.stt.transcribe(pcm);
  // recorder?.user(pcm, text) if you keep the conversation with ConversationRecorder
  return text;
}
