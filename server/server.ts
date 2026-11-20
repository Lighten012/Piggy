import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Journal } from "./journal.ts";
import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

const host = process.env.HOST || "127.0.0.1";
const workerToken = process.env.PIGGY_WORKER_TOKEN;
if (!workerToken || host !== "127.0.0.1") throw new Error("Pi requires a private loopback listener and worker token");
const dbPath = process.env.PIGGY_DB;
if (!dbPath) throw new Error("PIGGY_DB is required");
const journal = new Journal(dbPath);
const digest = (text: string) => createHash("sha256").update(text).digest();
const workerAuth = digest("Bearer " + workerToken);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let busy = false;

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
async function chat(req: IncomingMessage, res: ServerResponse) {
  if (req.url !== "/chat" || req.method !== "POST") return reject(res, 404, "未知请求");
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
      (data.session != null && (typeof data.session !== "string" || !uuid.test(data.session))) ||
      (data.request != null && (typeof data.request !== "string" || !uuid.test(data.request)))) return reject(res, 400, "消息格式有误");

  const conversation = data.session ?? randomUUID();
  const request = data.request ?? randomUUID();
  const question = data.text.trim();
  const existing = journal.lookup(conversation,request);
  if (existing) {
    if (existing.question !== question) return reject(res,409,"消息编号已占用");
    if (existing.status === "pending") return reject(res,409,"该消息仍在生成，请稍后重试");
    if (existing.status === "failed") return reject(res,422,"上次生成中断，请重新发送");
    res.writeHead(200, {"Content-Type":"application/x-ndjson; charset=utf-8"});
    res.end(JSON.stringify({delta:existing.answer}) + "\n" + JSON.stringify({done:true,session:conversation}) + "\n");
    return;
  }
  if (busy) return reject(res,409,"上一条消息仍在生成，请稍后重试");
  if (!fixturePort && memoryUnderPressure()) return reject(res,503,"服务器可用内存不足，请稍后重试");
  const agent = newAgent();
  agent.state.messages = journal.previous(conversation);
  const id = journal.begin(conversation,request,question);
  busy = true;
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  res.flushHeaders();
  const emit = (event: object) => res.write(JSON.stringify(event) + "\n");
  const stop = () => agent.abort();
  res.once("close", stop);
  const timer = setTimeout(stop, 110000);
  let partial = "";
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      partial += event.assistantMessageEvent.delta;
      emit({ delta: event.assistantMessageEvent.delta });
    }
  });
  const started = Date.now();

  try {
    await agent.prompt(question);
    const last = agent.state.messages.at(-1);
    if (res.destroyed || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      const reason = last?.role === "assistant" ? last.errorMessage ?? "" : "";
      const code = reason.match(/\b(400|401|403|404|429|5[0-9]{2})\b/)?.[1];
      console.warn("Model call failed", code || (reason.includes("Connection") ? "connection" : "generation"));
      throw new Error("Generation failed");
    }
    const answer = last.content.filter(part => part.type === "text").map(part => part.text).join("");
    journal.complete(id, answer, agent.state.messages.slice(-2));
    emit({ done: true, session: conversation });
    console.info(JSON.stringify({event:"chat", owner:"mobile", model:model.id, status:"ok",
      durationMs:Date.now()-started, inputTokens:last.usage.input, outputTokens:last.usage.output,
      cacheRead:last.usage.cacheRead, cacheWrite:last.usage.cacheWrite}));
  } catch {
    journal.fail(id,partial);
    console.info(JSON.stringify({event:"chat", owner:"mobile", status:"failed", durationMs:Date.now()-started}));
    if (!res.destroyed) emit({ error: "生成失败，请检查后端密钥、模型权限或网络后重试" });
  } finally {
    clearTimeout(timer);
    res.off("close", stop);
    unsubscribe();
    busy = false;
    res.end();
  }
}
function handle(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!timingSafeEqual(digest(req.headers.authorization || ""), workerAuth)) return reject(res,401,"身份无效");
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/history" && req.method === "GET" && req.headers["x-piggy-owner"] === "admin") {
    const cursor = (name: string) => url.searchParams.has(name) ? Number(url.searchParams.get(name)) : null;
    const after = cursor("after"), before = cursor("before");
    if ((after !== null && before !== null) ||
        [after,before].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0))) return reject(res,400,"分页参数有误");
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({turns:journal.page(after,before)}));
  }
  if (req.headers["x-piggy-owner"] !== "mobile") return reject(res,405,"网页仅支持查看记录");
  chat(req, res).catch(() => {
    if (!res.headersSent) reject(res, 500, "服务端请求失败");
    else res.end();
  });
}
const server = createServer(handle);
server.requestTimeout = 120000;
server.maxConnections = 32;
server.listen(Number(process.env.PORT || 18889), host, () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log("Piggy ready on port " + address.port);
});
