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


test("topic and partial legacy migration keeps active facts, sources and unimported records on restart",t=>{
  const dir=mkdtempSync(join(tmpdir(),"piggy-facts-")),path=join(dir,"journal.sqlite");
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(path);
  db.exec(`
    CREATE TABLE turns(id INTEGER PRIMARY KEY, conversation TEXT, request TEXT,created INTEGER,question TEXT,answer TEXT,status TEXT);
    INSERT INTO turns VALUES(1,'a','first',0,'我喜欢草莓','好','complete'),(2,'a','next',0,'我喜欢橙子','好','complete');
    CREATE TABLE memories(id INTEGER PRIMARY KEY,conversation TEXT,turn_id INTEGER,content TEXT,superseded_by INTEGER REFERENCES memories(id),
      vector_file TEXT,indexed INTEGER,retry_after INTEGER,keywords TEXT,categories TEXT);
    INSERT INTO memories VALUES(3,'a',1,'old',NULL,'file_old',1,0,'',''),(4,'a',2,'pending legacy',NULL,'file_keep',1,0,'',''),
      (5,'a',1,'superseded',3,NULL,0,0,'','');
    CREATE TABLE memory_topics(id INTEGER PRIMARY KEY, conversation TEXT,subject TEXT,label TEXT,vector_file TEXT);
    INSERT INTO memory_topics VALUES(10,'a','王子怡','喜欢的水果','file_topic');
    CREATE TABLE memory_members(id INTEGER,topic INTEGER REFERENCES memory_topics(id),value TEXT,turn_id INTEGER,active INTEGER);
    INSERT INTO memory_members VALUES(1,10,'草莓',1,1),(2,10,'橙子',2,1),(3,10,'芒果',2,0);
    CREATE TABLE memory_changes(id INTEGER,member INTEGER,turn_id INTEGER,quote TEXT);
    INSERT INTO memory_changes VALUES(1,1,1,'喜欢草莓'),(2,2,2,'喜欢橙子');
    CREATE TABLE memory_receipts(id INTEGER);
    CREATE TABLE memory_imports(legacy INTEGER); INSERT INTO memory_imports VALUES(3);
    CREATE TABLE memory_import_retry(id INTEGER);
    CREATE TABLE topic_stores(remote TEXT); INSERT INTO topic_stores VALUES('vs_old');
    CREATE TABLE retired_topic_files(file TEXT,retry_after INTEGER); INSERT INTO retired_topic_files VALUES('file_stale',0);
  `);
  for(let i=0;i<2;i++) {
    new Journal(path);
    const rows=db.prepare("SELECT id,content,quote,turn_id,vector_file,indexed FROM memories ORDER BY id").all();
    assert.deepEqual(rows.map(r=>[r.content,r.quote,r.turn_id,r.vector_file,r.indexed]),[
      ["pending legacy","pending legacy",2,"file_keep",1],["王子怡喜欢的水果：草莓。","喜欢草莓",1,null,0],
      ["王子怡喜欢的水果：橙子。","喜欢橙子",2,null,0]]);
    assert.equal(rows[0].id,4);assert.ok(Number(rows[1].id)>5);
    assert.deepEqual(db.prepare("SELECT path FROM retired_memory_resources ORDER BY path").all().map(r=>r.path),
      ["/files/file_old","/files/file_stale","/files/file_topic","/vector_stores/vs_old"]);
    assert.deepEqual(db.prepare("PRAGMA table_info(memories)").all().map(r=>r.name),
      ["id","conversation","turn_id","content","quote","vector_file","indexed","retry_after"]);
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%topic%' OR name IN ('memory_members','memory_imports','memory_changes','old_memories')").all(),[]);
  }
  db.close();
});

test("facts update in place, restore preferences, reject stale writes and isolate search results",async t=>{
  const j=new Journal(":memory:"), index=j.memoryIndex("https://fixture.invalid","fake");
  const save=(text:string,previous?:import("./memory-store.ts").Fact)=>{
    const turn=Number(j.begin("a",text+Math.random(),text));
    const [id]=j.memories.apply("a",turn,[{content:text,quote:text,previous}]);
    j.complete(turn,"好",[]);return {id,turnId:turn,content:text};
  };
  const uploaded:string[]=[];const deleted:string[]=[];
  t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    const path=new URL(url).pathname;
    if (path==="/vector_stores") return Response.json({id:"vs_a"});
    if (path==="/files") {
      uploaded.push(await ((init.body as FormData).get("file") as File).text());
      return Response.json({id:"file_"+uploaded.length});
    }
    if (path.endsWith("/search")) {
      assert.equal(JSON.parse(String(init.body)).max_num_results,20);
      return Response.json({data:["file_foreign","file_1","file_2","file_3","file_4","file_4"].map(file_id=>({file_id,score:.9}))});
    }
    if (init.method==="DELETE") {deleted.push(path);return Response.json({deleted:true});}
    if (init.method==="GET") return Response.json({},{status:404});
    return Response.json({status:"completed"});
  });
  const a=save("王子怡喜欢草莓"),b=save("王子怡喜欢橙子");
  await index.ensure(a.id);await index.ensure(b.id);
  const c=save("王子怡不再喜欢草莓",a);
  assert.equal(c.id,a.id);
  assert.deepEqual((await index.search("a","水果")).candidates.map(x=>x.id),[b.id]);
  await index.syncNext();
  assert.throws(()=>save("stale",a),/已变更/);
  const d=save(a.content,c);assert.equal(d.id,a.id);
  await index.syncNext();
  assert.deepEqual((await index.search("a","水果")).candidates.map(x=>[x.content,x.turnId]),[[b.content,b.turnId],[a.content,d.turnId]]);
  assert.deepEqual(deleted,["/files/file_1","/files/file_3"]);
  assert.deepEqual((await index.search("b","水果")).candidates,[]);
  assert.equal(j.readChatContext("a",999,"memory",d.id).anchorTurnId,d.turnId);
});

test("evidence produces independent facts and only a proposed matching ID may be updated",async t=>{
  const {saveFacts}=await import("./memory-planner.ts");
  const j=new Journal(":memory:"),index=j.memoryIndex("https://fixture.invalid","fake");
  const model={id:"fixture",baseUrl:"https://fixture.invalid"} as Parameters<typeof saveFacts>[7];
  let facts:{content:string;quote:string}[]=[], match=0;
  t.mock.method(globalThis,"fetch",async (_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    const result=body.text.format.name==="memory_extract"?{decision:"save",facts}:{decision:"save",id:match};
    return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(result)}]}]});
  });
  const save=async(quote:string)=>{
    const question="请记住"+quote,turn=Number(j.begin("a",String(Math.random()),question));
    const ids=await saveFacts(j.memories,index,"a",turn,question,quote,undefined,model,"fake");
    j.complete(turn,"好",[]);return ids;
  };
  facts=[{content:"王子怡喜欢草莓",quote:"草莓"},{content:"王子怡喜欢橙子",quote:"橙子"}];
  const [berry,orange]=await save("我喜欢草莓和橙子");
  facts=[{content:"王子怡现在不吃草莓",quote:"现在不吃草莓"}];match=999;
  await assert.rejects(save("我现在不吃草莓"),/核对/);
  match=berry;assert.deepEqual(await save("我现在不吃草莓"),[berry]);
  assert.deepEqual(j.memories.pending("a").sort((a,b)=>a.id-b.id).map(f=>[f.id,f.content]),[[berry,"王子怡现在不吃草莓"],[orange,"王子怡喜欢橙子"]]);
  await assert.rejects(save("我爱打球"),/原话/);
});
