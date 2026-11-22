import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Journal } from "./journal.ts";
import { ReplyFiles } from "./reply-files.ts";
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
    if (req.url?.startsWith("/containers/cn_1/files/") && req.url.endsWith("/content")) return void res.end(doc);
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
  const href = "sandbox:/mnt/data/deliverables/%E9%A2%84%E7%AE%97.xlsx";
  const link = "🐷[预算]("+href+")";
  const begin = Array.from("🐷[预算](").length;
  const output = [
    {type:"message",content:[{text:link,annotations:[{type:"container_file_citation",container_id:"cn_1",file_id:"f_1",filename:"预算.xlsx",start_index:begin,end_index:begin+href.length}]}]},
    {type:"image_generation_call",id:"ig_1",result:jpg.toString("base64")},
  ];
  for (const item of output) await result.observe({type:"response.output_item.done",item});
  await result.observe({type:"response.completed",response:{output}});
  await result.observe({type:"response.output_item.done",item:{type:"message",content:[{text:"sandbox:/mnt/data/预算.xlsx",annotations:[
    {type:"container_file_citation",container_id:"cn_1",file_id:"input-copy",filename:"预算.xlsx",start_index:0,end_index:24},
    {type:"container_file_citation",container_id:"cn_1",file_id:"thumbnail",filename:"preview.png"}
  ]}]}});
  await result.deliver("根据之前图片作答，无需文件。");
  assert.equal(uploads,1); // Only the dedicated image-generation result has been archived.
  const answer=await result.deliver(link);
  assert.equal(answer,"🐷预算");
  assert.equal(result.files[1].inlineAt,answer.length);
  await result.deliver(link);
  assert.equal(uploads,2);
  const id = journal.begin("phone","req","画图并制作表格");
  journal.complete(id,answer,[],[],result.files);
  const files = journal.replyFiles(id);
  assert.equal(files.length,2);
  assert.equal(files[1].name,"预算.xlsx");
  assert.equal(files[0].preview,"image/jpeg");
  assert.equal(journal.previousOutputs("phone")[0].remote,"file-1");
  assert.equal(journal.retained(String(files[0].key),"another-phone"),undefined);
  assert.ok(journal.retained(String(files[0].key),"phone"));
  assert.ok(journal.retained(String(files[0].key)));
  assert.equal(files[1].inlineAt,answer.length);
  for (const [i,f] of result.files.entries()) {
    assert.ok(f.until > Date.now()+week-30000 && f.until <= Date.now()+week);
    assert.deepEqual(await readFile(join(dir,"attachments",f.key)),i ? doc : jpg);
  }
  const pair=new ReplyFiles(archive,"http://127.0.0.1:"+(fixture.address() as AddressInfo).port,"fixture");
  const captions=["🐷第一张裁切图","第二张裁切图","说明文件"];
  const refs=["crop_(1).png","crop_2.png","guide.txt"].map(name=>"sandbox:/mnt/data/deliverables/"+name);
  const markdown=captions.map((caption,i)=>"!["+caption+"](<"+refs[i]+">)").join("\n\n")+"\n\n完成";
  const annotations=refs.map((url,i)=>{
    const start=Array.from(markdown.slice(0,markdown.indexOf(url))).length;
    return {type:"container_file_citation",filename:"output"+i,file_id:"f_"+i,container_id:"cn_1",start_index:start,end_index:start+url.length};
  });
  await pair.observe({type:"response.output_item.done",item:{type:"message",content:[{text:markdown,annotations}]}});
  const final=await pair.deliver(markdown);
  assert.equal(final,[...captions,"完成"].join("\n\n"));
  const second=journal.begin("phone","two","裁切");
  journal.complete(second,final,[],[],pair.files);
  assert.deepEqual(new Journal(dbPath).replyFiles(second).map(f=>f.inlineAt),captions.map(c=>final.indexOf(c)+c.length));
  await pair.discard();
  await archive.sweep(journal,Date.now()+week+1);
  assert.deepEqual(await readdir(join(dir,"attachments")),[]);
  assert.deepEqual(journal.replyFiles(id),files);
});
