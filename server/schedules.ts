import { Cron } from "croner";
import { randomUUID, createHash } from "node:crypto";
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
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS schedule_devices(session TEXT PRIMARY KEY, model TEXT NOT NULL, reg TEXT, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,name TEXT NOT NULL,session TEXT NOT NULL,cron TEXT NOT NULL,prompt TEXT NOT NULL,enabled INTEGER NOT NULL,next INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_runs(request TEXT PRIMARY KEY,task TEXT NOT NULL,name TEXT NOT NULL,session TEXT NOT NULL,prompt TEXT NOT NULL,due INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',push TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,retry INTEGER NOT NULL DEFAULT 0,UNIQUE(task,due));
      CREATE INDEX IF NOT EXISTS schedule_inbox ON scheduled_runs(session,request);`);
  }
  snapshot() {
    return {devices:this.db.prepare("SELECT session,model,seen,reg IS NOT NULL AS registered FROM schedule_devices ORDER BY seen DESC").all(),
      tasks:this.db.prepare("SELECT * FROM schedules ORDER BY enabled DESC,next").all(),
      runs:this.db.prepare("SELECT name,due,status,push FROM scheduled_runs ORDER BY due DESC,rowid DESC LIMIT 40").all(),
      configured:!!(process.env.VIVO_APP_ID && process.env.VIVO_APP_KEY && process.env.VIVO_APP_SECRET)};
  }
  save(data:any,id?:string) {
    if(typeof data?.prompt!=="string" || !data.prompt.trim() || data.prompt.length>1500 || typeof data.name!=="string" || !data.name.trim() || data.name.length>80 ||
       typeof data.enabled!=="boolean" || typeof data.cron!=="string" || data.cron.length>100 || typeof data.session!=="string" ||
       !this.db.prepare("SELECT 1 FROM schedule_devices WHERE session=?").get(data.session)) throw new Error("请检查任务名称、接收设备和指令");
    const next=nextOccurrence(data.cron,Date.now());
    const values=[data.name.trim(),data.session,data.cron.trim(),data.prompt.trim(),Number(data.enabled),next];
    if(id) {
      if(!this.db.prepare("UPDATE schedules SET name=?,session=?,cron=?,prompt=?,enabled=?,next=? WHERE id=?").run(...values,id).changes) throw new Error("任务不存在");
    } else this.db.prepare("INSERT INTO schedules(name,session,cron,prompt,enabled,next,id) VALUES(?,?,?,?,?,?,?)").run(...values,randomUUID());
  }
  enqueue(now:number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for(const t of this.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next<=?").all(now)) {
        // Skip stale greetings after extended downtime and coalesce missed occurrences.
        this.db.prepare("INSERT OR IGNORE INTO scheduled_runs(request,task,name,session,prompt,due,status) VALUES(?,?,?,?,?,?,?)").run(randomUUID(),t.id,t.name,t.session,t.prompt,t.next,now-Number(t.next)<300000?"queued":"missed");
        this.db.prepare("UPDATE schedules SET next=? WHERE id=?").run(nextOccurrence(String(t.cron),now),t.id);
      }
      this.db.exec("COMMIT");
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  inbox(data:any) {
    if(typeof data?.session!=="string" || !uuid.test(data.session) || !Number.isSafeInteger(data.after) || data.after<0 ||
      typeof data.model!=="string" || data.model.length>100 || (data.reg!=null && (typeof data.reg!=="string" || !/^[a-zA-Z0-9_:-]{12,200}$/.test(data.reg)))) throw new Error("设备参数无效");
    this.db.prepare(`INSERT INTO schedule_devices(session,model,reg,seen) VALUES(?,?,?,?) ON CONFLICT(session) DO UPDATE SET model=excluded.model,reg=excluded.reg,seen=excluded.seen`).run(data.session,data.model,data.reg??null,Date.now());
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
      if(mobile) result={messages:store.inbox(data).map(m=>({...m,replyFiles:replyFiles(Number(m.id))}))};
      else {store.save(data,id);result={ok:true};}
    } else {status=405;throw new Error("不支持此操作");}
  } catch(error) { if(status===200) status=400;result={error:error instanceof Error && !('code' in error)?error.message:"请求无效"}; }
  res.writeHead(status,{"Content-Type":"application/json"});res.end(JSON.stringify(result));
}

async function vivoPost(path:string,data:object,token?:string) {
  const response=await fetch("https://api-push.vivo.com.cn/message/"+path,{method:"POST",headers:{"Content-Type":"application/json",...(token?{authToken:token}:{})},
    body:JSON.stringify(data),signal:AbortSignal.timeout(8000)});
  if(!response.ok) throw new Error("vivo HTTP "+response.status);
  const body=await response.json();
  if(body.result!==0) throw new Error("vivo "+Number(body.result));
  return body;
}
let cachedToken:{value:string,until:number}|undefined;
export async function sendVivo(reg:string,request:string,text:string) {
  const key=process.env.VIVO_APP_KEY, secret=process.env.VIVO_APP_SECRET, appId=Number(process.env.VIVO_APP_ID);
  if(!appId || !key || !secret) return "unconfigured";
  const timestamp=Date.now();
  if(!cachedToken || cachedToken.until<=timestamp) {
    const sign=createHash("md5").update(String(appId)+key+timestamp+secret).digest("hex");
    const {authToken}=await vivoPost("auth",{appId,appKey:key,timestamp,sign});
    if(typeof authToken!=="string" || !authToken) throw new Error("vivo auth");
    cachedToken={value:authToken,until:timestamp+3600000};
  }
  const preview=Array.from(text.trim().replace(/\s+/g," ")||"[表情]");
  const title=preview.slice(0,16).join("");
  await vivoPost("send",{appId,regId:reg,requestId:request.replaceAll("-",""),notifyType:1,skipType:1,
    title:preview.length>16?title:"Piggy",content:preview.slice(preview.length>16?16:0,80).join(""),timeToLive:600,category:process.env.VIVO_CATEGORY||"SUBSCRIPTION",
    pushMode:process.env.PIGGY_RELEASE_ENVIRONMENT==="production"?0:1},cachedToken.value);
  return "accepted";
}
