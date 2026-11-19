import * as core from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";

globalThis.PiAgentCore = core;
if (JSON.stringify(Object.keys(core).sort()) !== JSON.stringify(EXPECTED_CORE_EXPORTS)) {
  throw new Error("Incomplete pi-agent-core bundle");
}
const endpoint = "https://api.openai.com/v1/chat/completions";
const model = {
  id: "gpt-4.1-mini", name: "GPT-4.1 mini", api: "openai-completions", provider: "openai",
  baseUrl: "https://api.openai.com/v1", input: ["text"], reasoning: false,
  contextWindow: 1047576, maxTokens: 32768, cost: {input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0},
};

let transport;
let lastFailure;
let serial = 0;
const encoder = new TextEncoder();
function nativeFetch(url, init) {
  if (String(url) !== endpoint || init.method !== "POST" || typeof init.body !== "string") {
    throw new Error("Unsupported request");
  }
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const body = new ReadableStream({ start(controller) {
      transport = { id, resolve, reject, controller, gotHeaders: false };
    }});
    transport.body = body;
    PiggyNative.request(id, init.body);
  });
}
function network(id, type, value) {
  const t = transport;
  if (!t || t.id !== id) return;
  switch (type) {
    case "headers":
      t.gotHeaders = true;
      t.resolve(new Response(t.body, { status: 200, headers: {"content-type":"text/event-stream"} }));
      break;
    case "chunk": t.controller.enqueue(encoder.encode(value)); break;
    case "end": t.controller.close(); transport = undefined; break;
    case "error":
      lastFailure = value;
      if (t.gotHeaders) t.controller.error(new Error(value));
      else t.reject(new Error(value));
      transport = undefined;
      break;
  }
}
const agent = new core.Agent({
  initialState: { model, systemPrompt: "你是个人助手 Piggy。按用户使用的语言回答，清楚、简洁。" },
  // The real credential is attached by Kotlin only to the fixed HTTPS endpoint.
  getApiKey: () => "native-transport",
  streamFn: (m, context, options) => streamSimple(m, context, {
    ...options, fetch: nativeFetch, maxTokens: 2048, maxRetries: 0,
  }),
});
agent.subscribe(event => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    PiggyNative.delta(event.assistantMessageEvent.delta);
  }
});
async function prompt(text) {
  const previous = [...agent.state.messages];
  lastFailure = undefined;
  try {
    await agent.prompt(text);
    const last = agent.state.messages.at(-1);
    if (last?.role !== "assistant" || !["stop", "length"].includes(last.stopReason) ||
        !last.content.some(part => part.type === "text" && part.text)) throw new Error("Incomplete reply");
    PiggyNative.finished("");
  } catch {
    agent.state.messages = previous;
    PiggyNative.finished(lastFailure || "回复未完成，请重试");
  }
}
globalThis.PiggyAgent = { prompt, reset: () => agent.reset(), network };
PiggyNative.ready();
