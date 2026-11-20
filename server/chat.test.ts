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
import { Journal } from "./journal.ts";

test("records accepted mobile turns and restores context after restart", async t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-test-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const histories: string[][] = [];
  const fixture = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert.equal(payload.model, "gpt-6.2-sol");
    assert.equal(payload.reasoning_effort, "high");
    assert.equal(payload.max_completion_tokens, 16384);
    const messages: { role: string; content: string | { text: string }[] }[] = payload.messages;
    histories.push(messages
      .filter(message => message.role === "user")
      .map(({ content }) => typeof content === "string" ? content : content.map(part => part.text).join("")));
    if (histories.length === 2) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Test failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "OK" }, null], [{}, "stop"]]) {
      const chunk = { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] };
      res.write("data: " + JSON.stringify(chunk) + "\n\n");
    }
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
  assert.equal((await fetch(worker.base+"/history")).status,401);
  assert.notEqual((await fetch(worker.base+"/history",{headers:mobile})).status,200);
  assert.equal((await fetch(worker.base+"/chat",{method:"POST",headers:admin})).status,405);
  const request = randomUUID();
  const first = await send("one",request);
  assert.equal(first[0].delta,"OK");
  assert.equal(first.at(-1).session,session);
  assert.deepEqual(await send("one",request),first);
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
  const context=reopened.previous("phone");
  assert.equal(context.length,12);
  assert.equal(context[0].content,"question34");
});

test("attachment references are scoped to a conversation and only successful turns select the follow-up file", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-files-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const db = new Journal(join(dir,"files.sqlite"));
  const file = {id:randomUUID(),name:"样本.txt",size:12,image:0,remote:"file-test",expires:Date.now()+60000};
  db.saveAttachment("phone-a",file);
  assert.equal(db.attachment("phone-b",file.id),undefined);
  const turn = db.begin("phone-a","first","read",[file.id]);
  assert.equal(db.latestFiles("phone-a")[0],undefined);
  db.complete(turn,"OK",[]);
  const other = {...file,id:randomUUID(),name:"unknown.ext"};
  db.saveAttachment("phone-a",other);
  db.fail(db.begin("phone-a","failed","read",[other.id]),"");
  assert.equal(db.latestFiles("phone-a")[0]?.id,file.id);
  assert.equal(db.latestFiles("phone-b")[0],undefined);
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
  db.complete(turn,"ok",[]);
  db = new Journal(path);
  assert.deepEqual(db.latestFiles("phone").map(f=>f.name),["photo.png","notes.txt"]);
  assert.deepEqual(db.turnFiles(Number(db.lookup("phone","request")?.id)).map(f=>f.id),files.map(f=>f.id));
  assert.deepEqual(db.page(null,null)[0].files,files.map(({name,size})=>({name,size})));
  assert.deepEqual(db.latestFiles("second phone"),[]);
});
