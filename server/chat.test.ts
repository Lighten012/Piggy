import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { capabilityCatalog } from "./capabilities.ts";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "./journal.ts";

test("records accepted mobile turns and restores context after restart", async t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-test-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const histories: string[][] = [];
  const fileInputs: string[][] = [];
  const fixture = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-6.2-sol");
    fileInputs.push(payload.input.flatMap((item: {content?:{file_id?:string}[]}) =>
      Array.isArray(item.content) ? item.content.flatMap(part => part.file_id ? [part.file_id] : []) : []));
    const users = payload.input.filter((item: {role?:string}) => item.role === "user")
      .map((item: {content:{text:string}[]}) => item.content.map(part => part.text).join(""));
    assert.ok(payload.input.some((item: {role?:string;content:unknown}) =>
      item.role === "developer" && JSON.stringify(item.content).includes("个人助手 Piggy")));
    if (users.at(-1) === "turn 101") {
      const replies = payload.input.filter((item: {role?:string}) => item.role === "assistant");
      assert.equal(replies.length,100);
    }
    if (req.url === "/v1/responses/input_tokens") {
      if (users.at(-1) === "unknown") { res.writeHead(503); res.end(); return; }
      const tokens = users.at(-1) === "overflow" ? 300001 : users.at(-1) === "exact" ? 300000 : users.length + 10;
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({input_tokens:tokens}));
      return;
    }
    assert.equal(req.url, "/v1/responses");
    assert.equal(payload.reasoning.effort, "high");
    assert.equal(payload.max_output_tokens, 16384);
    histories.push(users);
    if (histories.length === 2) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Test failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = {type:"message",id:"msg_"+histories.length,role:"assistant",status:"completed",
      content:[{type:"output_text",text:"OK",annotations:[]}]};
    for (const event of [
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.output_text.delta",output_index:0,delta:"OK"},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id:"resp_fixture",status:"completed",output:[item]}},
    ]) res.write("data: " + JSON.stringify(event) + "\n\n");
    res.end("data: [DONE]\n\n");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(() => fixture.close());
  async function start() {
    const child = spawn(process.execPath, [process.env.PIGGY_TEST_BUNDLE || "server.ts"], {
      env: {...process.env, PIGGY_WORKER_TOKEN:"fixture-worker",HOST:"127.0.0.1",PORT:"0", PI_API_KEY:"", PI_MODEL:"gpt-6.2-sol",
        PIGGY_DB:join(dir,"test.sqlite"),PI_LOCAL_FIXTURE_PORT:String((fixture.address() as AddressInfo).port)},
      stdio:["ignore","pipe","inherit"]
    });
    t.after(()=>child.kill());
    const [line] = await once(child.stdout,"data");
    const port = String(line).match(/port (\d+)/)?.[1];
    assert.ok(port);
    return {child,base:"http://127.0.0.1:"+port};
  }
  let worker = await start();
  const auth = {authorization:"Bearer fixture-worker","content-type":"application/json"};
  const mobile = {...auth,"x-piggy-owner":"mobile"}, admin = {...auth,"x-piggy-owner":"admin"};
  const session = randomUUID();
  async function send(text:string, request = randomUUID(), context = session) {
    const res = await fetch(worker.base+"/chat",{method:"POST",headers:mobile,body:JSON.stringify({text,session:context,request})});
    assert.equal(res.status,200);
    return (await res.text()).trim().split("\n").map(line=>JSON.parse(line));
  }
  assert.equal((await fetch(worker.base+"/capabilities")).status,401);
  assert.notEqual((await fetch(worker.base+"/capabilities",{headers:mobile})).status,200);
  assert.deepEqual(await (await fetch(worker.base+"/capabilities",{headers:admin})).json(),capabilityCatalog());
  assert.equal((await fetch(worker.base+"/history")).status,401);
  assert.notEqual((await fetch(worker.base+"/history",{headers:mobile})).status,200);
  assert.equal((await fetch(worker.base+"/chat",{method:"POST",headers:admin})).status,405);
  const request = randomUUID();
  const first = await send("one",request);
  assert.deepEqual(first[0].context,{used:11,limit:300000});
  assert.equal(first[1].delta,"OK");
  assert.equal(first.at(-1).session,session);
  assert.deepEqual(await send("one",request),first.slice(1));
  assert.equal(histories.length,1);
  assert.ok((await send("failed")).at(-1).error);
  const stopped = once(worker.child,"exit");worker.child.kill();await stopped;
  worker = await start();
  assert.equal((await send("two")).at(-1).session,session);
  assert.deepEqual(histories[2],["one","two"]);
  await send("separate",randomUUID(),randomUUID());
  assert.deepEqual(histories[3],["separate"]);
  const list = await (await fetch(worker.base+"/history",{headers:admin})).json();
  assert.deepEqual(list.turns.map(r=>[r.question,r.answer,r.status]),[
    ["one","OK","complete"],["failed","","failed"],["two","OK","complete"],["separate","OK","complete"]]);
  assert.deepEqual(Object.keys(list.turns[0]).sort(),["answer","created","filename","files","filesize","id","question","status"]);
  assert.equal((await (await fetch(worker.base+"/history?after=2",{headers:admin})).json()).turns.length,2);
  const preview = await fetch(worker.base+"/context",{method:"POST",headers:mobile,body:JSON.stringify({session})});
  assert.deepEqual(await preview.json(),{used:12,limit:300000});
  const calls = histories.length;
  const over = await send("overflow");
  assert.deepEqual(over[0].context,{used:300001,limit:300000});
  assert.match(over.at(-1).error,/300,001/);
  assert.match((await send("unknown")).at(-1).error,/核对上下文/);
  assert.equal(histories.length,calls);
  assert.equal((await send("exact")).at(-1).done,true);

  const fileSession = randomUUID(), id = randomUUID();
  const db = new Journal(join(dir,"test.sqlite"));
  db.saveAttachment(fileSession,{id,name:"notes.pdf",size:50,image:0,remote:"file-notes",expires:Date.now()+60000});
  const withFile = await fetch(worker.base+"/chat",{method:"POST",headers:mobile,body:JSON.stringify({
    text:"read",session:fileSession,attachments:[id]})});
  assert.match(await withFile.text(),/"done":true/);
  assert.deepEqual(fileInputs.slice(-2),[["file-notes"],["file-notes"]]);
  const filePreview = await fetch(worker.base+"/context",{method:"POST",headers:mobile,body:JSON.stringify({session:fileSession})});
  assert.equal(filePreview.status,200);
  assert.deepEqual(fileInputs.at(-1),["file-notes"]);

  const longSession = randomUUID();
  const questions = Array.from({length:100}, (_,i) => "turn "+(i+1));
  for (const question of questions) assert.equal((await send(question,randomUUID(),longSession)).at(-1).done,true);
  const counted = await fetch(worker.base+"/context",{method:"POST",headers:mobile,body:JSON.stringify({session:longSession})});
  assert.deepEqual(await counted.json(),{used:110,limit:300000});
  assert.equal((await send("turn 101",randomUUID(),longSession)).at(-1).done,true);
  assert.deepEqual(histories.at(-1),[...questions,"turn 101"]);

});

