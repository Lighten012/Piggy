import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { receiveAttachment, uuid } from "./attachments.ts";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ReplyFiles, fileTools, replyText } from "./reply-files.ts";
import { Retention } from "./retention.ts";
import { Journal, type Attachment } from "./journal.ts";
import { readFileSync } from "node:fs";
import { agentTools, capabilityCatalog, loadedSkills } from "./capabilities.ts";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, toToolDeclaration, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { convertResponsesMessages, convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { Message } from "@earendil-works/pi-ai";

const host = process.env.HOST || "127.0.0.1";
const workerToken = process.env.PIGGY_WORKER_TOKEN;
if (!workerToken || host !== "127.0.0.1") throw new Error("Pi requires a private loopback listener and worker token");
const dbPath = process.env.PIGGY_DB;
if (!dbPath) throw new Error("PIGGY_DB is required");
const journal = new Journal(dbPath);
const retention = new Retention(dbPath);
async function cleanAttachments() {
  try { await retention.sweep(journal); }
  catch { console.warn("Attachment cleanup failed; will retry"); }
  finally { setTimeout(cleanAttachments,60_000).unref(); }
}
void cleanAttachments();
const digest = (text: string) => createHash("sha256").update(text).digest();
const workerAuth = digest("Bearer " + workerToken);
let busy = false;
let readingContext = false;

function memoryUnderPressure() {
  if (process.platform !== "linux") return false;
  const info = readFileSync("/proc/meminfo", "utf8");
  const total = Number(info.match(/^MemTotal:\s+(\d+)/m)?.[1]);
  const available = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return available < total / 2 + 32 * 1024;
}

const models = createModels();
models.setProvider(openaiProvider());
// Pi 1.5.2 predates the public GPT-6.2 Sol catalog entry.
const sol: Model<"openai-completions"> = {
  id: "gpt-6.2-sol", name: "GPT-6.2 Sol", provider: "openai", api: "openai-completions",
  baseUrl: "https://api.openai.com/v1", input: ["text", "image"], reasoning: true,
  contextWindow: 1050000, maxTokens: 128000,
  cost: { input: 2, output: 10, cacheRead: 0.25, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.5, cacheWrite: 5 }] },
};
const modelId = process.env.PI_MODEL || sol.id;
const selected = models.getModel("openai", modelId) ?? (modelId === sol.id ? sol : undefined);
if (!selected) throw new Error("PI_MODEL is absent from the Pi OpenAI catalog.");

