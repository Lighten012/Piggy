import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const host = process.env.HOST || "127.0.0.1";
const password = process.env.PIGGY_ADMIN_PASSWORD;
const tls = process.env.PIGGY_TLS_CERT && process.env.PIGGY_TLS_KEY ? {
  cert: readFileSync(process.env.PIGGY_TLS_CERT), key: readFileSync(process.env.PIGGY_TLS_KEY),
} : undefined;
if ((!["127.0.0.1", "::1"].includes(host) && (!password || !tls)) ||
    Boolean(process.env.PIGGY_TLS_CERT) !== Boolean(process.env.PIGGY_TLS_KEY)) {
  throw new Error("A public listener requires PIGGY_ADMIN_PASSWORD, PIGGY_TLS_CERT and PIGGY_TLS_KEY.");
}
const digest = (text: string) => createHash("sha256").update(text).digest();
const expectedAuth = password ? digest("Basic " + Buffer.from("piggy:" + password).toString("base64")) : null;
const workerToken = process.env.PIGGY_WORKER_TOKEN;
if (workerToken && host !== "127.0.0.1") throw new Error("Worker must use loopback");
const workerAuth = workerToken ? digest("Bearer " + workerToken) : null;
const assets = new Map<string, {type: string; data: Buffer}>();
for (const [path, file, type] of [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/chat.js", "chat.js", "text/javascript; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"],
]) {
  if (workerAuth) break;
  assets.set(path, {type, data: readFileSync(new URL("./web/" + file, import.meta.url))});
}

function memoryUnderPressure() {
  if (process.platform !== "linux") return false;
  const info = readFileSync("/proc/meminfo", "utf8");
  const total = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
  const available = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return available < total / 2 + 32 * 1024;
}

const models = createModels();
models.setProvider(openaiProvider());
const selected = models.getModel("openai", process.env.PI_MODEL || "gpt-4.1-mini");
if (!selected) throw new Error("PI_MODEL is absent from the Pi OpenAI catalog.");

// Only a loopback test fixture may override OpenAI's address.
const fixturePort = process.env.PI_LOCAL_FIXTURE_PORT;
if (fixturePort && (!/^\d{1,5}$/.test(fixturePort) || process.env.PI_API_KEY)) {
  throw new Error("The local fixture requires a port and an empty PI_API_KEY.");
}
const model: Model<"openai-completions"> = {
  ...selected, api: "openai-completions", compat: undefined,
  baseUrl: fixturePort ? `http://127.0.0.1:${fixturePort}/v1` : "https://api.openai.com/v1",
};
const apiKey = fixturePort ? "local-fixture-only" : process.env.PI_API_KEY;
const sessions = new Map<string, { owner: string; agent: Agent; busy: boolean; lastUsed: number }>();

