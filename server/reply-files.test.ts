import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "./journal.ts";
import { ReplyFiles, replyText } from "./reply-files.ts";
import { Retention, week } from "./retention.ts";

test("generated files are deduplicated, scoped to a reply and removed after seven days", async t => {
  const dir = await mkdtemp(join(tmpdir(),"piggy-reply-"));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const dbPath = join(dir,"chat.sqlite");
  const journal = new Journal(dbPath), archive = new Retention(dbPath);
  const doc = Buffer.from("fixture workbook");
  const jpg = Buffer.from([255,216,255,217]);
  let uploads = 0;
  const fixture = createServer(async (req,res) => {
    if (req.url === "/containers/cn_1/files/f_1/content") return void res.end(doc);
    assert.equal(req.url,"/files");
    let body = "";
    for await (const part of req) body += part.toString("latin1");
    assert.ok(body.includes("604800"));
    res.end(JSON.stringify({id:"file-"+(++uploads)}));
  });
  fixture.listen(0,"127.0.0.1");
  await once(fixture,"listening");
  t.after(() => fixture.close());
  const result = new ReplyFiles(archive,"http://127.0.0.1:"+(fixture.address() as AddressInfo).port,"fixture");
  const output = [
    {type:"message",content:[{annotations:[{type:"container_file_citation",container_id:"cn_1",file_id:"f_1",filename:"/mnt/data/预算.xlsx"}]}]},
    {type:"image_generation_call",id:"ig_1",result:jpg.toString("base64")},
  ];
  for (const item of output) await result.observe({type:"response.output_item.done",item});
  await result.observe({type:"response.completed",response:{output}});
  assert.equal(uploads,2);
  const id = journal.begin("phone","req","画图并制作表格");
  journal.complete(id,replyText("",result.files),[],[],result.files);
  const files = journal.replyFiles(id);
  assert.equal(files.length,2);
  assert.equal(files[0].name,"预算.xlsx");
  assert.equal(files[1].preview,"image/jpeg");
  assert.equal(journal.previousOutputs("phone")[0].remote,"file-1");
  assert.equal(journal.retained(String(files[0].key),"another-phone"),undefined);
  assert.ok(journal.retained(String(files[0].key),"phone"));
  assert.ok(journal.retained(String(files[0].key)));
  assert.equal(replyText("[预算](sandbox:/mnt/data/budget.xlsx)",result.files),"预算");
  for (const [i,f] of result.files.entries()) {
    assert.ok(f.until > Date.now()+week-30000 && f.until <= Date.now()+week);
    assert.deepEqual(await readFile(join(dir,"attachments",f.key)),i ? jpg : doc);
  }
  await archive.sweep(journal,Date.now()+week+1);
  assert.deepEqual(await readdir(join(dir,"attachments")),[]);
  assert.deepEqual(journal.replyFiles(id),files);
});