test("history pages and interrupted turns survive reopening SQLite", t => {
  const dir=mkdtempSync(join(tmpdir(),"piggy-pages-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,"test.sqlite");
  const journal=new Journal(path);
  for(let i=1;i<=45;i++){
    const id=journal.begin("phone",String(i),"question"+i);
    journal.complete(id,"ok",[{role:"user",content:"question"+i,timestamp:i}]);
  }
  journal.begin("phone","46","interrupted");
  const reopened=new Journal(path);
  assert.equal(reopened.lookup("phone","46")?.status,"failed");
  assert.equal(reopened.page(null,null)[0].id,7);
  assert.equal(reopened.page(null,7).length,6);
  const context=reopened.contextMessages("phone");
  assert.equal(context.length,45);
  assert.equal(context[0].content,"question1");
});

test("attachment references are scoped to a conversation and only successful turns select the follow-up file", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-files-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const db = new Journal(join(dir,"files.sqlite"));
  const file = {id:randomUUID(),name:"样本.txt",size:12,image:0,remote:"file-test",expires:Date.now()+60000};
  db.saveAttachment("phone-a",file);
  assert.equal(db.attachment("phone-b",file.id),undefined);
  const turn = db.begin("phone-a","first","read",[file.id]);
  assert.equal(db.contextFiles("phone-a")[0],undefined);
  db.complete(turn,"OK",[],[file.id]);
  const other = {...file,id:randomUUID(),name:"unknown.ext"};
  db.saveAttachment("phone-a",other);
  db.fail(db.begin("phone-a","failed","read",[other.id]),"");
  assert.equal(db.contextFiles("phone-a")[0]?.id,file.id);
  assert.equal(db.contextFiles("phone-b")[0],undefined);
  assert.equal(db.page(null,null)[0].filename,file.name);
  assert.equal(db.page(null,null)[0].filesize,12);
  assert.equal(db.lookup("phone-a","first")?.attachment,file.id);
});

test("multi-file turns preserve all ordered references across restart, retries and pagination", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-multi-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,"chat.sqlite");
  let db = new Journal(path);
  const files = ["photo.png","notes.txt"].map(name => ({id:randomUUID(),name,size:42,image:Number(name.endsWith(".png")),remote:"fixture",expires:Date.now()+60000}));
  files.forEach(file => db.saveAttachment("phone",file));
  const turn = db.begin("phone","request","compare",files.map(f=>f.id));
  db.complete(turn,"ok",[],files.map(f=>f.id));
  db = new Journal(path);
  assert.deepEqual(db.contextFiles("phone").map(f=>f.name),["photo.png","notes.txt"]);
  assert.deepEqual(db.turnFiles(Number(db.lookup("phone","request")?.id)).map(f=>f.id),files.map(f=>f.id));
  assert.deepEqual(db.page(null,null)[0].files,files.map(({name,size})=>({name,size})));
  assert.deepEqual(db.contextFiles("second phone"),[]);
});

