import { saveFacts } from "./memory-planner.ts";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Journal } from "./journal.ts";

import type { MemoryIndex } from "./memory-index.ts";

const keywordsParameter = {type:"array",items:{type:"string",minLength:1,maxLength:100},minItems:1,maxItems:16} as const;

const offsetParameter = {type:"integer",minimum:0,description:"续读时传入上次返回的 nextOffset，首次省略。"} as const;

export const searchMemoryDeclaration = {
  name:"search_memory",
  description:"用自然语言在本会话的 OpenAI 向量库检索已保存的单条事实。最多返回 20 条相关候选，含记忆 ID、正文、证据摘录、来源轮次及相似度。",
  parameters:{type:"object",properties:{query:{type:"string",minLength:1,maxLength:4000,description:"直接表达想找的内容，可使用用户的原问题。"}},
    required:["query"],additionalProperties:false},
} as const;

export const searchChatDeclaration = {
  name:"search_chat_history",
  description:"在当前会话的完整聊天记录中用关键词搜索用户和助手的原文。",
  parameters:{type:"object",properties:{keywords:keywordsParameter,offset:offsetParameter},required:["keywords"],additionalProperties:false},
} as const;

export const readChatDeclaration = {
  name:"read_chat_context",
  description:"按记忆或聊天轮次编号读取来源原文及前后各两轮。需要核对历史附件原件时将 includeAttachments 设为 true，仅重读锚点轮次的有效附件。用返回的 turnId 可继续查看相邻轮次或较长原文。",
  parameters:{type:"object",properties:{source:{type:"string",enum:["memory","turn"]},id:{type:"integer",minimum:1},
    includeAttachments:{type:"boolean"},offset:offsetParameter},required:["source","id"],additionalProperties:false},
} as const;

export function memoryReadTools(journal:Journal, index:MemoryIndex, conversation:string, turn:number|bigint):AgentTool[] {
  const result = (value:unknown) => ({content:[{type:"text" as const,text:JSON.stringify(value)}],details:{}});
  return [
    {...searchMemoryDeclaration,label:"查找记忆", async execute(_id,params,signal) {
      const {query} = params as {query:string};
      return result(await index.search(conversation,query,signal));
    }},
    {...searchChatDeclaration,label:"搜索聊天记录", async execute(_id,params) {
      const {keywords,offset} = params as {keywords:string[];offset?:number};
      return result(journal.searchChatHistory(conversation,turn,keywords,offset));
    }},
    {...readChatDeclaration,label:"核对原始对话", async execute(_id,params) {
      const {source,id,offset,includeAttachments} = params as {source:"memory"|"turn";id:number;offset?:number;includeAttachments?:boolean};
      const context=journal.readChatContext(conversation,turn,source,id,offset);
      const recalledFiles=includeAttachments && context.anchorTurnId ? journal.turnFiles(context.anchorTurnId).filter(f=>f.expires>Date.now()) : [];
      return {...result(context),details:{recalledFiles}};
    }},
  ];
}

export const saveMemoryDeclaration = {
  name:"save_memory",
  description:"按用户本轮明确要求保存或更正记忆。服务端将原话整理为独立事实，分别建立索引，明确改口时更新对应事实。",
  parameters:{type:"object",properties:{text:{type:"string",description:"摘录用户要求记住的完整证据，包含限定词。"}},
    required:["text"],additionalProperties:false},
} as const;

export function memoryTool(journal:Journal, index:MemoryIndex, conversation:string, turn:number|bigint, question:string, previous:AgentMessage[],
    model:Model<"openai-responses">, key:string): AgentTool {
  return {...saveMemoryDeclaration,label:"保存记忆",executionMode:"sequential",
    async execute(_id,params,signal) {
      const {text:raw} = params as {text?:string};
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
      const ids=await saveFacts(journal.memories,index,conversation,Number(turn),question,text,previousSource,model,key,signal);
      try { for (const id of ids) await index.ensure(id); }
      catch { return {content:[{type:"text",text:"记忆已保存，仍在建立搜索索引。"}],details:{}}; }
      return {content:[{type:"text",text:"记忆已保存。记忆编号："+ids.join("、")}],details:{}};
    },
  };
}