function newAgent() {
  return new Agent({
    initialState: { systemPrompt: "你是个人助手 Piggy。按用户使用的语言回答，清楚、简洁。", model },
    getApiKey: () => apiKey,
    streamFn: (_model, context, options) => streamSimple(model, context, {
      ...options, maxTokens: 2048, maxRetries: 0,
    }),
  });
}
function reject(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error }));
}
async function chat(req: IncomingMessage, res: ServerResponse, owner: string) {
  if (req.url !== "/chat" || req.method !== "POST") return reject(res, 404, "未知请求");
  if (req.headers.origin && req.headers.origin !== (tls ? "https://" : "http://") + req.headers.host) {
    return reject(res, 403, "请求来源无效");
  }
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    return reject(res, 415, "请使用 JSON 请求");
  }
  if (!apiKey) return reject(res, 503, "后端尚未配置 PI_API_KEY");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) return reject(res, 413, "消息太长");
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { return reject(res, 400, "请求格式有误"); }
  if (typeof data?.text !== "string" || !data.text.trim() || data.text.length > 8000 ||
      (data.session != null && typeof data.session !== "string")) return reject(res, 400, "消息格式有误");

  for (const [id, session] of sessions) {
    if (!session.busy && Date.now() - session.lastUsed > 3600000) sessions.delete(id);
  }
  if (!fixturePort && memoryUnderPressure()) return reject(res, 503, "服务器可用内存不足，请稍后再试");
  if (Array.from(sessions.values()).filter(s => s.busy).length >= 2) {
    return reject(res, 429, "服务器正在处理其他对话，请稍后再试");
  }
  const id = data.session ?? randomUUID();
  let session = sessions.get(id);
  if (session && session.owner !== owner) return reject(res, 410, "会话已过期，请新建对话");
  if (!session) {
    if (data.session != null) return reject(res, 410, "会话已过期，请新建对话");
    if (sessions.size >= 8) {
      const idle = [...sessions].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      sessions.delete(idle[0][0]);
    }
    session = { owner, agent: newAgent(), busy: false, lastUsed: Date.now() };
    sessions.set(id, session);
  }
  if (session.busy) return reject(res, 409, "上一条消息仍在生成");
  const { agent } = session;
  const previous = [...agent.state.messages];
  // This chat has only user/assistant pairs. Keep the latest 12 completed turns.
  agent.state.messages = previous.slice(-24);
  session.busy = true;
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  res.flushHeaders();
  const emit = (event: object) => res.write(JSON.stringify(event) + "\n");
  const stop = () => agent.abort();
  res.once("close", stop);
  const timer = setTimeout(stop, 110000);
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      emit({ delta: event.assistantMessageEvent.delta });
    }
  });
  const started = Date.now();
  let complete = false;
  try {
    await agent.prompt(data.text.trim());
    const last = agent.state.messages.at(-1);
    if (res.destroyed || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      const reason = last?.role === "assistant" ? last.errorMessage ?? "" : "";
      const code = reason.match(/\b(400|401|403|404|429|5[0-9]{2})\b/)?.[1];
      console.warn("Model call failed", code || (reason.includes("Connection") ? "connection" : "generation"));
      throw new Error("Generation failed");
    }
    emit({ done: true, session: id });
    agent.state.messages = agent.state.messages.slice(-24);
    complete = true;
    console.info(JSON.stringify({event:"chat", owner, model:model.id, status:"ok",
      durationMs:Date.now()-started, inputTokens:last.usage.input, outputTokens:last.usage.output,
      cacheRead:last.usage.cacheRead, cacheWrite:last.usage.cacheWrite}));
  } catch {
    console.info(JSON.stringify({event:"chat", owner, status:"failed", durationMs:Date.now()-started}));
    if (!res.destroyed) emit({ error: "生成失败，请检查后端密钥、模型权限或网络后重试" });
  } finally {
    clearTimeout(timer);
    res.off("close", stop);
    unsubscribe();
    if (!complete) {
      agent.state.messages = previous;
      if (data.session == null) sessions.delete(id);
    }
    session.busy = false;
    session.lastUsed = Date.now();
    res.end();
  }
}
function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  let owner = "admin";
  if (workerAuth) {
    const value = req.headers["x-piggy-owner"];
    if (!timingSafeEqual(digest(req.headers.authorization || ""), workerAuth) ||
        typeof value !== "string" || !/^(admin|device-[a-f0-9]{64})$/.test(value)) {
      return reject(res, 401, "身份无效");
    }
    owner = value;
  } else if (expectedAuth && !timingSafeEqual(digest(req.headers.authorization || ""), expectedAuth)) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Piggy", charset="UTF-8"');
    return reject(res, 401, "请登录 Piggy");
  }
  const asset = assets.get(req.url || "/");
  if (asset && (req.method === "GET" || req.method === "HEAD")) {
    res.setHeader("Content-Type", asset.type);
    return res.end(req.method === "HEAD" ? undefined : asset.data);
  }
  chat(req, res, owner).catch(() => {
    if (!res.headersSent) reject(res, 500, "服务端请求失败");
    else res.end();
  });
}
const server = tls ? createHttpsServer(tls, handle) : createServer(handle);
server.requestTimeout = 120000;
server.maxConnections = 32;
server.listen(Number(process.env.PORT || 8888), host, () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log("Piggy ready on port " + address.port);
});
