import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

interface MemoryRow { id:number; conversation:string; content:string; vector_file:string|null; indexed:number; turn_id:number }
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
      if ((method==="GET" || method==="DELETE") && response.status===404) return null;
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
    const row=this.db.prepare("SELECT id,conversation,content,vector_file,indexed,turn_id FROM memories WHERE id=?").get(id) as unknown as MemoryRow;
    if (!row || row.indexed || !row.content) return;
    const store=await this.store(row.conversation);
    let file=row.vector_file;
    if (!file) {
      const form=new FormData();
      form.append("purpose","assistants");
      form.append("file",new Blob([row.content],{type:"text/plain"}),"memory-"+id+".txt");
      const uploaded=await this.request("/files","POST",form,store+"-fact-"+id+"-"+createHash("sha256").update(row.content).digest("hex")+"-"+row.turn_id);
      if (typeof uploaded.id!=="string" || !uploaded.id) throw new Error("记忆原文上传失败。");
      file=uploaded.id as string;
      if (!this.db.prepare("UPDATE memories SET vector_file=? WHERE id=? AND content=? AND vector_file IS NULL").run(file,id,row.content).changes) {
        this.db.prepare("INSERT OR IGNORE INTO retired_memory_resources(path) VALUES(?)").run("/files/"+file);
        return;
      }
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
    // A second save can change the fact while its previous revision is uploading.
    // Let both callers wait until the current content is searchable.
    while (this.db.prepare("SELECT 1 FROM memories WHERE id=? AND indexed=0").get(id)) {
      const pending=this.syncing.get(id);
      if (pending) { await pending; continue; }
      const job=this.index(id);
      this.syncing.set(id,job);
      try { await job; } catch (error) {
        this.db.prepare("UPDATE memories SET retry_after=? WHERE id=? AND indexed=0").run(Date.now()+60000,id);
        throw error;
      } finally { this.syncing.delete(id); }
    }
  }

  async syncNext() {
    const row=this.db.prepare("SELECT id FROM memories WHERE indexed=0 AND retry_after<=? ORDER BY retry_after,id LIMIT 1").get(Date.now());
    if (row) await this.ensure(Number(row.id));
    const retired=this.db.prepare("SELECT path FROM retired_memory_resources WHERE retry_after<=? LIMIT 1").get(Date.now());
    if (retired) {
      try {
        await this.request(String(retired.path),"DELETE");
        this.db.prepare("DELETE FROM retired_memory_resources WHERE path=?").run(retired.path);
      } catch {
        this.db.prepare("UPDATE retired_memory_resources SET retry_after=? WHERE path=?").run(Date.now()+60000,retired.path);
      }
    }
    return !!row || !!retired;
  }

  async search(conversation:string, query:string, signal?:AbortSignal) {
    if (!query.trim()) throw new Error("请输入要查找的问题。");
    const pending=!!this.db.prepare("SELECT 1 FROM memories WHERE conversation=? AND indexed=0 LIMIT 1").get(conversation);
    const store=this.db.prepare("SELECT remote FROM memory_stores WHERE conversation=?").get(conversation)?.remote;
    if (!store) return {candidates:[],indexingPending:pending};
    const response=await this.request("/vector_stores/"+encodeURIComponent(String(store))+"/search","POST",
      {query:query.trim(),max_num_results:20},undefined,signal);
    if (!Array.isArray(response?.data)) throw new Error("记忆检索返回格式异常。");
    const lookup=this.db.prepare("SELECT id,turn_id AS turnId,content,quote FROM memories WHERE conversation=? AND vector_file=?");
    const seen=new Set<string>();
    const candidates=[];
    for (const hit of response.data) {
      if (typeof hit.file_id!=="string" || seen.has(hit.file_id)) continue;
      const row=lookup.get(conversation,hit.file_id);
      if (!row) continue;
      seen.add(hit.file_id);
      candidates.push({id:Number(row.id),content:String(row.content),turnId:Number(row.turnId),quote:String(row.quote),score:hit.score});
      if (candidates.length===20) break;
    }
    return {candidates,indexingPending:pending};
  }
}
