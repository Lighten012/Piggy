import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

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
const sessions = new Map<string, { agent: Agent; busy: boolean; lastUsed: number }>();

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
  if (req.headers.origin || req.headers["content-type"]?.split(";")[0] !== "application/json") {
    return reject(res, 415, "仅支持原生客户端 JSON 请求");
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
  const id = data.session ?? randomUUID();
  let session = sessions.get(id);
  if (!session) {
    if (data.session != null) return reject(res, 410, "会话已过期，请新建对话");
    if (sessions.size >= 64) return reject(res, 429, "会话已满，请稍后再试");
    session = { agent: newAgent(), busy: false, lastUsed: Date.now() };
    sessions.set(id, session);
  }
  if (session.busy) return reject(res, 409, "上一条消息仍在生成");
  const { agent } = session;
  const previous = [...agent.state.messages];
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
    complete = true;
  } catch {
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
const server = createServer((req, res) => {
  chat(req, res).catch(() => {
    if (!res.headersSent) reject(res, 500, "服务端请求失败");
    else res.end();
  });
});
server.listen(Number(process.env.PORT || 8787), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log("Piggy ready on port " + address.port);
});
