import { createModels, type Model } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export interface ModelSettings { model: string; effort: string; tier: string }
export type ReplyMode = "chat" | "work";
export const isReplyMode = (value: unknown): value is ReplyMode => value === "chat" || value === "work";
export const defaultWorkSettings: ModelSettings = {model:"gpt-6.2-astra", effort:"high", tier:"default"};
interface Choice { id: string; name: string; efforts: string[]; tiers: string[]; offLabel?: string }

const family = new Map<string,Model<"openai-responses">>();
const choices: Choice[] = [];
const baseUrl = "https://api.openai.com/v1";

for (const [id, name, input] of [
  ["gpt-6.2-sol", "GPT-6.2 Sol", 2], ["gpt-6.2-astra", "GPT-6.2 Astra", 8],
] as const) {
  family.set(id, {id, name, provider:"openai", api:"openai-responses", baseUrl, input:["text","image"],
    reasoning:true, contextWindow:1050000, maxTokens:128000,
    cost:{input, output:input*5, cacheRead:input*.05, cacheWrite:input*1.25,
      tiers:[{inputTokensAbove:272000,input:input*2,output:input*7.5,cacheRead:input*.1,cacheWrite:input*2.5}]}});
  choices.push({id, name, efforts:["low","medium","high","xhigh","max"], tiers:["default","priority","ultrafast"]});
}

const initialId = process.env.PI_MODEL || "gpt-6.2-sol";
const registry = createModels();
registry.setProvider(openaiProvider());
const effortLevels = ["off","low","medium","high","xhigh","max"] as const;
const catalogIds = [
  "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini",
  "gpt-4.1", "gpt-4.1-mini",
];
for (const id of catalogIds) {
  const model = registry.getModel("openai",id);
  if (!model || model.api !== "openai-responses") throw new Error(`Missing Responses model: ${id}`);
  // Piggy supplies effort per request; keep the same wire format for counting and generation.
  family.set(id,{...model,api:"openai-responses",compat:undefined,baseUrl});
  const efforts: string[] = model.reasoning
    ? effortLevels.filter(level => model.thinkingLevelMap?.[level] != null)
    : ["off"];
  const tiers = ["default","priority"];
  if (id === "gpt-6.1-sol" || id === "gpt-6-astra") tiers.push("ultrafast");
  // Previous PI_MODEL deployments stored "off" to omit the effort parameter.
  const legacyDefault = id === initialId && !efforts.includes("off");
  if (legacyDefault) efforts.unshift("off");
  choices.push({id, name:model.name, efforts, tiers, ...(legacyDefault ? {offLabel:"模型默认"} : {})});
}
if (!family.has(initialId)) {
  // Preserve deployments using a previous Pi catalog model and its original effort.
  const legacy = registry.getModel("openai",initialId);
  if (!legacy) throw new Error("Unknown PI_MODEL");
  family.set(initialId,{...legacy,api:"openai-responses",compat:undefined,baseUrl});
  choices.push({id:initialId,name:legacy.name,efforts:["off"],tiers:["default"]});
}
export const modelChoices = choices;
export const defaultSettings: ModelSettings = {
  model:initialId, effort:["gpt-6.2-sol","gpt-6.2-astra"].includes(initialId) ? "high" : "off", tier:"default",
};
export function validSettings(value: unknown): value is ModelSettings {
  if (!value || typeof value !== "object") return false;
  const {model,effort,tier} = value as ModelSettings;
  const choice = choices.find(c => c.id === model);
  return !!choice && choice.efforts.includes(effort) && choice.tiers.includes(tier);
}
export function resolveModel(settings: ModelSettings, url: string): Model<"openai-responses"> {
  return {...family.get(settings.model)!,baseUrl:url};
}
