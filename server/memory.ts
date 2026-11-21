import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Journal } from "./journal.ts";

import { classifyMemory } from "./memory-classification.ts";

const keywordsParameter = {type:"array",items:{type:"string",minLength:1,maxLength:100},minItems:1,maxItems:16} as const;

const offsetParameter = {type:"integer",minimum:0,description:"续读时传入上次返回的 nextOffset，首次省略。"} as const;

export const searchMemoryDeclaration = {
  name:"search_memory",
  description:"用具体对象、原文关键词或上位类别（如水果、运动）检索本会话已保存的记忆，返回候选供你判断。",
  parameters:{type:"object",properties:{keywords:{...keywordsParameter,description:"优先使用问题的主题或类别。只问喜欢什么水果时检索“水果”，避免以“喜欢”泛搜所有偏好。"},offset:offsetParameter},
    required:["keywords"],additionalProperties:false},
} as const;

export const searchChatDeclaration = {
  name:"search_chat_history",
  description:"在当前会话的完整聊天记录中用关键词搜索用户和助手的原文。",
  parameters:{type:"object",properties:{keywords:keywordsParameter,offset:offsetParameter},required:["keywords"],additionalProperties:false},
} as const;

export const readChatDeclaration = {
  name:"read_chat_context",
  description:"按记忆或聊天轮次编号读取来源原文及前后各两轮。用返回的 turnId 可继续查看相邻轮次或较长原文。",
  parameters:{type:"object",properties:{source:{type:"string",enum:["memory","turn"]},id:{type:"integer",minimum:1},
    offset:offsetParameter},required:["source","id"],additionalProperties:false},
} as const;

export function memoryReadTools(journal:Journal, conversation:string, turn:number|bigint):AgentTool[] {
  const result = (value:unknown) => ({content:[{type:"text" as const,text:JSON.stringify(value)}],details:{}});
  return [
    {...searchMemoryDeclaration,label:"查找记忆", async execute(_id,params) {
      const {keywords,offset} = params as {keywords:string[];offset?:number};
      return result(journal.searchMemory(conversation,keywords,offset));
    }},
    {...searchChatDeclaration,label:"搜索聊天记录", async execute(_id,params) {
      const {keywords,offset} = params as {keywords:string[];offset?:number};
      return result(journal.searchChatHistory(conversation,turn,keywords,offset));
    }},
    {...readChatDeclaration,label:"核对原始对话", async execute(_id,params) {
      const {source,id,offset} = params as {source:"memory"|"turn";id:number;offset?:number};
      return result(journal.readChatContext(conversation,turn,source,id,offset));
    }},
  ];
}

export const saveMemoryDeclaration = {
  name:"save_memory",
  description:"将用户在本轮明确要求记下的文字保存到本会话的长期记忆。",
  parameters:{type:"object",properties:{text:{type:"string",description:"逐字摘取要保存的内容，包含原有的限定条件。"},
    keywords:{...keywordsParameter,description:"从要存的原文提取的关键词，保留有意义的单字动作和完整专名、复合词。"}},
    required:["text","keywords"],additionalProperties:false},
} as const;

export function memoryTool(journal:Journal, turn:number|bigint, question:string, previous:AgentMessage[],
    model:Model<"openai-responses">, key:string): AgentTool {
  return {...saveMemoryDeclaration,label:"保存记忆",executionMode:"sequential",
    async execute(_id,params,signal) {
      const {text:raw,keywords} = params as {text?:string;keywords:string[]};
      const text = typeof raw==="string" ? raw.trim() : "";
      if (!text) throw new Error("请提供要保存的原文。");
      let previousSource:string|undefined;
      if (!question.includes(text)) {
        for (const message of previous) {
          if (message.role!=="user" && message.role!=="assistant") continue;
          const source = typeof message.content === "string" ? message.content :
            message.content.flatMap(part => part.type==="text" ? [part.text] : []).join("\n");
          if (source.includes(text)) {
            previousSource = source;
            break;
          }
        }
        if (!previousSource) throw new Error("请逐字引用本条消息或上一轮中用户要求记下的内容。");
      }
      const decision = await classifyMemory(model,key,text,{question,previousSource},signal);
      if (!decision.authorized)
        throw new Error("用户本轮没有明确授权保存这段内容。");
      signal?.throwIfAborted();
      journal.saveMemory(turn,text,keywords,decision.categories);
      return {content:[{type:"text",text:"记忆已保存。"}],details:{}};
    },
  };
}
