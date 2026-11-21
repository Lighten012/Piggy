import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "./journal.ts";

test("index only saved originals, resume legacy and interrupted uploads and scope all search hits",async t => {
  const dir=mkdtempSync(join(tmpdir(),"piggy-vectors-"));
  const path=join(dir,"chat.sqlite"), sql=new DatabaseSync(path);
  t.after(()=>{sql.close();rmSync(dir,{force:true,recursive:true});});
  sql.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,conversation TEXT NOT NULL,turn_id INTEGER NOT NULL,
    created INTEGER NOT NULL,content TEXT NOT NULL,keywords TEXT,categories TEXT,UNIQUE(conversation,content));
    INSERT INTO memories VALUES(1,'a',1,1,'我喜欢吃草莓','["吃"]','["水果"]')`);
  const uploads:string[]=[], searches:string[]=[];
  let stores=0, rejectAttach=true;
  t.mock.method(globalThis,"fetch",async (url:string,init:RequestInit)=>{
    const path=new URL(url).pathname,method=init.method;
    if (path==="/vector_stores") return Response.json({id:"vs_"+ ++stores});
    if (path==="/files") {
      const file=(init.body as FormData).get("file") as File;
      uploads.push(await file.text());
      return Response.json({id:"file_"+uploads.length});
    }
    if (path.endsWith("/search")) {
      searches.push(path+":"+JSON.parse(String(init.body)).query);
      return Response.json({data:["file_2","file_1","file_1"].map(file_id=>({file_id,score:.9}))});
    }
    if (method==="GET") return Response.json({},{status:404});
    if (rejectAttach) {rejectAttach=false;return Response.json({},{status:503});}
    return Response.json({status:"completed"});
  });
  let journal=new Journal(path), index=journal.memoryIndex("https://fixture.invalid","fake");
  const source=journal.begin("a","save","请记住我喜欢吃草莓");journal.complete(source,"记住了",[]);
  const other=journal.begin("b","save","我只喝茶");
  const id=journal.saveMemory(other,"我只喝茶");
  assert.equal(journal.saveMemory(other,"我只喝茶"),id);
  journal.complete(other,"好",[]);
  const chat=journal.begin("a","news","今天的天气");journal.complete(chat,"晴天",[]);
  assert.deepEqual(await index.search("empty","水果"),{candidates:[],indexingPending:false});
  await assert.rejects(index.syncNext(),/503/);
  assert.equal((await index.search("a","水果")).indexingPending,true);
  journal=new Journal(path);index=journal.memoryIndex("https://fixture.invalid","fake");
  await Promise.all([index.ensure(1),index.ensure(1)]);
  await index.syncNext();
  assert.deepEqual(uploads,["我喜欢吃草莓","我只喝茶"]);
  assert.equal(stores,2);
  sql.exec("DELETE FROM active_context WHERE conversation='a'");
  const hits=await index.search("a","我喜欢什么水果？");
  assert.equal(hits.indexingPending,false);
  assert.deepEqual(hits.candidates.map(row=>row.text),["我喜欢吃草莓"]);
  assert.deepEqual((await index.search("b","饮品")).candidates.map(row=>row.text),["我只喝茶"]);
  assert.ok(searches.includes("/vector_stores/vs_1/search:我喜欢什么水果？"));
  assert.equal(journal.readChatContext("a",99,"memory",1).anchorTurnId,1);
  assert.deepEqual(journal.readChatContext("b",99,"memory",1).turns,[]);
  assert.equal(journal.searchChatHistory("a",99,["天气"]).matches.length,1);
  assert.equal(await index.syncNext(),false);
  const changed=journal.begin("a","changed","请记住我最喜欢梨");
  const pear=journal.saveMemory(changed,"我最喜欢梨",[1]);
  assert.deepEqual((await index.search("a","水果")).candidates,[]);
  journal.complete(changed,"好",[]);
  const again=journal.begin("a","again","请记住我喜欢吃草莓");
  assert.equal(journal.saveMemory(again,"我喜欢吃草莓",[pear]),1);
  await index.ensure(1);
  assert.deepEqual(uploads,["我喜欢吃草莓","我只喝茶"]);
  assert.deepEqual((await index.search("a","水果")).candidates.map(c=>c.text),["我喜欢吃草莓"]);
  assert.equal(journal.readChatContext("a",99,"memory",1).anchorTurnId,Number(again));
});

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

test("clean an already indexed vector database without resetting its remote references", t => {
  const dir=mkdtempSync(join(tmpdir(),"piggy-old-columns-"));
  const path=join(dir,"chat.sqlite"), db=new DatabaseSync(path);
  t.after(()=>{db.close();rmSync(dir,{force:true,recursive:true});});
  const journal=new Journal(path);
  const turn=journal.begin("phone","request","请记住草莓。");
  const id=journal.saveMemory(turn,"草莓");
  journal.complete(turn,"已保存",[]);
  db.exec(`
    ALTER TABLE memories ADD COLUMN keywords TEXT;
    ALTER TABLE memories ADD COLUMN categories TEXT;
    CREATE VIRTUAL TABLE memory_terms USING fts5(keywords,categories);
    CREATE TRIGGER memory_terms_update AFTER UPDATE OF keywords,categories ON memories BEGIN
      INSERT INTO memory_terms(rowid,keywords,categories) VALUES(new.id,new.keywords,new.categories);
    END;
    UPDATE memories SET keywords='草莓',categories='水果',vector_file='file_test',indexed=1;
    INSERT INTO memory_stores VALUES('phone','test','vs_test');
  `);
  const select="SELECT id,conversation,turn_id,created,content,vector_file,indexed,retry_after FROM memories";
  const before=db.prepare(select).all();
  for (let restart=0; restart<2; restart++) {
    const reopened=new Journal(path);
    assert.deepEqual(db.prepare("PRAGMA table_info(memories)").all().map(r=>r.name).sort(),[...Object.keys(before[0]),"superseded_by"].sort());
    assert.deepEqual(db.prepare(select).all(),before);
    assert.equal(db.prepare("SELECT remote FROM memory_stores WHERE conversation='phone'").get()?.remote,"vs_test");
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'memory_terms*'").get(),undefined);
    assert.equal(reopened.readChatContext("phone",99,"memory",id).anchorTurnId,Number(turn));
  }
});

test("preference reversal reuses a memory ID and anchors the active memory to the latest request", () => {
  const journal=new Journal(":memory:");
  const save=(conversation:string,request:string,text:string,replaces:number[]=[])=>{
    const turn=journal.begin(conversation,request,text);
    const id=journal.saveMemory(turn,text,replaces);
    assert.equal(journal.saveMemory(turn,text,replaces),id);
    journal.complete(turn,"好",[]);
    return {turn:Number(turn),id};
  };
  const first=save("a","1","咖啡加糖");
  const other=save("a","2","妈妈咖啡无糖");
  const dry=save("a","3","咖啡无糖",[first.id]);
  const back=save("a","4","咖啡加糖",[dry.id]);
  assert.equal(back.id,first.id);
  assert.equal(journal.readChatContext("a",99,"memory",back.id).anchorTurnId,back.turn);
  assert.equal(journal.readChatContext("a",99,"memory",other.id).anchorTurnId,other.turn);
  const turn=journal.begin("b","5","咖啡无糖");
  assert.throws(()=>journal.saveMemory(turn,"咖啡无糖",[back.id]),/有效记忆/);
  const next=journal.begin("a","6","核对");
  assert.throws(()=>journal.replacementSources(next,[dry.id]),/有效记忆/);
  assert.deepEqual(journal.replacementSources(next,[back.id,other.id]),["咖啡加糖","妈妈咖啡无糖"]);
});