test("legacy context imports once and can change independently of the transcript", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-context-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,"chat.sqlite");
  const sql = new DatabaseSync(path);
  sql.exec(`CREATE TABLE turns(id INTEGER PRIMARY KEY, conversation TEXT, request TEXT, created INTEGER,
    question TEXT,answer TEXT,status TEXT,context TEXT,attachment TEXT,UNIQUE(conversation,request))`);
  const message = {role:"user" as const, content:"original", timestamp:1};
  sql.prepare("INSERT INTO turns VALUES(1,'phone','one',1,'original','ok','complete',?,NULL)").run(JSON.stringify([message]));
  const journal = new Journal(path);
  assert.deepEqual(journal.contextMessages("phone"),[message]);
  sql.exec("UPDATE turns SET question='edited archive' WHERE id=1");
  assert.deepEqual(journal.contextMessages("phone"),[message]);
  sql.exec("DELETE FROM active_context");
  assert.deepEqual(new Journal(path).contextMessages("phone"),[]);
  assert.equal(journal.page(null,null)[0].question,"edited archive");

  const id = journal.begin("phone","two","new");
  sql.exec("CREATE TRIGGER simulate_failure BEFORE INSERT ON active_context BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>journal.complete(id,"answer",[message]),/fixture/);
  assert.equal(journal.lookup("phone","two")?.status,"pending");
  sql.exec("DROP TRIGGER simulate_failure");
  journal.complete(id,"answer",[message]);
  assert.throws(()=>journal.complete(id,"answer",[message]),/pending/);
  assert.deepEqual(journal.contextMessages("phone"),[message]);
  sql.close();
});
