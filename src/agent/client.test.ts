import { describe, expect, it, vi } from "vitest";

// small-webrtc-transport builds an AudioWorklet blob URL at import time.
vi.hoisted(() => {
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:stub";
  }
});

import { FreyaClient } from "./client.js";
import { FreyaEvent } from "./types.js";

type Handler = (...args: unknown[]) => void;

/** Minimal PipecatClient stand-in: record handlers, let the test fire RTVI events. */
function makeFakePc() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, fn: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    fire(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((fn) => fn(...args));
    },
    async sendText() {},
  };
}

function makeWiredClient(config: { mode?: "call" | "chat" } = {}) {
  const client = new FreyaClient({ baseUrl: "https://x", token: "t", ...config });
  const pc = makeFakePc();
   
  (client as any)._bindEvents(pc);
   
  (client as any)._pc = pc;
  return { client, pc };
}

/** Fire a complete LLM turn. */
function turn(pc: ReturnType<typeof makeFakePc>, text: string) {
  pc.fire("botLlmStarted");
  pc.fire("botLlmText", { text });
  pc.fire("botLlmStopped");
}

describe("botMessage turn aggregation", () => {
  it("emits one botMessage with the full text per turn", () => {
    const { client, pc } = makeWiredClient();
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    pc.fire("botLlmStarted");
    pc.fire("botLlmText", { text: "Kredi " });
    pc.fire("botLlmText", { text: "kartı " });
    pc.fire("botLlmText", { text: "ekstre." });
    pc.fire("botLlmStopped");

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ text: "Kredi kartı ekstre." });
  });

  it("ignores text outside started/stopped (guardrail re-push) and empty turns", () => {
    const { client, pc } = makeWiredClient();
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    pc.fire("botLlmText", { text: "stale guardrail re-push" });
    pc.fire("botLlmStarted");
    pc.fire("botLlmStopped");

    expect(onMessage).not.toHaveBeenCalled();

    pc.fire("botLlmStarted");
    pc.fire("botLlmText", "raw string chunk");
    pc.fire("botLlmStopped");

    expect(onMessage).toHaveBeenCalledWith({ text: "raw string chunk" });
  });

  it("drops a chat turn that repeats the previous message with no user message in between", () => {
    const { client, pc } = makeWiredClient({ mode: "chat" });
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    turn(pc, "Bir kayıt bulamadım. Tekrar söyler misiniz?");
    turn(pc, "Bir kayıt bulamadım. Tekrar söyler misiniz?");

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a chat turn containing the previous message twice-concatenated", () => {
    const { client, pc } = makeWiredClient({ mode: "chat" });
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    turn(pc, "Bir kayıt bulamadım. Tekrar söyler misiniz?");
    // The platform echo concatenates the reply with itself; whitespace may differ.
    turn(pc, "Bir kayıt bulamadım. Tekrar söyler misiniz? Bir kayıt bulamadım. Tekrar söyler misiniz?");

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("emits an identical chat reply again when the user sent a message in between", async () => {
    const { client, pc } = makeWiredClient({ mode: "chat" });
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    turn(pc, "Te-ce kimlik numaranızı öğrenebilir miyim?");
    await client.sendMessage("pardon?");
    turn(pc, "Te-ce kimlik numaranızı öğrenebilir miyim?");

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("does not let an empty tool-call leg consume the user-message signal", async () => {
    const { client, pc } = makeWiredClient({ mode: "chat" });
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    turn(pc, "Te-ce kimlik numaranızı öğrenebilir miyim?");
    await client.sendMessage("pardon?");
    // Tool-call leg: a started/stopped window with no text.
    pc.fire("botLlmStarted");
    pc.fire("botLlmStopped");
    // The repeat is legitimate — a user message arrived before it.
    turn(pc, "Te-ce kimlik numaranızı öğrenebilir miyim?");

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("does not drop repeated turns in call mode", () => {
    const { client, pc } = makeWiredClient();
    const onMessage = vi.fn();
    client.on(FreyaEvent.BotMessage, onMessage);

    turn(pc, "Hala orada mısınız?");
    turn(pc, "Hala orada mısınız?");

    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("exposes botLlmStarted/botLlmStopped as passthrough events", () => {
    const { client, pc } = makeWiredClient();
    const onStarted = vi.fn();
    const onStopped = vi.fn();
    client.on(FreyaEvent.BotLlmStarted, onStarted);
    client.on(FreyaEvent.BotLlmStopped, onStopped);

    pc.fire("botLlmStarted");
    pc.fire("botLlmStopped");

    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
});
