import { describe, expect, it, vi } from "vitest";

import { AgentChat } from "./rest.js";

function fakeDashboard(expiredTokens: string[] = []) {
  const calls: { url: string; token: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const token = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    const body = JSON.parse(String(init?.body));
    calls.push({ url, token, body });
    if (expiredTokens.includes(token)) return new Response("expired", { status: 401 });
    if (url.includes("/chat/end")) return Response.json({ success: true, data: { result: { callId: body.callId, ended: true } } });
    const turn = calls.filter((c) => c.url.includes("/chat/message")).length;
    return Response.json({
      success: true,
      data: { result: { response: ` cevap ${turn} `, callId: "11111111-1111-1111-1111-111111111111", messageId: `m${turn}` } },
    });
  });
  return { fetch, calls };
}

describe("AgentChat", () => {
  it("starts with the workflow, then continues the same call", async () => {
    const dash = fakeDashboard();
    const chat = new AgentChat({ baseUrl: "https://tr-app.freyavoice.ai/", token: "k", workflowId: "w1", workspaceId: "ws", fetch: dash.fetch });
    const first = await chat.send("Merhaba", { customerVariables: { ad: "Ayşe" } });
    const second = await chat.send("Kart borcum ne kadar?");
    expect(first).toEqual({ reply: "cevap 1", callId: "11111111-1111-1111-1111-111111111111", messageId: "m1", ended: false });
    expect(second.reply).toBe("cevap 2");
    expect(dash.calls[0].url).toBe("https://tr-app.freyavoice.ai/api/v2/chat/message?workspaceId=ws");
    expect(dash.calls[0].body).toEqual({ message: "Merhaba", workflowId: "w1", customerVariables: { ad: "Ayşe" } });
    expect(dash.calls[1].body).toEqual({ message: "Kart borcum ne kadar?", callId: "11111111-1111-1111-1111-111111111111" });
  });

  it("renews the token on 401 and repeats the turn", async () => {
    const dash = fakeDashboard(["old"]);
    let n = 0;
    const chat = new AgentChat({ baseUrl: "https://app.freyavoice.ai", token: async () => (n++ ? "new" : "old"), agentId: "a1", fetch: dash.fetch });
    const turn = await chat.send("Merhaba");
    expect(turn.reply).toBe("cevap 2");
    expect(dash.calls.map((c) => c.token)).toEqual(["old", "new"]);
    expect(dash.calls[1].body).toEqual({ message: "Merhaba", agentId: "a1" });
  });

  it("ends the call once", async () => {
    const dash = fakeDashboard();
    const chat = new AgentChat({ baseUrl: "https://app.freyavoice.ai", token: "k", workflowId: "w1", fetch: dash.fetch });
    await chat.end();
    expect(dash.calls).toHaveLength(0);
    await chat.send("Merhaba");
    await chat.end();
    expect(dash.calls[1].url).toBe("https://app.freyavoice.ai/api/v2/chat/end");
    expect(chat.callId).toBeNull();
  });

  it("throws with the status when the dashboard refuses", async () => {
    const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const chat = new AgentChat({ baseUrl: "https://app.freyavoice.ai", token: "k", workflowId: "w1", fetch });
    await expect(chat.send("Merhaba")).rejects.toMatchObject({ status: 403 });
  });
});

describe("AgentChat safety", () => {
  it("starts one conversation when two first messages go out together", async () => {
    const dash = fakeDashboard();
    const chat = new AgentChat({ baseUrl: "https://app.freyavoice.ai", token: "k", workflowId: "w1", fetch: dash.fetch });
    await Promise.all([chat.send("Merhaba"), chat.send("Bakiyem ne kadar?")]);
    const bodies = dash.calls.map((c) => c.body);
    expect(bodies[0]).toMatchObject({ workflowId: "w1" });
    expect(bodies[1]).toMatchObject({ callId: "11111111-1111-1111-1111-111111111111" });
    expect(bodies[1]).not.toHaveProperty("workflowId");
  });

  it("throws when the answer has no callId instead of sending 'undefined' next", async () => {
    const fetch = vi.fn(async () => Response.json({ data: { result: { response: "ok" } } }));
    const chat = new AgentChat({ baseUrl: "https://app.freyavoice.ai", token: "k", workflowId: "w1", fetch });
    await expect(chat.send("Merhaba")).rejects.toThrow(/callId/);
    expect(chat.callId).toBeNull();
  });

  it("refuses a plain http baseUrl", () => {
    expect(() => new AgentChat({ baseUrl: "http://bank.example", token: "k", workflowId: "w1" })).toThrow(/https/);
  });
});
