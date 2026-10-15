// Minimal backend for the SDK: mints embed tokens and proxies chat and speech with keys the app never sees.
// Environment: FREYA_BASE_URL, FREYA_AGENT_ID, FREYA_WEB_TOKEN_KEY (calls:web-token),
// FREYA_CHAT_KEY (calls:chat-message), FREYA_SPEECH_KEY, APP_ORIGIN. Run: node examples/token-backend.mjs
import { createServer } from "node:http";

const env = (name, fallback) => process.env[name] ?? fallback;
const DASHBOARD = env("FREYA_BASE_URL", "https://app.freyavoice.ai");
const STT = env("FREYA_STT_URL", "https://stt.freyavoice.ai");
const TTS = env("FREYA_TTS_URL", "https://tts.freyavoice.ai");
const ORIGIN = env("APP_ORIGIN", "http://localhost:5173");

// Demo only: any Authorization header passes. Replace with your own session check (cookie, JWT, ...).
function isSignedIn(req) {
  return Boolean(req.headers.authorization);
}

// Only the exact paths the SDK calls are forwarded. Matching the normalised path stops
// "/freya/api/v2/chat/../../v2/agents" from reaching another endpoint with your key.
const ROUTES = {
  "/freya/api/v2/chat/message": { target: DASHBOARD, key: "FREYA_CHAT_KEY" },
  "/freya/api/v2/chat/end": { target: DASHBOARD, key: "FREYA_CHAT_KEY" },
  "/freya/v1/audio/speech": { target: TTS, key: "FREYA_SPEECH_KEY" },
  "/freya/v1/audio/transcriptions": { target: STT, key: "FREYA_SPEECH_KEY" },
};

async function readBody(req) {
  const parts = [];
  for await (const p of req) parts.push(p);
  return Buffer.concat(parts);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (!isSignedIn(req)) return res.writeHead(401).end("sign in first");

  if (req.method === "GET" && req.url === "/freya-token") {
    const r = await fetch(`${DASHBOARD}/api/token/embed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("FREYA_WEB_TOKEN_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: env("FREYA_AGENT_ID"), allowedOrigin: ORIGIN, ttlSeconds: 600 }),
    });
    res.writeHead(r.status, { "Content-Type": "application/json" });
    return res.end(await r.text());
  }

  const { pathname, search } = new URL(req.url, "http://localhost");
  const route = req.method === "POST" && Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (!route) return res.writeHead(404).end();
  const upstream = await fetch(route.target + pathname.slice("/freya".length) + search, {
    method: "POST",
    headers: { Authorization: `Bearer ${env(route.key)}`, "Content-Type": req.headers["content-type"] ?? "application/json" },
    body: await readBody(req),
  });
  res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
  res.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(8787, () => console.log("token backend on http://localhost:8787"));
