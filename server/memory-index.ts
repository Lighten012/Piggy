import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface MemoryRow { id:number; conversation:string; content:string; vector_file:string|null; indexed:number }
interface Store { namespace:string; remote:string|null }

// The durable queue is the memory table itself. Only confirmed memories can enter it.
export class MemoryIndex {
  private db:DatabaseSync;
  private syncing = new Map<number,Promise<void>>();
  private creating = new Map<string,Promise<string>>();
  private readonly url:string;
  private readonly key:string;
  constructor(db:DatabaseSync, baseUrl:string, apiKey:string) {
    this.db = db;
    this.url = baseUrl;
    this.key = apiKey;
  }

  static migrate(db:DatabaseSync) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(db.prepare("PRAGMA table_info(memories)").all().map(row => row.name));
      db.exec(`
        DROP TRIGGER IF EXISTS memory_terms_insert;
        DROP TRIGGER IF EXISTS memory_terms_update;
        DROP TRIGGER IF EXISTS memory_terms_delete;
        DROP TABLE IF EXISTS memory_terms;
      `);
      if (!columns.has("superseded_by")) db.exec("ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)");
      if (columns.has("keywords")) db.exec("ALTER TABLE memories DROP COLUMN keywords");
      if (columns.has("categories")) db.exec("ALTER TABLE memories DROP COLUMN categories");
      if (!columns.has("vector_file")) {
        db.exec(`
          ALTER TABLE memories ADD COLUMN vector_file TEXT;
          ALTER TABLE memories ADD COLUMN indexed INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE memories ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0;
          CREATE UNIQUE INDEX memory_remote ON memories(vector_file) WHERE vector_file IS NOT NULL;
          CREATE INDEX memory_pending ON memories(retry_after,id) WHERE indexed=0;
          CREATE TABLE memory_stores(conversation TEXT PRIMARY KEY,namespace TEXT NOT NULL UNIQUE,remote TEXT);
        `);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private async request(path:string, method="GET", body?:unknown, idempotency?:string, signal?:AbortSignal) {
    const form = body instanceof FormData;
    const timeout = AbortSignal.timeout(20000);
    const response = await fetch(this.url+path,{method,
      headers:{authorization:"Bearer "+this.key,...(body && !form ? {"content-type":"application/json"} : {}),
        ...(idempotency ? {"Idempotency-Key":idempotency} : {})},
      body:form ? body : body===undefined ? undefined : JSON.stringify(body),
      signal:signal ? AbortSignal.any([timeout,signal]) : timeout});
    if (!response.ok) {
      await response.body?.cancel();
      if (method==="GET" && response.status===404) return null;
      throw new Error("记忆向量服务暂时不可用（HTTP "+response.status+"）。");
    }
    return response.json();
  }

  private async store(conversation:string) {
    this.db.prepare("INSERT INTO memory_stores(conversation,namespace) VALUES(?,?) ON CONFLICT DO NOTHING").run(conversation,randomUUID());
    const row=this.db.prepare("SELECT namespace,remote FROM memory_stores WHERE conversation=?").get(conversation) as unknown as Store;
    if (row.remote) return row.remote;
    const pending=this.creating.get(conversation);
    if (pending) return pending;
    const create=(async()=>{
      const {id}=await this.request("/vector_stores","POST",{name:"piggy-memory-"+row.namespace},row.namespace);
      if (typeof id!=="string" || !id) throw new Error("向量库创建失败。");
      this.db.prepare("UPDATE memory_stores SET remote=? WHERE conversation=?").run(id,conversation);
      return id as string;
    })();
    this.creating.set(conversation,create);
    try { return await create; } finally { this.creating.delete(conversation); }
  }

  private async index(id:number) {
    const row=this.db.prepare("SELECT id,conversation,content,vector_file,indexed FROM memories WHERE id=?").get(id) as unknown as MemoryRow;
    if (!row || row.indexed) return;
    const store=await this.store(row.conversation);
    let file=row.vector_file;
    if (!file) {
      const form=new FormData();
      form.append("purpose","assistants");
      form.append("file",new Blob([row.content],{type:"text/plain"}),"memory-"+id+".txt");
      const uploaded=await this.request("/files","POST",form,store+"-memory-"+id);
      if (typeof uploaded.id!=="string" || !uploaded.id) throw new Error("记忆原文上传失败。");
      file=uploaded.id as string;
      this.db.prepare("UPDATE memories SET vector_file=? WHERE id=?").run(file,id);
    }
    const path="/vector_stores/"+encodeURIComponent(store)+"/files";
    const entry=path+"/"+encodeURIComponent(file);
    let state=await this.request(entry);
    if (!state) state=await this.request(path,"POST",{file_id:file});
    for (let attempt=0;state?.status==="in_progress" && attempt<6;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,1000));
      state=await this.request(entry);
    }
    if (state?.status==="failed" || state?.status==="cancelled") {
      // This file belongs to this memory; reattach it on the next retry.
      await this.request(entry,"DELETE");
    }
    if (state?.status!=="completed") throw new Error("记忆等待向量索引。");
    this.db.prepare("UPDATE memories SET indexed=1 WHERE id=? AND vector_file=?").run(id,file);
  }

  async ensure(id:number) {
    const pending=this.syncing.get(id);
    if (pending) return pending;
    const job=this.index(id);
    this.syncing.set(id,job);
    try { await job; } catch (error) {
      this.db.prepare("UPDATE memories SET retry_after=? WHERE id=? AND indexed=0").run(Date.now()+60000,id);
      throw error;
    } finally { this.syncing.delete(id); }
  }

  async syncNext() {
    const row=this.db.prepare("SELECT id FROM memories WHERE superseded_by IS NULL AND indexed=0 AND retry_after<=? ORDER BY retry_after,id LIMIT 1").get(Date.now());
    if (row) await this.ensure(Number(row.id));
    return !!row;
  }

  async search(conversation:string, query:string, signal?:AbortSignal) {
    if (!query.trim()) throw new Error("请输入要查找的问题。");
    const pending=!!this.db.prepare("SELECT 1 FROM memories WHERE conversation=? AND superseded_by IS NULL AND indexed=0 LIMIT 1").get(conversation);
    const store=this.db.prepare("SELECT remote FROM memory_stores WHERE conversation=?").get(conversation)?.remote;
    if (!store) return {candidates:[],indexingPending:pending};
    const response=await this.request("/vector_stores/"+encodeURIComponent(String(store))+"/search","POST",
      {query:query.trim(),max_num_results:20},undefined,signal);
    if (!Array.isArray(response?.data)) throw new Error("记忆检索返回格式异常。");
    const lookup=this.db.prepare("SELECT id,created,content FROM memories WHERE conversation=? AND vector_file=? AND superseded_by IS NULL");
    const seen=new Set<string>();
    const candidates=[];
    for (const hit of response.data) {
      if (typeof hit.file_id!=="string" || seen.has(hit.file_id)) continue;
      const row=lookup.get(conversation,hit.file_id);
      if (!row) continue;
      seen.add(hit.file_id);
      const text=String(row.content);
      const passage=hit.content?.find((part:{text?:string})=>typeof part.text==="string" && text.includes(part.text))?.text;
      candidates.push({memoryId:row.id,created:row.created,text:text.length<=1600 ? text : (passage || text).slice(0,1600),score:hit.score});
    }
    return {candidates,indexingPending:pending};
  }
}
