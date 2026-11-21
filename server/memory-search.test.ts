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
