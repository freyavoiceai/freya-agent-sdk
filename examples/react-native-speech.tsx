// Dictation and a spoken answer in React Native. Needs react-native-audio-api and a recorder that
// saves a WAV file. Chat and speech go through your backend (see token-backend.mjs); the app holds no Freya key.
import { useMemo, useState } from "react";
import { Button, Text, View } from "react-native";
import { AudioContext } from "react-native-audio-api";
import { AgentChat } from "@freya/agent-sdk/agent";
import { FreyaSpeech, WebAudioOutput } from "@freya/agent-sdk/speech";

const BACKEND = "https://your-backend.example/freya";

export function Assistant({ sessionToken, workflowId, record }: {
  sessionToken: string;
  workflowId: string;
  /** Records until the user stops; resolves to a WAV file uri. */
  record: () => Promise<string>;
}) {
  const [caption, setCaption] = useState("");
  const speech = useMemo(
    () => new FreyaSpeech({ token: sessionToken, stt: { url: BACKEND }, tts: { url: BACKEND } }),
    [sessionToken],
  );
  const chat = useMemo(() => new AgentChat({ baseUrl: BACKEND, token: sessionToken, workflowId }), [sessionToken, workflowId]);
  const output = useMemo(() => new WebAudioOutput({ context: new AudioContext() }), []);

  async function ask() {
    const uri = await record();
    const { text } = await speech.stt.transcribe({ uri, name: "audio.wav", type: "audio/wav" });
    const { reply } = await chat.send(text);
    const reader = speech.reader(output);
    reader.on("sentenceStart", (s) => setCaption(s.text));
    reader.push({ text: reply, final: true });
  }

  return (
    <View>
      <Button title="Ask" onPress={ask} />
      <Text>{caption}</Text>
    </View>
  );
}
