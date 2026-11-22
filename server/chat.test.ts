import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultSettings, modelChoices } from "./model-settings.ts";
import { persona } from "./persona.ts";
import { capabilityCatalog } from "./capabilities.ts";
import { DatabaseSync } from "node:sqlite";
import { Retention, week } from "./retention.ts";
import { Journal } from "./journal.ts";

test("records accepted mobile turns and restores context after restart", async t => {
  const limit = process.env.PIGGY_TEST_ENVIRONMENT === "staging" ? 30_000 : 300_000;
  const threshold = limit * 0.8;
  const belowThreshold = limit * 0.79;
  const dir = mkdtempSync(join(tmpdir(),"piggy-test-"));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const skillBody = capabilityCatalog().skills.find(skill => skill.name === "explicit-memory")!.instructions;
  assert.match(skillBody,/^## /);
  const upstreamStarted = Promise.withResolvers<void>();
  const resumeUpstream = Promise.withResolvers<void>();
  const histories: string[][] = [];
  const fileInputs: string[][] = [];
  const fileGroups:string[][][]=[];
  const summaries:string[] = [];
  let recallTurn=0;
  const recalledInputs:unknown[]=[];
  let summaryUnavailable = false;
  let transientCounts = 0;
  let unavailableCounts = 0;
  const imageUploads:string[] = [];
  let fileNumber=0;
  const fixture = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/v1/files" || req.url?.startsWith("/v1/vector_stores")) {
      res.setHeader("content-type","application/json");
      if (req.url === "/v1/files" && body.includes('filename="camera.jpg"')) {
        assert.match(body,/Content-Type: image\/jpeg/i);
        imageUploads.push("file_fixture_"+(fileNumber+1));
      }
      if (req.url.endsWith("/search")) {res.end(JSON.stringify({data:[]}));return;}
      if (req.method==="GET") { res.writeHead(404); res.end("{}"); return; }
      res.end(JSON.stringify(req.url === "/v1/files" ? {id:"file_fixture_"+ ++fileNumber,created_at:Math.floor(Date.now()/1000)} :
        req.url === "/v1/vector_stores" ? {id:"vs_fixture"} : {status:"completed"}));
      return;
    }
    const payload = JSON.parse(body);
    if (req.url === "/v1/responses" && typeof payload.input === "string") {
      assert.equal(payload.store,false);
      assert.equal(payload.tools,undefined);
      if (payload.text?.format?.name?.startsWith("memory_")) {
        const {question} = JSON.parse(payload.input);
        res.writeHead(200,{"content-type":"application/json"});
        const allowed = question === "请记住：只喝温水" || question === "帮我记一下刚才那条";
        res.end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({decision:allowed?"save":"decline",facts:[{content:"王子怡只喝温水。",quote:"只喝温水"}]})}]}]}));
        return;
      }
      summaries.push(payload.input);
      res.writeHead(summaryUnavailable ? 503 : 200,{"content-type":"application/json"});
      res.end(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"保留蓝色偏好"}]}]}));
      return;
    }
    for (const i of payload.input) if (i.type==="function_call_output" && Array.isArray(i.output)) recalledInputs.push(...i.output);
    const changed = payload.input.some(i => JSON.stringify(i.content ?? "").includes("settings-probe"));
    assert.equal(payload.model, changed ? "gpt-6.2-astra" : "gpt-6.2-sol");
    assert.ok(payload.tools.some((tool: {type:string}) => tool.type === "web_search"));
    for (const [name,argument] of [["save_memory","text"],["search_memory","query"]]) {
      const tool = payload.tools.find((entry:{name?:string}) => entry.name === name);
      assert.deepEqual(Object.keys(tool.parameters.properties),[argument]);
      assert.deepEqual(tool.parameters.required,[argument]);
    }
    fileInputs.push(payload.input.flatMap((item: {content?:{file_id?:string}[]}) =>
      Array.isArray(item.content) ? item.content.flatMap(part => part.file_id ? [part.file_id] : []) : []));
    fileGroups.push(payload.input.filter(i=>i.role==="user").map(i=>i.content.flatMap(p=>p.file_id ? [p.file_id] : [])));
    const users = payload.input.filter((item: {role?:string}) => item.role === "user")
      .map((item: {content:{text:string}[]}) => item.content.map(part => part.text).join(""));
    assert.ok(payload.input.some((item: {role?:string;content:unknown}) =>
      item.role === "developer" && typeof item.content === "string" &&
      item.content.includes(persona) && item.content.includes(skillBody)));
    if (users.at(-1) === "turn 101") {
      const replies = payload.input.filter((item: {role?:string}) => item.role === "assistant");
      assert.equal(replies.length,100);
    }
    if (req.url === "/v1/responses/input_tokens") {
      if (users.at(-1) === "unknown") unavailableCounts++;
      if (users.at(-1) === "unknown" || (users.at(-1) === "retry count" && ++transientCounts === 1)) { res.writeHead(503); res.end(); return; }
      const tokens = users.includes("old-marker") ? (users.includes("large attachment question") ? limit + 1200 :
        users.includes("soft threshold") ? threshold + 1 : belowThreshold) : users.at(-1) === "overflow" ? limit + 1 : users.at(-1) === "exact" ? limit : users.length + 10;
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify({input_tokens:tokens}));
      return;
    }
    assert.equal(req.url, "/v1/responses");
    assert.equal(payload.reasoning.effort, changed ? "max" : "high");
    assert.equal(payload.service_tier, changed ? "ultrafast" : "default");
    assert.equal(payload.max_output_tokens, 16384);
    histories.push(users);
    if (users.at(-1) === "detached transport probe") {
      upstreamStarted.resolve();
      await resumeUpstream.promise;
    }
    if (histories.length === 2) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Test failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (["reopen archived file","请记住：只喝温水","不要记住：只喝温水","帮我记一下刚才那条"].includes(users.at(-1))
        && payload.input.at(-1).type !== "function_call_output") {
      const recall=users.at(-1)==="reopen archived file";
      const item = {type:"function_call",name:recall ? "read_chat_context" : "save_memory",id:"fc_test"+histories.length,
        call_id:"call_test"+histories.length,status:"completed",arguments:JSON.stringify(recall ? {source:"turn",id:recallTurn,includeAttachments:true} : {text:"只喝温水"})};
      for (const event of [
        {type:"response.output_item.added",output_index:0,item:{...item,arguments:""}},
        {type:"response.output_item.done",output_index:0,item},
        {type:"response.completed",response:{id:"resp_memory",status:"completed",output:[item]}},
      ]) res.write("data: " + JSON.stringify(event) + "\n\n");
      res.end("data: [DONE]\n\n");
      return;
    }
    const searching = users.at(-1) === "search the web";
    const text = searching ? "🐷今天有新闻。下段" : "OK";
    const annotations = searching ? [{type:"url_citation",url:"https://example.org/news",start_index:1,end_index:7}] : [];
    const item = {type:"message",id:"msg_"+histories.length,role:"assistant",status:"completed",
      content:[{type:"output_text",text,annotations}]};
    for (const event of [
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.output_text.delta",output_index:0,delta:text},
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
  assert.deepEqual(await (await fetch(worker.base+"/capabilities",{headers:admin})).json(),{...capabilityCatalog(),models:modelChoices,active:defaultSettings,replyPhrases:["小猪正在努力回复中","小猪正在为你寻找答案","Piggy 正在加油哦"]});
  const savePhrases = (headers, value) => fetch(worker.base+"/reply-phrases",{method:"PUT",headers,body:JSON.stringify(value)});
  assert.equal((await savePhrases(mobile,["不要写入"])).status,405);
  assert.equal((await savePhrases(admin,[])).status,400);
  assert.deepEqual(await (await savePhrases(admin,[" 测试短句 ","测试短句"])).json(),["测试短句"]);
  assert.deepEqual(await (await fetch(worker.base+"/reply-phrases",{headers:mobile})).json(),["测试短句"]);
  assert.equal((await fetch(worker.base+"/history")).status,401);
  assert.notEqual((await fetch(worker.base+"/history",{headers:mobile})).status,200);
  assert.equal((await fetch(worker.base+"/chat",{method:"POST",headers:admin})).status,405);
  const request = randomUUID();
  const setModel = (headers, value) => fetch(worker.base+"/model-settings",{method:"PUT",headers,body:JSON.stringify(value)});
  assert.notEqual((await setModel(mobile,defaultSettings)).status,200);
  assert.equal((await setModel(admin,{...defaultSettings,tier:"unsupported"})).status,400);
  const first = await send("one",request);
  assert.deepEqual(first[0].context,{used:11,limit});
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
  assert.deepEqual(Object.keys(list.turns[0]).sort(),["answer","created","filename","files","filesize","id","question","replyFiles","status"]);
  assert.equal((await (await fetch(worker.base+"/history?after=2",{headers:admin})).json()).turns.length,2);
  const preview = await fetch(worker.base+"/context",{method:"POST",headers:mobile,body:JSON.stringify({session})});
  assert.deepEqual(await preview.json(),{used:12,limit});
  const calls = histories.length;
  const over = await send("overflow");
  assert.deepEqual(over[0].context,{used:limit + 1,limit});
  assert.ok(over.at(-1).error.includes((limit + 1).toLocaleString("en-US")));
  assert.ok(over.at(-1).error.includes("超过 " + limit.toLocaleString("en-US") + " 上限"));
  assert.match((await send("unknown")).at(-1).error,/核对上下文/);
  assert.equal(unavailableCounts,2);
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

  const otherId=randomUUID();
  db.saveAttachment(fileSession,{id:otherId,name:"B.pdf",size:7,image:0,remote:"file-B",expires:Date.now()+60000});
  await (await fetch(worker.base+"/chat",{method:"POST",headers:mobile,body:JSON.stringify({text:"read",session:fileSession,attachments:[otherId]})})).text();
  assert.equal((await send("new topic",randomUUID(),fileSession)).at(-1).done,true);
  assert.deepEqual(fileGroups.slice(-2),Array(2).fill([["file-notes"],["file-B"],[]]));

  const imageSession=randomUUID(), fresh=randomUUID(), legacy=randomUUID(), imageName="camera.PNG";
  const jpeg=Buffer.from("ffd8ffe000104a4649460001","hex");
  const uploadHeaders={...mobile,"content-type":"image/png","x-piggy-session":imageSession,
    "x-piggy-attachment":fresh,"x-piggy-filename":Buffer.from(imageName).toString("base64url")};
  assert.equal((await fetch(worker.base+"/attachments",{method:"POST",headers:uploadHeaders,body:jpeg})).status,200);
  assert.equal(imageUploads.length,1);
  const archive=new Retention(join(dir,"test.sqlite")), source=join(dir,"legacy-image");
  writeFileSync(source,jpeg);
  const copy=await archive.keep(source), expires=Date.now()+week;
  db.saveAttachment(imageSession,{id:legacy,name:imageName,size:jpeg.length,image:1,remote:"old-PNG",expires},{...copy,mime:"image/png"});
  async function sendImages() {
    const res=await fetch(worker.base+"/chat",{method:"POST",headers:mobile,
      body:JSON.stringify({text:"read images",session:imageSession,attachments:[fresh,legacy]})});
    assert.match(await res.text(),/"done":true/);
  }
  await sendImages();
  assert.equal(imageUploads.length,2);
  assert.deepEqual(fileInputs.slice(-2),[imageUploads,imageUploads]);
  const repaired=db.attachment(imageSession,legacy)!;
  assert.deepEqual([repaired.remote,repaired.expires,repaired.name],[imageUploads[1],expires,imageName]);
  assert.equal(db.retained(copy.key)?.mime,"image/jpeg");
  await sendImages();
  assert.equal(imageUploads.length,2);
  assert.equal((await fetch(worker.base+"/attachments",{method:"POST",headers:{...uploadHeaders,"x-piggy-attachment":randomUUID()},body:"broken"})).status,415);

  const longSession = randomUUID();
  const questions = Array.from({length:100}, (_,i) => "turn "+(i+1));
  for (const question of questions) assert.equal((await send(question,randomUUID(),longSession)).at(-1).done,true);
  const counted = await fetch(worker.base+"/context",{method:"POST",headers:mobile,body:JSON.stringify({session:longSession})});
  assert.deepEqual(await counted.json(),{used:110,limit});
  assert.equal((await send("turn 101",randomUUID(),longSession)).at(-1).done,true);
  assert.deepEqual(histories.at(-1),[...questions,"turn 101"]);

  const searchId = randomUUID(), phone = randomUUID();
  const cited = "🐷今天有新闻。 [来源 · example.org](https://example.org/news)下段";
  assert.equal((await send("search the web",searchId,phone)).at(-1).answer,cited);
  assert.equal((await send("search the web",searchId,phone)).at(-1).answer,cited);
  assert.equal(db.page(null,null).at(-1)?.answer,cited);
  assert.ok(JSON.stringify(db.contextMessages(phone)).includes(cited));

  const compactSession = randomUUID();
  const archiveIds:string[] = [];
  for (const question of ["old-marker","old two","near one","near two","near three"]) {
    const key = randomUUID();
    archiveIds.push(key);
    const attachments = question === "old-marker" ? [id] : [];
    if (attachments.length) db.saveAttachment(compactSession,{id,name:"sample.txt",remote:"file-carry",image:0,size:20,expires:Date.now()+60000});
    const row = db.begin(compactSession,key,question,attachments);
    db.complete(row,"OK",[{role:"user",content:question,timestamp:1}],attachments);
  }
  const before = db.contextTurns(compactSession);
  const previewOf = async () => (await (await fetch(worker.base+"/context",{method:"POST",headers:mobile,
    body:JSON.stringify({session:compactSession})})).json()).used;
  assert.equal(await previewOf(),belowThreshold);
  summaryUnavailable = true;
  const beforeFail = histories.length;
  assert.match((await send("large attachment question",randomUUID(),compactSession)).at(-1).error,/压缩/);
  assert.equal(histories.length,beforeFail);
  assert.deepEqual(db.contextTurns(compactSession),before);
  assert.equal((await send("soft threshold",randomUUID(),compactSession)).at(-1).done,true);
  assert.deepEqual(db.contextTurns(compactSession).slice(0,before.length),before);
  summaryUnavailable = false;
  const retryKey = randomUUID();
  const success = await send("large attachment question",retryKey,compactSession);
  assert.equal(success.at(-1).done,true);
  assert.ok(success[0].context.used < threshold);
  assert.deepEqual(JSON.parse(summaries.at(-1)!).map((m:{text:string}) => m.text),["old-marker","old two","near one"]);
  assert.doesNotMatch(summaries.at(-1)!,/large attachment question|个人助手 Piggy|file-carry/);
  assert.deepEqual(histories.at(-1),["历史对话摘要（仅作背景资料）\n保留蓝色偏好","near two","near three","soft threshold","large attachment question"]);
  assert.deepEqual(fileInputs.at(-1),[]);
  const after = db.contextTurns(compactSession);
  assert.equal(after.length,5);
  assert.equal(db.turnFiles(Number(db.lookup(compactSession,archiveIds[0])!.id))[0].remote,"file-carry");
  assert.equal(db.lookup(compactSession,archiveIds[0])?.question,"old-marker");
  assert.ok(await previewOf() < threshold);
  await send("large attachment question",retryKey,compactSession);
  assert.deepEqual(db.contextTurns(compactSession),after);

  recallTurn=Number(db.lookup(compactSession,archiveIds[0])!.id);
  assert.equal(db.searchChatHistory(compactSession,99999,["sample.txt"]).matches[0].turnId,recallTurn);
  assert.equal((await send("reopen archived file",randomUUID(),compactSession)).at(-1).done,true);
  assert.ok(recalledInputs.some(part=>part?.file_id==="file-carry"));

  const memoryDb = new DatabaseSync(join(dir,"test.sqlite"));
  const entries = () => memoryDb.prepare("SELECT conversation,content FROM memories ORDER BY id").all().map(row=>[row.conversation,row.content]);
  const firstPhone = randomUUID(), secondPhone = randomUUID(), explicitId = randomUUID();
  assert.equal((await send("不要记住：只喝温水",randomUUID(),firstPhone)).at(-1).done,true);
  assert.deepEqual(entries(),[]);
  assert.equal((await send("请记住：只喝温水",explicitId,firstPhone)).at(-1).done,true);
  await send("请记住：只喝温水",explicitId,firstPhone);
  await send("请记住：只喝温水",randomUUID(),firstPhone);
  assert.deepEqual(entries(),[[firstPhone,"王子怡只喝温水。"]]);
  await send("我只喝温水",randomUUID(),secondPhone);
  assert.equal((await send("帮我记一下刚才那条",randomUUID(),secondPhone)).at(-1).done,true);
  assert.deepEqual(entries(),[[firstPhone,"王子怡只喝温水。"],[secondPhone,"王子怡只喝温水。"]]);
  memoryDb.close();

  assert.equal((await send("retry count",randomUUID(),randomUUID())).at(-1).done,true);
  assert.ok(transientCounts >= 2);

  const detachedSession = randomUUID(), detachedId = randomUUID();
  const detachedText = "detached transport probe";
  const options = {method:"POST",headers:mobile,body:JSON.stringify({session:detachedSession,request:detachedId,text:detachedText})};
  const abort = new AbortController();
  const original = await fetch(worker.base+"/chat",{...options,signal:abort.signal});
  assert.equal(original.status,200);
  await upstreamStarted.promise;
  abort.abort();
  try {
    const pending = await fetch(worker.base+"/chat",options);
    assert.equal(pending.status,409);
    assert.ok(pending.headers.get("retry-after"));
    await pending.text();
  } finally { resumeUpstream.resolve(); }
  for (let i=0;i<100 && db.lookup(detachedSession,detachedId)?.status==="pending";i++)
    await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(db.lookup(detachedSession,detachedId)?.status,"complete");
  const replay = (await send(detachedText,detachedId,detachedSession)).at(-1);
  assert.equal(replay.done,true);
  assert.equal(replay.answer,db.lookup(detachedSession,detachedId)?.answer);
  assert.equal(histories.filter(history=>history.at(-1)===detachedText).length,1);

  const updated = {model:"gpt-6.2-astra",effort:"max",tier:"ultrafast"};
  assert.deepEqual(await (await setModel(admin,updated)).json(),updated);
  const exit=once(worker.child,"exit");worker.child.kill();await exit;
  worker=await start();
  assert.deepEqual((await (await fetch(worker.base+"/capabilities",{headers:admin})).json()).active,updated);
  assert.equal((await send("settings-probe",randomUUID(),randomUUID())).at(-1).done,true);

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
  assert.equal(db.contextMessages("phone-a")[0]?.fileRefs?.[0],undefined);
  db.complete(turn,"OK",[{role:"user",content:"read",timestamp:1}],[file.id]);
  const other = {...file,id:randomUUID(),name:"unknown.ext"};
  db.saveAttachment("phone-a",other);
  db.fail(db.begin("phone-a","failed","read",[other.id]),"");
  assert.equal(db.contextMessages("phone-a")[0]?.fileRefs?.[0]?.id,file.id);
  assert.equal(db.contextMessages("phone-b")[0],undefined);
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
  db.complete(turn,"ok",[{role:"user",content:"compare",timestamp:1}],files.map(f=>f.id));
  db = new Journal(path);
  assert.deepEqual(db.contextMessages("phone")[0].fileRefs.map(f=>f.name),["photo.png","notes.txt"]);
  assert.deepEqual(db.turnFiles(Number(db.lookup("phone","request")?.id)).map(f=>f.id),files.map(f=>f.id));
  assert.deepEqual(db.page(null,null)[0].files,files.map(({name,size})=>({name,size})));
  assert.deepEqual(db.contextMessages("second phone"),[]);
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

test("compaction commits the checkpoint, file references and new turn atomically", t => {
  const dir = mkdtempSync(join(tmpdir(),"piggy-checkpoint-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,"test.sqlite");
  const journal = new Journal(path);
  const message = {role:"user" as const,content:"original",timestamp:1};
  const reply = {key:randomUUID(),name:"a.txt",remote:"file-reply",mime:"text/plain",until:Date.now()+60000,size:24};
  const first = journal.begin("phone","1","one");
  journal.complete(first,"one",[message],[],[reply]);
  journal.complete(journal.begin("phone","2","two"),"two",[message]);
  const before = journal.contextTurns("phone");
  const id = journal.begin("phone","3","three");
  const seq = before.at(-1)!.sequence;
  const replacement = {through:seq,last:seq,summary:{...message,content:"summary"}};
  const sql = new DatabaseSync(path);
  sql.exec("CREATE TRIGGER stop_insert BEFORE INSERT ON active_context BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>journal.complete(id,"three",[message],[],[],replacement),/fixture/);
  assert.deepEqual(journal.contextTurns("phone"),before);
  assert.equal(journal.lookup("phone","3")?.status,"pending");
  sql.exec("DROP TRIGGER stop_insert");
  journal.complete(id,"three",[message],[],[],replacement);
  assert.deepEqual(journal.previousOutputs("phone"),[reply]);
  assert.deepEqual(new Journal(path).contextMessages("phone"),[replacement.summary,message]);
  assert.equal(journal.replyFiles(first)[0].name,"a.txt");
  sql.close();
});
