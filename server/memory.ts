import { organize } from "./memory-planner.ts";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Journal } from "./journal.ts";

import type { MemoryIndex } from "./memory-index.ts";

const keywordsParameter = {type:"array",items:{type:"string",minLength:1,maxLength:100},minItems:1,maxItems:16} as const;

const offsetParameter = {type:"integer",minimum:0,description:"续读时传入上次返回的 nextOffset，首次省略。"} as const;

export const searchMemoryDeclaration = {
  name:"search_memory",
  description:"通过本会话的 OpenAI 向量库检索已保存的记忆。query 接收问题原文。返回相关主题、topicId、正文片段和索引状态。需要完整清单用 read_memory_topic。",
  parameters:{type:"object",properties:{query:{type:"string",minLength:1,maxLength:4000,description:"直接表达想找的内容，可使用用户的原问题。"}},
    required:["query"],additionalProperties:false},
} as const;

export const readTopicDeclaration = {
  name:"read_memory_topic",description:"从 SQLite 列举当前会话的主题，或按 topicId 分页读出完整成员和各自的来源 turnId。省略 topicId 列目录，nextAfter 用于续页。",
  parameters:{type:"object",properties:{topicId:{type:"integer",minimum:1},after:{type:"integer",minimum:0}},additionalProperties:false},
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
      return result({...await index.search(conversation,query,signal),migrationPending:!!journal.topics.nextLegacy(conversation)});
    }},
    {...readTopicDeclaration,label:"读取完整记忆主题",async execute(_id,params) {
      const {topicId,after}=params as {topicId?:number;after?:number};
      return result(journal.topics.page(conversation,topicId,after));
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
  description:"按用户本轮明确请求，将证据交给服务端 AI 整理为主题成员，合并、更新并记录来源。text 是证据摘录。",
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
      if (journal.topics.nextLegacy(conversation)) throw new Error("旧记忆正在整理，请稍后重试保存。");
      const ids=await organize(journal.topics,{conversation,turn:Number(turn),quote:text},question,previousSource,model,key,signal);
      try { for (const id of ids) await index.ensure(id); }
      catch { return {content:[{type:"text",text:"主题记忆已更新，向量索引仍在处理中，可直接从主题目录读取。"}],details:{}}; }
      return {content:[{type:"text",text:"记忆已更新。主题编号："+ids.join("、")}],details:{}};
    },
  };
}
