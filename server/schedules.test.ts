import { Installation } from "./installation.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Schedules, nextOccurrence } from "./schedules.ts";

test("Shanghai cron, task controls and replay of a due tick",()=>{
  const now=Date.parse("2026-11-20T23:59:00Z");
  assert.equal(nextOccurrence("0 8 * * *",now),Date.parse("2026-11-21T00:00:00Z"));
  assert.equal(nextOccurrence("0 8 * * 1-5",now),Date.parse("2026-11-23T00:00:00Z"));
  assert.throws(()=>nextOccurrence("0 0 8 * * *",now));
  const db=new DatabaseSync(":memory:");
  const schedules=new Schedules(db,new Installation(db));
  const session=randomUUID();

  const task={name:"morning",prompt:"say hi",cron:"0 8 * * *",enabled:false};
  schedules.save(task);
  db.prepare("UPDATE schedules SET next=?").run(now);
  schedules.enqueue(now);
  assert.equal(schedules.snapshot().runs.length,0);
  assert.equal(schedules.snapshot().connected,false);
  db.prepare("INSERT INTO mobile_installation(id,key_hash,session) VALUES(1,'fixture',?)").run(session);
  schedules.save({...task,enabled:true},String(schedules.snapshot().tasks[0].id));
  db.prepare("UPDATE schedules SET next=?").run(now);
  schedules.enqueue(now);
  schedules.enqueue(now);
  assert.equal(schedules.snapshot().runs.length,1);
  db.close();
});
