import { describe, expect, it, vi } from "vitest";

import type { AudioOutput } from "./audio.js";
import { ConversationRecorder, RecordingError, pcmFromWav } from "./recorder.js";
import { wavFromPcm } from "./stt.js";
import { SpeechHttpError, type Pcm } from "./tts.js";
import { crc32 } from "./zip.js";

/** Reads a stored (uncompressed) archive back, checking each entry's CRC. */
function unzip(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    const dataAt = local + 30 + v.getUint16(local + 26, true);
    const data = zip.subarray(dataAt, dataAt + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    at += 46 + nameLen;
  }
  return files;
}

function callOf(files: Map<string, Uint8Array>) {
  return JSON.parse(new TextDecoder().decode(files.get("calls.json"))).calls[0];
}

const tone = (n: number, value: number, sampleRate = 16000): Pcm => ({ samples: new Int16Array(n).fill(value), sampleRate });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, at: (ms: number) => (t = start + ms) };
}

function recorder(extra: Partial<ConstructorParameters<typeof ConversationRecorder>[0]> = {}) {
  const c = clock();
  const fetch = vi.fn();
  const rec = new ConversationRecorder({ url: "https://backend.example/freya/api/v2/call/import", token: "t1", fetch, now: c.now, ...extra });
  return { rec, fetch, c };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("ConversationRecorder archive", () => {
  it("files the conversation as one call with the transcript and a merged recording", () => {
    const { rec, c } = recorder({ customerNumber: "customer-1", externalCallId: "ugi-1", metadata: { app: "7.1" } });
    c.at(2000);
    rec.user(tone(16000, 100), "kart borcum ne kadar"); // heard from 1 s to 2 s
    c.at(2500);
    rec.sent("Kart borcum ne kadar?");
    c.at(3000);
    rec.bot("Kart borcunuz 4.250 lira.");
    rec.botAudio(tone(8000, 50), { at: 1_003_000 });
    c.at(5000);
    rec.end("customer-left");

    const files = unzip(rec.archive());
    expect([...files.keys()]).toEqual([
      "calls.json",
      `recordings/${rec.callId}.wav`,
      `recordings/${rec.callId}_user.wav`,
      `recordings/${rec.callId}_assistant.wav`,
    ]);
    const call = callOf(files);
    expect(call).toMatchObject({
      id: rec.callId,
      externalCallId: "ugi-1",
      customerNumber: "customer-1",
      type: "web",
      modality: "voice",
      status: "ended",
      endedReason: "customer-left",
      startedAt: new Date(1_000_000).toISOString(),
      endedAt: new Date(1_005_000).toISOString(),
      transcript: "User: Kart borcum ne kadar?\nAI: Kart borcunuz 4.250 lira.",
      metadata: { app: "7.1", source: "freya-agent-sdk" },
      recordingTracks: [
        { track: "single", ext: "wav" },
        { track: "user", ext: "wav" },
        { track: "assistant", ext: "wav" },
      ],
    });
    expect(call.messages).toEqual([
      { role: "user", message: "Kart borcum ne kadar?", time: 1_001_000, endTime: 1_002_000, secondsFromStart: 1, duration: 1000, heard: "kart borcum ne kadar", edited: false },
      { role: "bot", message: "Kart borcunuz 4.250 lira.", time: 1_003_000, endTime: 1_003_000, secondsFromStart: 3, duration: 0 },
    ]);

    // the customer from 1 s, the assistant from 3 s, silence before and between
    const merged = pcmFromWav(files.get(`recordings/${rec.callId}.wav`)!);
    expect(merged.sampleRate).toBe(16000);
    expect(merged.samples.length).toBe(16000 * 3 + 8000);
    expect(merged.samples[16000 - 1]).toBe(0);
    expect(merged.samples[16000]).toBe(100);
    expect(merged.samples[32000 + 100]).toBe(0);
    expect(merged.samples[48000]).toBe(50);
  });

  it("marks a corrected text, a typed message and dictation that was never sent", () => {
    const { rec, c } = recorder();
    c.at(1000);
    rec.user(tone(1600, 1), "kredi kartı");
    rec.user(tone(1600, 1), "başvurusu");
    rec.sent("Kredi kartı başvurum");
    rec.sent("Teşekkürler");
    c.at(3000);
    rec.user(tone(1600, 1), "iptal");
    const call = callOf(unzip(rec.archive()));
    expect(call.messages.map((m: Record<string, unknown>) => [m.message, m.heard, m.edited, m.typed, m.sent])).toEqual([
      ["Kredi kartı başvurum", "kredi kartı başvurusu", true, undefined, undefined],
      ["Teşekkürler", undefined, undefined, true, undefined],
      ["iptal", "iptal", undefined, undefined, false],
    ]);
  });

  it("converts every clip to the recording's rate and keeps separate tracks", () => {
    const { rec } = recorder();
    rec.botAudio(tone(48000, 30, 48000), { at: 1_000_000 });
    rec.user(wavFromPcm(tone(8000, 20, 8000)), "evet", { at: 1_000_000 });
    const files = unzip(rec.archive());
    expect(pcmFromWav(files.get(`recordings/${rec.callId}_assistant.wav`)!).samples.length).toBe(16000);
    expect(pcmFromWav(files.get(`recordings/${rec.callId}_user.wav`)!).samples.length).toBe(16000);
    expect(pcmFromWav(files.get(`recordings/${rec.callId}.wav`)!).samples[10]).toBe(50);
    expect(callOf(files).recordingTracks).toEqual([
      { track: "single", ext: "wav" },
      { track: "user", ext: "wav" },
      { track: "assistant", ext: "wav" },
    ]);
  });

  it("keeps only the merged file with tracks: false or when the tracks would not fit", () => {
    const off = recorder({ tracks: false }).rec;
    off.user(tone(1600, 1), "evet");
    const offFiles = unzip(off.archive());
    expect([...offFiles.keys()]).toEqual(["calls.json", `recordings/${off.callId}.wav`]);
    expect(callOf(offFiles).recordingTracks).toEqual([{ track: "single", ext: "wav" }]);

    // about 9 minutes at 16 kHz: the merged file fits, three of them would not
    const { rec } = recorder();
    rec.user(tone(16000 * 540, 1), "uzun");
    const files = unzip(rec.archive());
    expect([...files.keys()]).toEqual(["calls.json", `recordings/${rec.callId}.wav`]);
    expect(callOf(files).recordingTracks).toEqual([{ track: "single", ext: "wav" }]);
  });

  it("records what an output plays, up to where barge-in stopped it", async () => {
    const { rec, c } = recorder();
    const inner: AudioOutput = {
      play: vi.fn(async (_pcm: Pcm, onStart: () => void) => {
        c.at(1000);
        onStart();
        c.at(1250);
        return "stopped" as const;
      }),
      stop: vi.fn(),
    };
    const out = rec.output(inner);
    const started = vi.fn();
    expect(await out.play(tone(16000, 7), started)).toBe("stopped");
    expect(started).toHaveBeenCalledOnce();
    out.stop();
    expect(inner.stop).toHaveBeenCalledOnce();
    const merged = pcmFromWav(unzip(rec.archive()).get(`recordings/${rec.callId}.wav`)!);
    expect(merged.samples.length).toBe(16000 + 4000);
    expect(merged.samples[16000]).toBe(7);
  });

  it("has no recording file when no audio was given, and refuses input after the end", () => {
    const { rec } = recorder();
    rec.sent("Merhaba");
    rec.end();
    expect([...unzip(rec.archive()).keys()]).toEqual(["calls.json"]);
    expect(() => rec.bot("geç")).toThrow(/ended/);
  });

  it("reads 16-bit WAV, mixing stereo down, and refuses other audio", () => {
    const stereo = wavFromPcm({ samples: new Int16Array([100, 300, -100, -300]), sampleRate: 22050 });
    new DataView(stereo.buffer).setUint16(22, 2, true); // two channels
    expect(pcmFromWav(stereo)).toEqual({ samples: new Int16Array([200, -200]), sampleRate: 22050 });
    expect(() => pcmFromWav(new Uint8Array([1, 2, 3]))).toThrow(/WAV/);
    expect(() => recorder({ url: "http://backend.example/import" })).toThrow(/https/);
  });
});

describe("ConversationRecorder.send", () => {
  it("posts the archive as the import endpoint's form and keeps the result", async () => {
    const { rec, fetch } = recorder();
    rec.sent("Merhaba");
    fetch.mockResolvedValueOnce(ok({ created: 1, skipped: 0, failed: 0, errors: [] }));
    expect(await rec.send()).toMatchObject({ created: 1 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://backend.example/freya/api/v2/call/import");
    expect(init.headers.Authorization).toBe("Bearer t1");
    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe(`${rec.callId}.zip`);
    // jsdom's File has no arrayBuffer()
    const bytes = await new Promise<ArrayBuffer>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.readAsArrayBuffer(file);
    });
    expect(callOf(unzip(new Uint8Array(bytes))).messages[0].message).toBe("Merhaba");
    await rec.send();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('posts the bytes as application/zip with format: "zip", and accepts a wrapped result', async () => {
    const { rec, fetch } = recorder({ format: "zip" });
    fetch.mockResolvedValueOnce(ok({ data: { result: { created: 0, skipped: 1, failed: 0, errors: [] } } }));
    expect(await rec.send()).toMatchObject({ skipped: 1 });
    const init = fetch.mock.calls[0][1];
    expect(init.headers["Content-Type"]).toBe("application/zip");
    expect(unzip(init.body as Uint8Array).has("calls.json")).toBe(true);
  });

  it("reports a call stored without its audio, also when sent again", async () => {
    const { rec, fetch } = recorder();
    rec.botAudio(tone(160, 1));
    fetch.mockResolvedValueOnce(
      ok({ created: 1, skipped: 0, failed: 0, errors: [{ index: 0, id: rec.callId, error: "Call imported but recording upload failed" }] }),
    );
    const first = await rec.send().catch((e) => e);
    expect(first).toBeInstanceOf(RecordingError);
    expect(first.reason).toBe("audio-lost");
    await expect(rec.send()).rejects.toBe(first);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails when no call was created or the endpoint refused, and can be sent again", async () => {
    const { rec, fetch } = recorder();
    fetch.mockResolvedValueOnce(ok({ created: 0, skipped: 0, failed: 1, errors: [{ index: 0, id: null, error: "bad startedAt" }] }));
    await expect(rec.send()).rejects.toMatchObject({ reason: "rejected", message: "bad startedAt" });
    fetch.mockResolvedValueOnce(new Response("no", { status: 413 }));
    await expect(rec.send()).rejects.toBeInstanceOf(SpeechHttpError);
    fetch.mockResolvedValueOnce(ok({ ok: true }));
    await expect(rec.send()).rejects.toMatchObject({ reason: "rejected" });
    fetch.mockResolvedValueOnce(ok({ created: 1, skipped: 0, failed: 0, errors: [] }));
    await expect(rec.send()).resolves.toMatchObject({ created: 1 });
  });
});