// Only a loopback test fixture may override OpenAI's address.
const fixturePort = process.env.PI_LOCAL_FIXTURE_PORT;
if (fixturePort && (!/^\d{1,5}$/.test(fixturePort) || process.env.PI_API_KEY)) {
  throw new Error("The local fixture requires a port and an empty PI_API_KEY.");
}
const model: Model<"openai-responses"> = {
  ...selected, api: "openai-responses", compat: undefined,
  baseUrl: fixturePort ? `http://127.0.0.1:${fixturePort}/v1` : "https://api.openai.com/v1",
};
const apiKey = fixturePort ? "local-fixture-only" : process.env.PI_API_KEY;
const thinkingLevel = model.id === sol.id ? "high" : "off";
const contextLimit = 300_000;
const persona = "你是个人助手 Piggy。按用户使用的语言回答，清楚、简洁。用户要求图片或可下载的文件时，调用对应工具实际生成。使用代码解释器生成的文件请在最终答复中链接到 sandbox:/mnt/data/ 下的成品。";
function addFiles(input: unknown[], files: Attachment[]) {
  if (!files.length) return;
  const user = input.findLast((item): item is {role:"user"; content:unknown} =>
    typeof item === "object" && item !== null && "role" in item && item.role === "user");
  if (!Array.isArray(user?.content)) throw new Error("Missing attachment message");
  for (const file of files) user.content.push(file.image ? {type:"input_image",file_id:file.remote,detail:"auto"} :
    {type:"input_file",file_id:file.remote});
}
async function countInput(input: unknown[], tools?: unknown[], signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(model.baseUrl + "/responses/input_tokens", {
    method: "POST", headers: {authorization: "Bearer " + apiKey, "content-type": "application/json"},
    body: JSON.stringify({model:model.id, input, tools}), signal: signal ? AbortSignal.any([signal,timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Input count HTTP " + response.status);
  }
  const { input_tokens: used } = await response.json();
  if (!Number.isSafeInteger(used) || used < 0) throw new Error("Invalid input count");
  return {used, limit:contextLimit};
}
function toolFileIds(conversation: string, files: Attachment[]) {
  const previous = journal.previousOutputs(conversation).filter(f => f.until > Date.now());
  return [...files.map(f => f.remote), ...previous.map(f => f.remote)];
}
function promptForFiles(stored: number, available: number) {
  const prompt = [persona, ...loadedSkills.map(skill => skill.instructions)].join("\n\n");
  return prompt + (available < stored ? " 部分附件已过期；如需原文，请用户重新上传。" : "");
}
type ContextUsage = Awaited<ReturnType<typeof countInput>>;
function newAgent(outputs: ReplyFiles, availableIds: string[], files: Attachment[], systemPrompt: string, messages: ReturnType<Journal["contextMessages"]>,
    measured: (usage: ContextUsage) => void,
    rejectGeneration: (message: string) => void) {
  return new Agent({
    initialState: { systemPrompt, messages, model, thinkingLevel, tools:agentTools },
    getApiKey: () => apiKey,
    streamFn: (_model, context, options) => streamResponses(model, context, {
      ...options, maxTokens: thinkingLevel === "high" ? 16384 : 2048, maxRetries: 0,
      onProviderStreamEvent: event => outputs.observe(event,options?.signal),
      async onPayload(payload) {
        const body = payload as {tools?:unknown[]; input: {role?:string; content?:unknown}[]};
        const input = body.input;
        const tools = body.tools = [...(body.tools ?? []), ...fileTools(availableIds)];
        addFiles(input, files);
        let usage: ContextUsage;
        try { usage = await countInput(input, tools, options?.signal); }
        catch (error) {
          rejectGeneration(files.length && error instanceof Error && /HTTP (400|404|415|422)$/.test(error.message)
            ? "无法统计此附件的上下文，请减少附件内容或更换文件后重试"
            : "暂时无法核对上下文用量，请稍后重试");
          throw error;
        }
        measured(usage);
        if (usage.used > usage.limit) {
          const message = `本次输入共 ${usage.used.toLocaleString("en-US")} tokens，超过 300,000 上限，请缩短消息或减少附件。`;
          rejectGeneration(message);
          throw new Error(message);
        }
      },
    }),
  });
}
function reject(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error }));
}
async function chat(req: IncomingMessage, res: ServerResponse) {
  const preview = req.url === "/context";
  if ((!preview && req.url !== "/chat") || req.method !== "POST") return reject(res, 404, "未知请求");
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
  if (preview) {
    if (typeof data?.session !== "string" || !uuid.test(data.session)) return reject(res,400,"对话编号无效");
    if (!fixturePort && memoryUnderPressure()) return reject(res,503,"服务器可用内存不足");
    if (readingContext) return reject(res,503,"上下文用量正在读取，请稍后重试");
    readingContext = true;
    try {
      const stored = journal.contextFiles(data.session);
      const files = stored.filter((file): file is Attachment => !!file && file.expires > Date.now());
      const messages = journal.contextMessages(data.session) as Message[];
      if (files.length) messages.push({role:"user",content:[{type:"text",text:""}],timestamp:Date.now()});
      const input = convertResponsesMessages(model, normalizeContext({
        systemPrompt:promptForFiles(stored.length, files.length), messages
      }), new Set(["openai"]));
      addFiles(input,files);
      const tools = agentTools.length ? convertResponsesTools(agentTools.map(toToolDeclaration), {supportsStrictMode:true}) : undefined;
      const usage = await countInput(input, [...(tools ?? []), ...fileTools(toolFileIds(data.session,files))]);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(usage));
    } catch { reject(res,503,"上下文用量暂时无法读取"); }
    finally { readingContext = false; }
    return;
  }
  const ids: unknown = data?.attachments ?? (data?.attachment == null ? [] : [data.attachment]);
  if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || !uuid.test(id)) || (ids.length && !data.session) ||
      (data?.attachments != null && data?.attachment != null)) return reject(res,400,"每条消息最多可带四个不同的附件");
  if (typeof data?.text !== "string" || !data.text.trim() || data.text.length > 8000 ||
      (data.session != null && (typeof data.session !== "string" || !uuid.test(data.session))) ||
      (data.request != null && (typeof data.request !== "string" || !uuid.test(data.request)))) return reject(res, 400, "消息格式有误");

  const conversation = data.session ?? randomUUID();
  const request = data.request ?? randomUUID();
  const question = data.text.trim();
  const existing = journal.lookup(conversation,request);
  if (existing) {
    if (existing.question !== question || JSON.stringify(journal.turnFiles(Number(existing.id)).map(f=>f.id)) !== JSON.stringify(ids)) return reject(res,409,"消息编号已占用");
    if (existing.status === "pending") return reject(res,409,"该消息仍在生成，请稍后重试");
    if (existing.status === "failed") return reject(res,422,"上次生成中断，请重新发送");
    res.writeHead(200, {"Content-Type":"application/x-ndjson; charset=utf-8"});
    res.end(JSON.stringify({delta:existing.answer}) + "\n" + JSON.stringify({done:true,session:conversation,answer:existing.answer,replyFiles:journal.replyFiles(Number(existing.id))}) + "\n");
    return;
  }
  if (busy) return reject(res,409,"上一条消息仍在生成，请稍后重试");
  if (!fixturePort && memoryUnderPressure()) return reject(res,503,"服务器可用内存不足，请稍后重试");
  const stored = ids.length ? ids.map(id => journal.attachment(conversation,id)) : journal.contextFiles(conversation);
  if (ids.length && stored.some(f => !f)) return reject(res,404,"找不到这段对话的附件，请重新选择");
  const files = stored.filter((f): f is Attachment => !!f && f.expires > Date.now());
  if (ids.length && files.length !== ids.length) return reject(res,410,"附件已过期，请重新选择");
  const messages = journal.contextMessages(conversation);
  const id = journal.begin(conversation,request,question,ids);
  busy = true;
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  res.flushHeaders();
  const emit = (event: object) => res.write(JSON.stringify(event) + "\n");
  let failure = "生成失败，请稍后重试";
  let preflightFailure = false;
  const outputs = new ReplyFiles(retention,model.baseUrl,apiKey);
  const agent = newAgent(outputs,toolFileIds(conversation,files),files,promptForFiles(stored.length,files.length),messages,
    context => emit({context}), message => { failure = message; preflightFailure = true; });
  const initialMessageCount = agent.state.messages.length;
  const stop = () => agent.abort();
  res.once("close", stop);
  const timer = setTimeout(stop, 360000);
  let partial = "";
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      partial += event.assistantMessageEvent.delta;
      emit({ delta: event.assistantMessageEvent.delta });
    }
  });
  const heartbeat = setInterval(() => { if (!res.destroyed) emit({pending:true}); },15000);
  const started = Date.now();
  let committed = false;

  try {
    await agent.prompt(question);
    const last = agent.state.messages.at(-1);
    if (res.destroyed || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      const reason = last?.role === "assistant" ? last.errorMessage ?? "" : "";
      const code = reason.match(/\b(400|401|403|404|429|5[0-9]{2})\b/)?.[1];
      if (!preflightFailure && files.length && (code === "400" || code === "404" || code === "415" || code === "422")) {
        failure = "OpenAI 无法读取此附件，请重新选择文件或换一种格式";
      }
      console.warn("Model call failed", code || (reason.includes("Connection") ? "connection" : "generation"));
      throw new Error("Generation failed");
    }
    const text = last.content.filter(part => part.type === "text").map(part => part.text).join("");
    const answer = replyText(text,outputs.files);
    if (!answer.trim()) throw new Error("Model returned no visible reply");
    if (outputs.files.length) {
      last.content = [...last.content.filter(part => part.type !== "text"), {type:"text",
        text:answer+"\n回复附件："+outputs.files.map(f=>f.name).join("、")}];
    }
    journal.complete(id, answer, agent.state.messages.slice(initialMessageCount), ids as string[], outputs.files);
    committed = true;
    emit({ done:true, session:conversation, answer, replyFiles:journal.replyFiles(id) });
    console.info(JSON.stringify({event:"chat", owner:"mobile", model:model.id, thinkingLevel, status:"ok",
      durationMs:Date.now()-started, inputTokens:last.usage.input, outputTokens:last.usage.output,
      cacheRead:last.usage.cacheRead, cacheWrite:last.usage.cacheWrite}));
  } catch {
    if (committed) return;
    await outputs.discard().catch(() => console.warn("Could not clean staged reply files"));
    journal.fail(id,partial);
    console.info(JSON.stringify({event:"chat", owner:"mobile", status:"failed", durationMs:Date.now()-started}));
    if (!res.destroyed) emit({ error: failure });
  } finally {
    clearInterval(heartbeat);
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
  if (url.pathname === "/capabilities" && req.headers["x-piggy-owner"] === "admin" &&
      (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, {"Content-Type":"application/json"});
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(capabilityCatalog()));
    return;
  }
  if (url.pathname.startsWith("/reply-files/") && req.headers["x-piggy-owner"] === "mobile" &&
      (req.method === "GET" || req.method === "HEAD")) {
    const [, , conversation,key,...extra] = url.pathname.split("/");
    if (!uuid.test(conversation) || !key || extra.length) return reject(res,404,"附件不存在");
    void retention.serve(journal,key,false,req.method === "HEAD",res,conversation).catch(() => {
      if (!res.headersSent) reject(res,500,"附件暂时无法读取"); else res.destroy();
    });
    return;
  }
  const prefix = "/history/files/";
  if (url.pathname.startsWith(prefix) && req.headers["x-piggy-owner"] === "admin" &&
      (req.method === "GET" || req.method === "HEAD")) {
    void retention.serve(journal,url.pathname.slice(prefix.length),url.searchParams.get("download") === "1",
      req.method === "HEAD",res).catch(() => {
      if (!res.headersSent) reject(res,500,"附件暂时无法读取"); else res.destroy();
    });
    return;
  }
  if (url.pathname === "/history" && req.method === "GET" && req.headers["x-piggy-owner"] === "admin") {
    const cursor = (name: string) => url.searchParams.has(name) ? Number(url.searchParams.get(name)) : null;
    const after = cursor("after"), before = cursor("before");
    if ((after !== null && before !== null) ||
        [after,before].some(n => n !== null && (!Number.isSafeInteger(n) || n < 0))) return reject(res,400,"分页参数有误");
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({turns:journal.page(after,before)}));
  }
  if (req.headers["x-piggy-owner"] !== "mobile") return reject(res,405,"网页仅支持查看记录");
  if (url.pathname === "/attachments" && req.method === "POST") {
    if (!apiKey || (!fixturePort && memoryUnderPressure())) return reject(res,503,"服务暂时无法接收附件");
    void receiveAttachment(req,res,journal,retention,model.baseUrl,apiKey).catch(() => {
      if (!res.headersSent) reject(res,500,"附件服务暂时不可用");
    });
    return;
  }
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
  if (address && typeof address !== "string") console.log(`Piggy ready on port ${address.port} (model=${model.id}, thinking=${thinkingLevel})`);
});
