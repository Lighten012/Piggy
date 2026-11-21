import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "./journal.ts";

test("historical context remains scoped, paged and readable beyond a long excerpt", () => {
  const journal=new Journal(":memory:");
  const long="说明".repeat(800)+"最后的凭据 LILAC-25";
  const first=journal.begin("a","first","周五早餐喝咖啡");
  journal.complete(first,long,[]);
  for (let n=0;n<9;n++) {
    const turn=journal.begin("a",String(n),"咖啡 "+n);
    journal.complete(turn,"好",[]);
  }
  const current=journal.begin("a","last","请查之前喝什么");
  assert.equal(journal.searchChatHistory("a",current,["咖啡"],8).matches.length,2);
  assert.deepEqual(journal.searchChatHistory("a",current,["请查之前"]).matches,[]);
  assert.deepEqual(journal.searchChatHistory("b",current,["咖啡"]).matches,[]);
  assert.match(journal.searchChatHistory("a",current,["lilac"]).matches[0].answer,/LILAC-25/);
  const excerpt=journal.readChatContext("a",current,"turn",Number(first)).turns[0];
  const tail=journal.readChatContext("a",current,"turn",Number(first),excerpt.nextOffset).turns[0];
  assert.equal(excerpt.answer+tail.answer,long);
});


const fruit={subject:"王子怡",label:"喜欢吃的水果"};
const set=(key:string,value=key,group=fruit)=>({...group,action:"set" as const,key,value});

test("topic membership, pagination, source changes, replay and isolation",()=>{
  const j=new Journal(":memory:"), t=j.topics;
  function save(request:string,edits:import("./memory-topics.ts").Edit[]) {
    const source={conversation:"a",turn:Number(j.begin("a",request,request)),quote:request};
    const snapshot=t.catalog("a");
    const result=t.apply(source,edits,snapshot);
    assert.deepEqual(t.apply(source,edits,snapshot),result);
    j.complete(source.turn,"好",[]);
    return {id:result[0],turn:source.turn};
  }
  const first=save("一批水果",Array.from({length:57},(_,i)=>set("水果"+i)));
  const page=t.page("a",first.id);
  assert.equal(page.entries.length,50);
  assert.equal(t.page("a",first.id,Number(page.nextAfter)).entries.length,7);
  const confirmed=save("再记一次", [set("水果0")]);
  const conditional=save("只喜欢冰过的水果1",[set("水果1","仅冰过的水果1")]);
  save("不再喜欢水果2",[{...set("水果2"),action:"remove"}]);
  save("妈妈喜欢水果2",[set("水果2","水果2",{subject:"王子怡的妈妈",label:fruit.label})]);
  save("喜欢橙汁",[set("橙汁","橙汁",{subject:fruit.subject,label:"喜欢喝的饮品"})]);
  const restored=save("又喜欢水果2",[set("水果2")]);
  const rows=t.page("a",first.id).entries;
  assert.deepEqual(rows.slice(0,3).map(m=>[m.value,m.turnId]),[["水果0",confirmed.turn],["仅冰过的水果1",conditional.turn],["水果2",restored.turn]]);
  assert.equal(rows[3].turnId,first.turn);
  assert.equal(t.page("a").entries.length,3);
  assert.deepEqual(t.page("b",first.id).entries,[]);
  const source={conversation:"a",turn:Number(j.begin("a","bad","invalid")),quote:"invalid"};
  assert.throws(()=>t.apply(source,[set("回滚"),{...set("不存在"),action:"remove"}],t.catalog("a")));
  assert(!t.members("a",fruit).some(m=>m.key==="回滚"));
});

