import type { Installation } from "./installation.ts";
import { Cron } from "croner";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { uuid } from "./attachments.ts";

const zone = "Asia/Shanghai";
export function nextOccurrence(expression:string, now:number) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some(field=>!/^[0-9*,/\-]+$/.test(field))) throw new Error("请填写五段数字 Cron 表达式");
  const date = new Cron(fields.join(" "), {timezone:zone,domAndDow:false}).nextRun(new Date(now));
  if (!date) throw new Error("表达式没有下一次执行时间");
  return date.getTime();
}

export class Schedules {
  readonly installation:Installation;
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync,installation:Installation) {
    this.db=db;
    this.installation=installation;
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,name TEXT NOT NULL,session TEXT NOT NULL,cron TEXT NOT NULL,prompt TEXT NOT NULL,enabled INTEGER NOT NULL,next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_runs(request TEXT PRIMARY KEY,task TEXT NOT NULL,name TEXT NOT NULL,session TEXT NOT NULL,prompt TEXT NOT NULL,due INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',UNIQUE(task,due));
      CREATE INDEX IF NOT EXISTS schedule_inbox ON scheduled_runs(session,request);`);
  }
  snapshot() {
    const session=this.installation.session()??"";
    return {connected:!!session,
      tasks:this.db.prepare("SELECT id,name,cron,prompt,enabled,next FROM schedules WHERE session IN (?,'') ORDER BY enabled DESC,next").all(session),
      runs:this.db.prepare("SELECT name,due,status FROM scheduled_runs WHERE session=? ORDER BY due DESC,rowid DESC LIMIT 40").all(session)};
  }
  save(data:any,id?:string) {
    if(typeof data?.prompt!=="string" || !data.prompt.trim() || data.prompt.length>1500 || typeof data.name!=="string" || !data.name.trim() || data.name.length>80 ||
       typeof data.enabled!=="boolean" || typeof data.cron!=="string" || data.cron.length>100) throw new Error("请检查任务名称、时间和指令");
    const next=nextOccurrence(data.cron,Date.now());
    const session=this.installation.session()??"";
    const values=[data.name.trim(),session,data.cron.trim(),data.prompt.trim(),Number(data.enabled),next];
    if(id) {
      if(!this.db.prepare("UPDATE schedules SET name=?,session=?,cron=?,prompt=?,enabled=?,next=? WHERE id=? AND session IN (?,'')").run(...values,id,session).changes) throw new Error("任务不存在");
    } else this.db.prepare("INSERT INTO schedules(name,session,cron,prompt,enabled,next,id) VALUES(?,?,?,?,?,?,?)").run(...values,randomUUID());
  }
  enqueue(now:number) {
    const session=this.installation.session();
    if(!session)return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for(const t of this.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next<=? AND session IN (?,'')").all(now,session)) {
        // Skip stale greetings after extended downtime and coalesce missed occurrences.
        this.db.prepare("INSERT OR IGNORE INTO scheduled_runs(request,task,name,session,prompt,due,status) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),t.id,t.name,session,t.prompt,t.next,now-Number(t.next)<300000?"queued":"missed");
        this.db.prepare("UPDATE schedules SET next=? WHERE id=?").run(nextOccurrence(String(t.cron),now),t.id);
      }
      this.db.exec("COMMIT");
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  inbox(data:any) {
    if(typeof data?.session!=="string" || !uuid.test(data.session) || !Number.isSafeInteger(data.after) || data.after<0) throw new Error("设备参数无效");
    return this.db.prepare(`SELECT t.id,t.answer,t.request,t.sticker_id AS stickerId FROM turns t JOIN scheduled_runs r ON t.request=r.request AND t.conversation=r.session
       WHERE t.conversation=? AND t.status='complete' AND t.id>? ORDER BY t.id LIMIT 40`).all(data.session,data.after);
  }
}

export async function scheduleRoute(store:Schedules,req:IncomingMessage,res:ServerResponse,path:string,replyFiles:(id:number)=>unknown) {
  let status=200,result:unknown;
  try {
    const mobile=path==="/inbox" && req.headers["x-piggy-owner"]==="mobile" && req.method==="POST";
    const admin=req.headers["x-piggy-owner"]==="admin" && /^\/schedules(?:\/[a-f0-9-]{36})?$/.test(path);
    if(!admin && !mobile) { status=403;throw new Error("无权访问"); }
    const id=path.split("/")[2];
    if(admin && !id && req.method==="GET") result=store.snapshot();
    else if(admin && id && req.method==="DELETE") {
      store.db.prepare("DELETE FROM schedules WHERE id=?").run(id);
      result={ok:true};
    } else if(mobile || (admin && req.method===(id?"PUT":"POST"))) {
      if(req.headers["content-type"]?.split(";")[0]!=="application/json") throw new Error("请使用 JSON");
      const chunks:Buffer[]=[]; let size=0;
      for await(const chunk of req) {size+=chunk.length;if(size>8192) throw new Error("请求太大");chunks.push(chunk);}
      const data=JSON.parse(Buffer.concat(chunks).toString());
      if(mobile && data?.session!==req.headers["x-piggy-session"]) {status=403;throw new Error("对话编号与当前安装不符");}
      if(mobile) result={messages:store.inbox(data).map(m=>({...m,replyFiles:replyFiles(Number(m.id))}))};
      else {store.save(data,id);result={ok:true};}
    } else {status=405;throw new Error("不支持此操作");}
  } catch(error) { if(status===200) status=400;result={error:error instanceof Error && !('code' in error)?error.message:"请求无效"}; }
  res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(result));
}
