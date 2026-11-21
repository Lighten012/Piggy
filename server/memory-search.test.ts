import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "./journal.ts";

test("legacy keywords, scoped recall and original turns survive compaction and restart", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-recall-"));
  t.after(() => rmSync(dir,{force:true,recursive:true}));
  const path = join(dir,"test.sqlite");
  const sql = new DatabaseSync(path);
  sql.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,conversation TEXT NOT NULL,turn_id INTEGER NOT NULL,
    created INTEGER NOT NULL,content TEXT NOT NULL,UNIQUE(conversation,content));
    INSERT INTO memories VALUES(1,'a',2,1,'我喝咖啡喜欢燕麦奶')`);
  let journal = new Journal(path);
  const first = journal.begin("a","1","周五早餐喝咖啡");
  const long = "说明".repeat(800)+"最后的凭据 LILAC-25";
  journal.complete(first,long,[]);
  const save = journal.begin("a","2","帮我记下刚才那条");
  journal.saveMemory(save,"聚会喝咖啡要全脂奶",["喝","咖啡","全脂奶","无关词"]);
  journal.complete(save,"已保存",[]);
  const outsider = journal.begin("b","1","保密信息：咖啡");
  journal.saveMemory(outsider,"咖啡",["咖啡"]);
  journal.complete(outsider,"只有另一台手机能读",[]);
  const recent = journal.begin("a","3","请查之前喝什么");
  sql.exec("DELETE FROM active_context WHERE conversation='a'");
  const tags = sql.prepare("SELECT keywords FROM memories WHERE id=?");
  assert.ok(JSON.parse(String(tags.get(1)!.keywords)).includes("喝"));
  assert.ok(JSON.parse(String(tags.get(2)!.keywords)).includes("全脂奶"));
  assert.ok(!JSON.parse(String(tags.get(2)!.keywords)).includes("无关词"));
  const memories = journal.searchMemory("a",["燕麦奶","咖啡"]).candidates;
  assert.deepEqual(memories.map(x=>x.memoryId),[1,2]);
  assert.deepEqual(journal.searchMemory("a",['" OR *','无此项']).candidates,[]);
  assert.deepEqual(journal.searchMemory("a",["的",""]).candidates,[]);
  assert.deepEqual(journal.readChatContext("b",recent,"memory",1).turns,[]);
  assert.deepEqual(journal.readChatContext("b",recent,"turn",Number(first)).turns,[]);
  assert.deepEqual(journal.searchChatHistory("a",recent,["保密信息"]).matches,[]);
  assert.deepEqual(journal.searchChatHistory("a",recent,["请查之前"]).matches,[]);
  const match = journal.searchChatHistory("a",recent,["lilac"]).matches[0];
  assert.equal(match.turnId,Number(first));
  assert.match(match.answer,/LILAC-25/);
  const context = journal.readChatContext("a",recent,"memory",1);
  assert.equal(context.anchorTurnId,Number(save));
  assert.deepEqual(context.turns.map(x=>x.turnId),[Number(first),Number(save)]);
  const rest = journal.readChatContext("a",recent,"turn",Number(first),context.turns[0].nextOffset);
  assert.equal(context.turns[0].answer + rest.turns[0].answer,long);
  journal = new Journal(path);
  assert.equal(journal.searchMemory("a",["燕麦奶"]).candidates[0].memoryId,1);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM memory_terms").get()!.n,3);
  sql.close();
});

test("later pages are reachable for tied keyword matches", () => {
  const journal = new Journal(":memory:");
  for (let n=0;n<10;n++) {
    const id = journal.begin("a",String(n),"咖啡");
    journal.saveMemory(id,"咖啡 "+n,["咖啡"]);
    journal.complete(id,"好的",[]);
  }
  const first = journal.searchMemory("a",["咖啡"]);
  assert.equal(first.candidates.length,8);
  const rest = journal.searchMemory("a",["咖啡"],first.nextOffset);
  assert.equal(rest.candidates.length,2);
  assert.equal(new Set([...first.candidates,...rest.candidates].map(row=>row.memoryId)).size,10);
  assert.equal(journal.searchChatHistory("a",11,["咖啡"],8).matches.length,2);
});

test("category-only and exact recall preserve evidence, source, scope and pagination", () => {
  const db = new Journal(":memory:");
  function save(session:string,text:string,tags:string[]) {
    const turn = db.begin(session,text,"记住："+text);
    db.saveMemory(turn,text,[],tags);
    db.complete(turn,"好",[]);
    return Number(turn);
  }
  const strawberry = save("a","我喜欢吃草莓",["水果","食物"]);
  save("a","我不喜欢芒果",["水果","食物"]);
  save("a","妈妈喜欢桃子",["水果","食物"]);
  save("a","我只喜欢草莓味蛋糕",["蛋糕","甜点"]);
  save("a","我的苹果手机坏了",["手机","电子产品"]);
  save("b","我喜欢吃香蕉",["水果"]);
  const entries = db.searchMemory("a",["水果"]).candidates;
  assert.deepEqual(entries.map(e=>e.text).sort(),["妈妈喜欢桃子","我不喜欢芒果","我喜欢吃草莓"].sort());
  const hit = entries.find(e=>e.text==="我喜欢吃草莓")!;
  assert.deepEqual(hit.categories,["水果","食物"]);
  assert.equal(db.readChatContext("a",99,"memory",Number(hit.memoryId)).anchorTurnId,strawberry);
  assert.ok(db.searchMemory("a",["草莓"]).candidates.some(e=>e.memoryId===hit.memoryId));
  for (let i=0;i<9;i++) save("a","活动 "+i,["运动"]);
  const first = db.searchMemory("a",["运动"]);
  assert.equal(first.candidates.length,8);
  assert.equal(db.searchMemory("a",["运动"],first.nextOffset).candidates.length,1);
});
