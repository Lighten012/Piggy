import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Journal } from "./journal.ts";
import { Retention, week } from "./retention.ts";
import { receiveAttachment } from "./attachments.ts";

test("successful uploads are private until linked, survive restart and expire without losing the journal", async t => {
  const dir = await mkdtemp(join(tmpdir(),"piggy-retention-"));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  async function listen(server:Server) {
    server.listen(0,"127.0.0.1"); await once(server,"listening");
    t.after(()=>server.close());
    return "http://127.0.0.1:"+(server.address() as AddressInfo).port;
  }
  let upstreamCalls = 0;
  const base = await listen(createServer(async (req,res)=>{
    for await (const _ of req) { /* consume multipart */ }
    upstreamCalls++;
    res.end(JSON.stringify({id:"file-test",created_at:Math.floor(Date.now()/1000)}));
  }));
  const db = join(dir,"journal.sqlite"), archive = new Retention(db);
  let journal = new Journal(db);
  const origin = await listen(createServer((req,res)=>{
    if (req.method==="POST") void receiveAttachment(req,res,journal,archive,base,"test");
    else {
      const url=new URL(req.url!,"http://localhost");
      void archive.serve(journal,url.pathname.slice(1),url.searchParams.has("download"),req.method==="HEAD",res);
    }
  }));
  const session=randomUUID(),id=randomUUID(),name="源码.html",body="<script>alert(1)</script>";
  const headers={"x-piggy-session":session,"x-piggy-attachment":id,"x-piggy-filename":Buffer.from(name).toString("base64url"),"content-type":"text/html"};
  for (let i=0;i<2;i++) {
    const response=await fetch(origin,{method:"POST",headers,body});
    assert.deepEqual(await response.json(),{id,size:body.length});
  }
  assert.equal(upstreamCalls,1);
  const [key]=await readdir(join(dir,"attachments"));
  assert.ok(Math.abs(Number(key.split("-")[0])-Date.now()-week)<5000);
  assert.equal((await fetch(origin+"/"+key)).status,404);
  journal.complete(journal.begin(session,"request","read",[id]),"ok",[]);
  journal=new Journal(db);
  const ref=journal.page(null,null)[0].files[0];
  assert.equal(ref.key,key); assert.equal(ref.preview,"text/plain; charset=utf-8");
  const view=await fetch(origin+"/"+key);
  assert.equal(view.headers.get("content-type"),ref.preview);
  assert.equal(view.headers.get("x-content-type-options"),"nosniff");
  assert.match(view.headers.get("content-disposition")!,/^inline/);
  assert.equal(await view.text(),body);
  const download=await fetch(origin+"/"+key+"?download");
  assert.ok(download.headers.get("content-disposition")!.includes(encodeURIComponent(name)));
  assert.match(download.headers.get("content-disposition")!,/^attachment/);
  assert.equal(await download.text(),body);
  const path=join(dir,"fixture"); await writeFile(path,body);
  const expired=await archive.keep(path,Date.now()-1);
  const other=randomUUID();
  journal.saveAttachment(session,{id:other,name,size:body.length,image:0,remote:"old",expires:Date.now()+week},{...expired,mime:"text/html"});
  journal.complete(journal.begin(session,"old","read",[other]),"ok",[]);
  assert.equal((await fetch(origin+"/"+expired.key)).status,404);
  assert.deepEqual(journal.page(null,null)[1].files,[{name,size:body.length}]);
  await archive.sweep(journal);
  assert.deepEqual(await readdir(join(dir,"attachments")),[key]);
  await archive.sweep(journal,Date.now()+week+1000);
  assert.deepEqual(await readdir(join(dir,"attachments")),[]);
  assert.deepEqual(journal.page(null,null)[0].files,[{name,size:body.length}]);
});
