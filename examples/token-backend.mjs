// Minimal backend for the SDK: mints embed tokens and proxies chat and speech with keys the app never sees.
// Environment: FREYA_BASE_URL, FREYA_AGENT_ID, FREYA_WORKFLOW_ID (optional, chat starts with it),
// FREYA_WEB_TOKEN_KEY (calls:web-token), FREYA_CHAT_KEY (calls:chat-message), FREYA_SPEECH_KEY, APP_ORIGIN.
// Run: DEMO_AUTH=1 node examples/token-backend.mjs (DEMO_AUTH lets any bearer token in; see userOf).
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const env = (name, fallback) => process.env[name] ?? fallback;
const DASHBOARD = env("FREYA_BASE_URL", "https://app.freyavoice.ai");
const STT = env("FREYA_STT_URL", "https://stt.freyavoice.ai");
const TTS = env("FREYA_TTS_URL", "https://tts.freyavoice.ai");
const DEMO = process.env.DEMO_AUTH === "1";
// The web origin embed tokens are bound to. Required outside the local demo: a default would
// silently bind production tokens to localhost.
const ORIGIN = env("APP_ORIGIN", DEMO ? "http://localhost:5173" : undefined);
if (!ORIGIN) {
  console.error("Set APP_ORIGIN to your app's origin, e.g. https://app.example.com");
  process.exit(1);
}
const MAX_BODY = 10 * 1024 * 1024; // a 30 s recording is about 1 MB
const UPSTREAM_TIMEOUT_MS = 30_000;

// Who is calling. Replace with your own session check (cookie, JWT, ...) and return the user id,
// or null. Without it this example refuses everyone, unless DEMO_AUTH=1 says it is a local demo.
function userOf(req) {
  const auth = req.headers.authorization ?? "";
  if (DEMO && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

// The customer variables the agent may use come from the session, never from the app.
function customerVariablesOf(_user) {
  return {};
}

// Calls each user started, so nobody can continue or end someone else's (in memory: one process only).
const callsOf = new Map();
const MAX_CALLS_PER_USER = 20;

function remember(user, callId) {
  const mine = callsOf.get(user) ?? new Set();
  mine.add(callId);
  // a Set keeps insertion order: the oldest call goes first
  while (mine.size > MAX_CALLS_PER_USER) mine.delete(mine.values().next().value);
  callsOf.set(user, mine);
}

function forget(user, callId) {
  const mine = callsOf.get(user);
  mine?.delete(callId);
  if (mine?.size === 0) callsOf.delete(user);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const p of req) {
    size += p.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    parts.push(p);
  }
  return Buffer.concat(parts);
}

async function readJson(req) {
  // only JSON: a form or text/plain body is what a cross-site page can send with the user's cookie
  if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "application/json expected");
  try {
    const body = JSON.parse((await readBody(req)).toString("utf8"));
    if (body && typeof body === "object") return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
  }
  throw new HttpError(400, "expected a JSON object");
}

