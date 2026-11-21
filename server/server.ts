import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { contextLimit, ContextError, prepareHistory, summarize } from "./compaction.ts";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { receiveAttachment, uuid } from "./attachments.ts";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { ReplyFiles, replyText } from "./reply-files.ts";
import { responseTools } from "./hosted-tools.ts";
import { WebSearch } from "./web-search.ts";
import { Retention } from "./retention.ts";
import { Journal, type Attachment } from "./journal.ts";
import { readFileSync } from "node:fs";
import { toolDeclarations, capabilityCatalog, loadedSkills } from "./capabilities.ts";
import { memoryTool, memoryReadTools } from "./memory.ts";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { defaultSettings, modelChoices, resolveModel, validSettings, type ModelSettings } from "./model-settings.ts";
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

// Only a loopback test fixture may override OpenAI's address.
const fixturePort = process.env.PI_LOCAL_FIXTURE_PORT;
if (fixturePort && (!/^\d{1,5}$/.test(fixturePort) || process.env.PI_API_KEY)) {
  throw new Error("The local fixture requires a port and an empty PI_API_KEY.");
}
const baseUrl = fixturePort ? `http://127.0.0.1:${fixturePort}/v1` : "https://api.openai.com/v1";
const apiKey = fixturePort ? "local-fixture-only" : process.env.PI_API_KEY;
function activeSettings() {
  const current = journal.modelSettings() ?? defaultSettings;
  if (!validSettings(current)) throw new Error("Unsupported stored model settings");
  return current;
}
const persona = "你是个人助手 Piggy。按用户使用的语言回答，清楚、简洁。遇到新闻、需要核实的近期变化或用户明确要求联网时，使用网页搜索核实，按来源的发布日期和事件日期回答，提供可点击的行内出处。无法查证时如实说明。用户要求图片或可下载的文件时，调用对应工具实际生成。使用代码解释器生成的文件请在最终答复中链接到 sandbox:/mnt/data/ 下的成品。";
function addFiles(input: unknown[], files: Attachment[]) {
  if (!files.length) return;
  const user = input.findLast((item): item is {role:"user"; content:unknown} =>
    typeof item === "object" && item !== null && "role" in item && item.role === "user");
  if (!Array.isArray(user?.content)) throw new Error("Missing attachment message");
  for (const file of files) user.content.push(file.image ? {type:"input_image",file_id:file.remote,detail:"auto"} :
    {type:"input_file",file_id:file.remote});
}
class ProviderWindowExceeded extends Error {}
async function countInput(model: Model<"openai-responses">, input: unknown[], tools?: unknown[], signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(model.baseUrl + "/responses/input_tokens", {
    method: "POST", headers: {authorization: "Bearer " + apiKey, "content-type": "application/json"},
    body: JSON.stringify({model:model.id, input, tools}), signal: signal ? AbortSignal.any([signal,timeout]) : timeout,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    if (error?.error?.code === "context_length_exceeded") throw new ProviderWindowExceeded();
    throw new Error("Input count HTTP " + response.status);
  }
  const { input_tokens: used } = await response.json();
  if (!Number.isSafeInteger(used) || used < 0) throw new Error("Invalid input count");
  return {used, limit:contextLimit};
}
async function countChatInput(model:Model<"openai-responses">, input:unknown[], tools:unknown[], signal?:AbortSignal) {
  try {
    return await countInput(model,input,tools,signal);
  } catch (error) {
    signal?.throwIfAborted();
    const temporary = error instanceof TypeError || error instanceof Error &&
      (error.name === "TimeoutError" || /^Input count HTTP (408|5\d\d)$/.test(error.message));
    if (!temporary) throw error;
  }
  await delay(300,undefined,{signal});
  return countInput(model,input,tools,signal);
}
function toolFileIds(conversation: string, files: Attachment[]) {
  const previous = journal.previousOutputs(conversation).filter(f => f.until > Date.now());
  return [...files.map(f => f.remote), ...previous.map(f => f.remote)];
}
function promptForFiles(stored: number, available: number) {
  const prompt = [persona, ...loadedSkills.map(skill => skill.instructions)].join("\n\n");
  const today = new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(Date.now());
  return prompt + "\n当前北京时间日期：" + today + "。" + (available < stored ? " 部分附件已过期；如需原文，请用户重新上传。" : "");
}
type ContextUsage = Awaited<ReturnType<typeof countInput>>;
function wireInput(model: Model<"openai-responses">, systemPrompt:string, messages:Message[], files:Attachment[]) {
  const input = convertResponsesMessages(model, normalizeContext({systemPrompt,messages}), new Set(["openai"]));
  addFiles(input,files);
  return input;
}
function countFailure(files:Attachment[], error:unknown) {
  return files.length && error instanceof Error && /HTTP (400|404|415|422)$/.test(error.message)
    ? "无法统计此附件的上下文，请减少附件内容或更换文件后重试"
    : "暂时无法核对上下文用量，请稍后重试";
}
function newAgent(agentTools:AgentTool[], model: Model<"openai-responses">, settings: ModelSettings, outputs: ReplyFiles, search: WebSearch, availableIds: string[], files: Attachment[], systemPrompt: string, count: (input: unknown[], tools: unknown[], signal?:AbortSignal) => Promise<ContextUsage>,
    reportTier: (tier: string) => void, measured: (usage: ContextUsage) => void,
    rejectGeneration: (message: string) => void) {
  // Pi 1.5.2 has no max effort; onPayload applies the exact OpenAI setting.
  const thinkingLevel = (settings.effort === "max" ? "xhigh" : settings.effort) as "off"|"low"|"medium"|"high"|"xhigh";
  return new Agent({
    initialState: { systemPrompt, model, thinkingLevel, tools:agentTools },
    getApiKey: () => apiKey,
    streamFn: (_model, context, options) => streamResponses(model, context, {
      ...options, maxTokens: thinkingLevel === "off" ? 2048 : 16384, maxRetries: 0,
      onProviderStreamEvent: async event => {
        const e = event as {type:string;response?:{service_tier?:string}};
        if (e.type === "response.completed" && typeof e.response?.service_tier === "string") reportTier(e.response.service_tier);
        search.observe(event);
        await outputs.observe(event,options?.signal);
      },
      async onPayload(payload) {
        const body = payload as {service_tier?:string; reasoning?:{effort?:string}; tools?:unknown[]; input: {role?:string; content?:unknown}[]};
        body.service_tier = settings.tier;
        if (settings.effort !== "off") body.reasoning = {...body.reasoning,effort:settings.effort};
        const input = body.input;
        const tools = body.tools = [...(body.tools ?? []), ...responseTools(availableIds)];
        addFiles(input, files);
        let usage: ContextUsage;
        try { usage = await count(input, tools, options?.signal); }
        catch (error) {
          rejectGeneration(countFailure(files,error));
          throw error;
        }
        measured(usage);
        if (usage.used > usage.limit) {
          const message = `本次输入共 ${usage.used.toLocaleString("en-US")} tokens，超过 ${usage.limit.toLocaleString("en-US")} 上限，请缩短消息或减少附件。`;
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
  const settings = activeSettings();
  const model = resolveModel(settings,baseUrl);
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
      const input = wireInput(model,promptForFiles(stored.length,files.length),messages,files);
      const tools = convertResponsesTools(toolDeclarations, {supportsStrictMode:true});
      const usage = await countInput(model, input, [...tools, ...responseTools(toolFileIds(data.session,files))]);
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
  const turns = journal.contextTurns(conversation);
  const id = journal.begin(conversation,request,question,ids);
  busy = true;
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  res.flushHeaders();
  const emit = (event: object) => res.write(JSON.stringify(event) + "\n");
  let failure = "生成失败，请稍后重试";
  let preflightFailure = false;
  const outputs = new ReplyFiles(retention,model.baseUrl,apiKey);
  const search = new WebSearch();
  let actualTier: string | undefined;
  const availableIds = toolFileIds(conversation,files);
  const systemPrompt = promptForFiles(stored.length,files.length);
  const declared = convertResponsesTools(toolDeclarations, {supportsStrictMode:true});
  const tools = [...declared, ...responseTools(availableIds)];
  const controller = new AbortController();
  let cache: {input:unknown[]; tools:unknown[]; usage:ContextUsage} | undefined;
  async function count(input:unknown[], tools:unknown[], signal?:AbortSignal) {
    if (cache && isDeepStrictEqual(input,cache.input) && isDeepStrictEqual(tools,cache.tools)) return cache.usage;
    const usage = await countChatInput(model,input,tools,signal);
    cache = {input,tools,usage};
    return usage;
  }
  const toolsForTurn = [memoryTool(journal,id,question,turns.at(-1)?.messages ?? [],model,apiKey), ...memoryReadTools(journal,conversation,id)];
  const agent = newAgent(toolsForTurn,model,settings,outputs,search,availableIds,files,systemPrompt,count,
    tier => { actualTier = tier; }, context => emit({context}), message => { failure = message; preflightFailure = true; });
  const stop = () => { controller.abort(); agent.abort(); };
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
    const current:Message = {role:"user",content:question,timestamp:Date.now()};
    const prepared = await prepareHistory(turns,async history => {
      const input = wireInput(model,systemPrompt,[...history,current],files);
      try { return (await count(input,tools,controller.signal)).used; }
      catch (error) {
        if (error instanceof ProviderWindowExceeded) return Infinity;
        throw new ContextError(countFailure(files,error));
      }
    }, prefix => summarize(model,apiKey!,prefix,controller.signal), controller.signal);
    controller.signal.throwIfAborted();
    agent.state.messages = [...agent.state.messages,...prepared.messages];
    const initialMessageCount = agent.state.messages.length;
    await agent.prompt(current);
    const last = agent.state.messages.at(-1);
    if (res.destroyed || last?.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
      const reason = last?.role === "assistant" ? last.errorMessage ?? "" : "";
      const code = reason.match(/\b(400|401|403|404|429|5[0-9]{2})\b/)?.[1];
      if (!preflightFailure && settings.tier !== "default" && /service.tier|ultrafast|priority|fast mode/i.test(reason)) {
        failure = "所选加速档位暂不可用，请在网页管理端切回标准速度或稍后重试";
      } else if (!preflightFailure && files.length && (code === "400" || code === "404" || code === "415" || code === "422")) {
        failure = "OpenAI 无法读取此附件，请重新选择文件或换一种格式";
      }
      console.warn("Model call failed", code || (reason.includes("Connection") ? "connection" : "generation"));
      throw new Error("Generation failed");
    }
    for (const part of last.content) if (part.type === "text") part.text = search.render(part.text);
    const text = last.content.filter(part => part.type === "text").map(part => part.text).join("");
    const answer = replyText(text,outputs.files);
    if (!answer.trim()) throw new Error("Model returned no visible reply");
    if (outputs.files.length) {
      last.content = [...last.content.filter(part => part.type !== "text"), {type:"text",
        text:answer+"\n回复附件："+outputs.files.map(f=>f.name).join("、")}];
    }
    journal.complete(id, answer, agent.state.messages.slice(initialMessageCount), ids as string[], outputs.files, prepared.replacement);
    committed = true;
    emit({ done:true, session:conversation, answer, replyFiles:journal.replyFiles(id) });
    console.info(JSON.stringify({event:"chat", owner:"mobile", model:model.id, thinkingLevel:settings.effort, requestedTier:settings.tier, actualTier, status:"ok", compacted:!!prepared.replacement, webSearchUsed:search.used,
      durationMs:Date.now()-started, inputTokens:last.usage.input, outputTokens:last.usage.output,
      cacheRead:last.usage.cacheRead, cacheWrite:last.usage.cacheWrite}));
  } catch (error) {
    if (committed) return;
    if (error instanceof ContextError) {
      failure = error.message;
      if (error.used !== undefined && Number.isFinite(error.used)) emit({context:{used:error.used,limit:contextLimit}});
    }
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
async function saveSettings(req: IncomingMessage, res: ServerResponse) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") return reject(res,415,"请使用 JSON 请求");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2048) return reject(res,413,"设置内容太大");
    parts.push(chunk);
  }
  let settings: unknown;
  try { settings = JSON.parse(Buffer.concat(parts).toString()); }
  catch { return reject(res,400,"设置格式有误"); }
  if (!validSettings(settings)) return reject(res,400,"此模型、思考强度或速度组合不可用");
  journal.saveModelSettings(settings);
  res.writeHead(200,{"Content-Type":"application/json"});
  res.end(JSON.stringify(activeSettings()));
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
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({...capabilityCatalog(), models:modelChoices, active:activeSettings()}));
    return;
  }
  if (url.pathname === "/model-settings" && req.headers["x-piggy-owner"] === "admin" && req.method === "PUT") {
    void saveSettings(req,res).catch(() => reject(res,500,"模型设置未保存，请重试"));
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
    void receiveAttachment(req,res,journal,retention,baseUrl,apiKey).catch(() => {
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
  if (address && typeof address !== "string") console.log(`Piggy ready on port ${address.port} (model=${activeSettings().model}, thinking=${activeSettings().effort})`);
});
