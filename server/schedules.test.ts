import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Schedules, nextOccurrence, sendVivo } from "./schedules.ts";

test("Shanghai cron, task controls and replay of a due tick",()=>{
  const now=Date.parse("2026-11-20T23:59:00Z");
  assert.equal(nextOccurrence("0 8 * * *",now),Date.parse("2026-11-21T00:00:00Z"));
  assert.equal(nextOccurrence("0 8 * * 1-5",now),Date.parse("2026-11-23T00:00:00Z"));
  assert.throws(()=>nextOccurrence("0 0 8 * * *",now));
  const db=new DatabaseSync(":memory:");
  const schedules=new Schedules(db);
  const session=randomUUID();
  db.prepare("INSERT INTO schedule_devices(session,model,seen) VALUES(?,'device',?)").run(session,now);
  const task={name:"morning",session,prompt:"say hi",cron:"0 8 * * *",enabled:false};
  schedules.save(task);
  db.prepare("UPDATE schedules SET next=?").run(now);
  schedules.enqueue(now);
  assert.equal(schedules.snapshot().runs.length,0);
  schedules.save({...task,enabled:true},String(schedules.snapshot().tasks[0].id));
  db.prepare("UPDATE schedules SET next=?").run(now);
  schedules.enqueue(now);
  schedules.enqueue(now);
  assert.equal(schedules.snapshot().runs.length,1);
  db.close();
});
test("vivo single-device notification uses the final text and requires acceptance",async t=>{
  t.mock.method(globalThis,"fetch",async(url:string,opts:RequestInit)=>{
    const data=JSON.parse(String(opts.body));
    if(url.endsWith("/auth")) return Response.json({result:0,authToken:"fixture-token"});
    assert.equal(url,"https://api-push.vivo.com.cn/message/send");
    assert.equal(data.regId,"fixture-device");
    assert.equal(data.pushMode,1);
    assert.equal(data.content,"早上好");
    assert.equal(opts.headers.authToken,"fixture-token");
    return Response.json({result:code});
  });
  let code=0;
  const values={VIVO_APP_ID:"123",VIVO_APP_KEY:"test",VIVO_APP_SECRET:"fixture"};
  for(const [key,value] of Object.entries(values)) {
    const old=process.env[key];process.env[key]=value;
    t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});
  }
  assert.equal(await sendVivo("fixture-device",randomUUID(),"早上好"),"accepted");
  code=10302;
  await assert.rejects(sendVivo("fixture-device",randomUUID(),"早上好"),/10302/);
});