function upstream(url, key, init) {
  const secret = env(key);
  if (!secret) throw new HttpError(500, `${key} is not set on the server`);
  return fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${secret}` },
    redirect: "error",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}

async function relay(res, response) {
  res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/octet-stream" });
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Chat: the body is rebuilt here. The app sends only its message and, after the first turn, the callId.
async function chatMessage(req, res, user) {
  const { message, callId } = await readJson(req);
  if (typeof message !== "string" || !message.trim() || message.length > 4000) throw new HttpError(400, "message");
  let body;
  if (callId !== undefined) {
    if (!callsOf.get(user)?.has(callId)) throw new HttpError(403, "not your call");
    body = { message, callId };
  } else {
    const start = env("FREYA_WORKFLOW_ID") ? { workflowId: env("FREYA_WORKFLOW_ID") } : { agentId: env("FREYA_AGENT_ID") };
    body = { message, ...start, customerVariables: customerVariablesOf(user) };
  }
  const r = await upstream(`${DASHBOARD}/api/v2/chat/message`, "FREYA_CHAT_KEY", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let result;
  try {
    result = JSON.parse(text)?.data?.result;
  } catch {
    // not JSON: relayed as it is
  }
  // a first turn that failed on the server may still have started the call (a 504 carries its id)
  // a call the agent ended stays known, so the app can still call end(); the cap bounds memory
  if (callId === undefined && typeof result?.callId === "string") remember(user, result.callId);
  res.writeHead(r.status, { "Content-Type": "application/json" });
  res.end(text);
}

async function chatEnd(req, res, user) {
  const { callId } = await readJson(req);
  if (!callsOf.get(user)?.has(callId)) throw new HttpError(403, "not your call");
  const r = await upstream(`${DASHBOARD}/api/v2/chat/end`, "FREYA_CHAT_KEY", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callId }),
  });
  if (r.ok) forget(user, callId);
  await relay(res, r);
}

// Speech: only the fields the SDK sends, with the model fixed here.
async function speech(req, res) {
  const { input, voice } = await readJson(req);
  if (typeof input !== "string" || !input.trim() || input.length > 2000) throw new HttpError(400, "input");
  const r = await upstream(`${TTS}/v1/audio/speech`, "FREYA_SPEECH_KEY", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: "freya-tts", voice: typeof voice === "string" ? voice : "zeynep", response_format: "pcm" }),
  });
  await relay(res, r);
}

// The form is rebuilt: only the recording and a language come from the app, the model is fixed here.
async function transcriptions(req, res) {
  const type = req.headers["content-type"] ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) throw new HttpError(415, "multipart/form-data expected");
  let sent;
  try {
    sent = await new Response(await readBody(req), { headers: { "Content-Type": type } }).formData();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "malformed form");
  }
  const file = sent.get("file");
  if (!(file instanceof Blob)) throw new HttpError(400, "file");
  const language = sent.get("language");
  // the service may tell the format by the extension: keep a known one ("rec.m4a")
  const ext = /\.(wav|mp3|m4a|mp4|aac|ogg|oga|opus|webm|flac)$/i.exec(file.name ?? "")?.[1].toLowerCase() ?? "wav";
  const form = new FormData();
  form.append("file", file, `audio.${ext}`);
  form.append("model", "freya-stt");
  // "tr", or "tr-TR" taken as "tr"; anything else falls back to Turkish
  const code = typeof language === "string" ? /^([a-z]{2})(?:[-_][a-z]{2})?$/i.exec(language)?.[1].toLowerCase() : undefined;
  form.append("language", code ?? "tr");
  form.append("response_format", "verbose_json");
  await relay(res, await upstream(`${STT}/v1/audio/transcriptions`, "FREYA_SPEECH_KEY", { method: "POST", body: form }));
}

// Exact paths only, matched after normalising, and the query string is dropped:
// "/freya/api/v2/chat/../../v2/agents" never reaches another endpoint with your key.
const ROUTES = {
  "/freya/api/v2/chat/message": chatMessage,
  "/freya/api/v2/chat/end": chatEnd,
  "/freya/v1/audio/speech": speech,
  "/freya/v1/audio/transcriptions": transcriptions,
};
// Live STT (/v1/audio/stream) is a WebSocket; proxying it needs a WebSocket server and is left out here.

async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const user = userOf(req);
  if (!user) throw new HttpError(401, "sign in first");
  // Add a per-user rate limit here before going live.

  const { pathname } = new URL(req.url, "http://localhost");
  if (req.method === "GET" && pathname === "/freya-token") {
    const r = await upstream(`${DASHBOARD}/api/token/embed`, "FREYA_WEB_TOKEN_KEY", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: env("FREYA_AGENT_ID"), allowedOrigin: ORIGIN, ttlSeconds: 600 }),
    });
    return relay(res, r);
  }
  const route = req.method === "POST" && Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (!route) throw new HttpError(404, "not found");
  await route(req, res, user);
}

createServer((req, res) => {
  req.on("error", () => res.destroy());
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 502;
    const id = randomUUID();
    if (status >= 500) console.error(id, err);
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(status >= 500 ? `server error (${id})` : err.message);
  });
}).listen(8787, "127.0.0.1", () => console.log("token backend on http://127.0.0.1:8787"));