test("import active legacy evidence once; preserve archived text, refresh vectors and ignore stale hits",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"piggy-topics-")); const path=join(dir,"journal.sqlite");
  let j=new Journal(path);
  const db=new DatabaseSync(path);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  for (const [i,quote] of ["我喜欢草莓","我也喜欢橙子","旧偏好"].entries()) {
    const id=j.begin("a",String(i),quote);j.complete(id,"好",[]);
    db.prepare("INSERT INTO memories(conversation,turn_id,created,content,superseded_by) VALUES('a',?,0,?,?)").run(id,quote,i===2?1:null);
  }
  let uploads=0, fail=true;const deleted:string[]=[];
  t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    const path=new URL(url).pathname;
    if (path==="/vector_stores") return Response.json({id:"vs_test"});
    if (path==="/files") {
      const text=await ((init.body as FormData).get("file") as File).text();
      assert.ok(text.includes("王子怡喜欢吃的水果：草莓"));
      return Response.json({id:"file_"+ ++uploads});
    }
    if (path.endsWith("/search")) return Response.json({data:["file_1","file_2","file_2"].map(file_id=>({file_id,score:.9}))});
    if (init.method==="DELETE") {deleted.push(path);return Response.json({deleted:true});}
    if (init.method==="GET") return Response.json({},{status:404});
    if (fail) {fail=false;return Response.json({},{status:503});}
    return Response.json({status:"completed"});
  });
  let topics=j.topics, s=topics.nextLegacy()!;
  const [id]=topics.apply(s,[set("草莓")],topics.catalog("a"));
  let index=j.memoryIndex("https://fixture.invalid","fake");
  await assert.rejects(index.ensure(id),/503/);
  j=new Journal(path);topics=j.topics;index=j.memoryIndex("https://fixture.invalid","fake");
  await Promise.all([index.ensure(id),index.ensure(id)]);
  assert.equal(uploads,1);
  s=topics.nextLegacy()!;
  topics.apply(s,[set("橙子")],topics.catalog("a"));
  assert.deepEqual((await index.search("a","水果")).candidates,[]);
  assert.equal(topics.nextLegacy(),undefined);
  await index.syncNext();
  assert.deepEqual(deleted,["/files/file_1"]);
  const hits=await index.search("a","水果");
  assert.deepEqual(hits.candidates.map(x=>x.text),["王子怡喜欢吃的水果：草莓、橙子。"]);
  const source={conversation:"a",turn:Number(j.begin("a","confirm","再确认")),quote:"草莓"};
  topics.apply(source,[set("草莓")],topics.catalog("a"));
  await index.ensure(id);
  assert.equal(uploads,2);
  assert.equal(topics.page("a").entries.length,1);
  assert.equal(j.readChatContext("a",99,"memory",1).anchorTurnId,1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories").get()?.n,3);
  assert.deepEqual(topics.page("a",id).entries.map(m=>m.turnId),[source.turn,2]);
});

test("legacy schema cleanup preserves old source and remote IDs across restarts",t=>{
  const dir=mkdtempSync(join(tmpdir(),"piggy-old-columns-")), path=join(dir,"journal.sqlite");
  const db=new DatabaseSync(path);
  t.after(()=>{db.close();rmSync(dir,{force:true,recursive:true});});
  new Journal(path);
  db.exec(`
    ALTER TABLE memories ADD COLUMN keywords TEXT;
    ALTER TABLE memories ADD COLUMN categories TEXT;
    CREATE VIRTUAL TABLE memory_terms USING fts5(keywords,categories);
    CREATE TRIGGER memory_terms_update AFTER UPDATE OF keywords,categories ON memories BEGIN
      INSERT INTO memory_terms(rowid,keywords,categories) VALUES(new.id,new.keywords,new.categories);
    END;
    INSERT INTO turns(id,conversation,request,created,question,status) VALUES(1,'a','save',1,'请记住我喜欢草莓','complete');
    INSERT INTO memories(conversation,turn_id,created,content,vector_file,indexed,keywords,categories)
      VALUES('a',1,1,'我喜欢草莓','file_original',1,'草莓','水果');
    INSERT INTO memory_stores VALUES('a','original','vs_original');
  `);
  for (let restart=0;restart<2;restart++) {
    const j=new Journal(path);
    assert.equal(j.topics.nextLegacy()?.quote,"我喜欢草莓");
    assert.equal(j.readChatContext("a",99,"memory",1).anchorTurnId,1);
    assert.equal(db.prepare("SELECT vector_file FROM memories").get()?.vector_file,"file_original");
    assert.equal(db.prepare("SELECT remote FROM memory_stores").get()?.remote,"vs_original");
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name GLOB 'memory_terms*'").get(),undefined);
  }
});
