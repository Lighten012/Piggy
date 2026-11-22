import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {CycleStore,cycleTools} from "./cycle.ts";

test("calendar sync merges distinct periods, retries a lost acknowledgement and isolates installations",()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")), today="2026-11-22";
  const old={seq:1,kind:"period",start:"2026-10-01",end:"2026-10-05"};
  store.sync("a",[old],today);
  store.record("a",old.start,"2026-10-06",today);
  assert.equal(store.sync("a",[old],today).periods[0].end,"2026-10-06");
  store.record("a","2026-11-02",undefined,today);
  assert.equal(store.sync("a",[{seq:2,kind:"settings",length:31,duration:4}],today).periods.length,2);
  assert.deepEqual(store.read("b").periods,[]);
  const invalid=store.sync("a",[{seq:3,kind:"period",start:"2026-10-03"}],today);
  assert.equal(invalid.errors.length,1);
  assert.equal(invalid.through,3);
  assert.throws(()=>store.record("a","2026-02-30",undefined,today));
  assert.throws(()=>store.record("a","2026-12-01",undefined,today));
  assert.throws(()=>store.sync("a",[{seq:5,kind:"remove",start:old.start}],today));
  assert.equal(store.sync("a",[{seq:4,kind:"end",start:old.start,end:null}],today).periods[0].end,null);
});
test("tool uses the caller's calendar, requires a quote and keeps the end on duplicate starts",async()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")),today="2026-11-22";
  const [read,write]=cycleTools(store,"a","我在11月1日开始，5日结束",today);
  await assert.rejects(write.execute("call",{start:"2026-11-01",quote:"替他登记"}));
  await write.execute("call",{start:"2026-11-01",end:"2026-11-05",quote:"11月1日开始，5日结束"});
  await write.execute("call",{start:"2026-11-01",quote:"11月1日开始"});
  assert.match(JSON.stringify(await read.execute("read",{})),/2026-11-05/);
  assert.throws(()=>store.record("a","2026-11-01","2026-10-31",today));
});
test("an ongoing period accepts omitted, null and blank ends and returns the phone estimate",async()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")),today="2026-11-22";
  const start="2026-11-21",quote="昨天来的";
  store.sync("a",[{seq:1,kind:"settings",length:28,duration:7}],today);
  const [,write]=cycleTools(store,"a",quote,today);
  for(const args of [{},{end:null},{end:""},{end:"  "}]) {
    const reply=await write.execute("record",{start,quote,...args});
    assert.deepEqual(JSON.parse(reply.content[0].text),{start,end:null,estimatedEnd:"2026-11-27"});
    assert.deepEqual(store.read("a").periods,[{start,end:null}]);
  }
  await assert.rejects(write.execute("record",{start,quote,end:"2026-11-27"}));
  await write.execute("record",{start,quote,end:today});
  await write.execute("record",{start,quote,end:""});
  assert.deepEqual(store.read("a").periods,[{start,end:today}]);
  assert.equal(store.record("a","2026-11-18",undefined,today).estimatedEnd,"2026-11-20");
});
test("chat cancellation checks the reviewed record and scope before changing the mobile calendar",async()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")),today="2026-11-22";
  const start="2026-11-11",quote="帮我取消11月11日开始的那次记录";
  for(const session of ["a","b"]) store.record(session,start,"2026-11-15",today);
  store.record("a","2026-10-11","2026-10-15",today);
  const [read,,cancel]=cycleTools(store,"a",quote,today);
  const args={start,target:"period",quote};
  await assert.rejects(cancel.execute("cancel",args),/先读取/);
  await read.execute("read",{});
  await assert.rejects(cancel.execute("cancel",{...args,quote:"删除其他记录"}),/原话/);
  store.record("a",start,"2026-11-16",today);
  await assert.rejects(cancel.execute("cancel",args),/已更改/);
  await read.execute("read",{});
  await cancel.execute("cancel",{...args,target:"end"});
  assert.deepEqual(store.read("a").periods[1],{start,end:null});
  await read.execute("read",{});
  await cancel.execute("cancel",args);
  assert.deepEqual(store.sync("a",[],today).periods,[{start:"2026-10-11",end:"2026-10-15"}]);
  assert.deepEqual(store.read("b").periods,[{start,end:"2026-11-15"}]);
  assert.match(JSON.stringify(await cancel.execute("cancel",args)),/not_found/);
});

test("chat corrects dates atomically and preserves the mobile sync cursor",async()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")),today="2026-11-22",quote="把开始日改到12日";
  const original={start:"2026-11-11",end:"2026-11-15"};
  store.sync("a",[{seq:1,kind:"period",...original},{seq:2,kind:"period",start:"2026-11-19"}],today);
  const [read,,,update]=cycleTools(store,"a",quote,today);
  const args={start:original.start,quote};
  await assert.rejects(update.execute("call",{...args,newStart:"2026-11-12"}),/先读取/);
  await read.execute("call",{});
  const before=store.read("a");
  for(const patch of [{newStart:"2026-11-19"}, {newStart:"2026-11-16"}, {newEnd:"2026-11-20"},{}]) {
    await assert.rejects(update.execute("call",{...args,...patch}));
    assert.deepEqual(store.read("a"),before);
  }
  await update.execute("call",{...args,newStart:"2026-11-12"});
  assert.deepEqual(store.sync("a",[],today),{...before,errors:[],periods:[{start:"2026-11-12",end:original.end},before.periods[1]]});
  await read.execute("call",{});
  store.record("a","2026-11-12","2026-11-16",today);
  await assert.rejects(update.execute("call",{...args,start:"2026-11-12",newEnd:"2026-11-17"}),/变化/);
  await read.execute("call",{});
  await update.execute("call",{...args,start:"2026-11-12",newStart:"2026-11-13",newEnd:"2026-11-17"});
  assert.deepEqual(store.read("a").periods[0],{start:"2026-11-13",end:"2026-11-17"});
});

test("chat updates only requested settings and rejects stale or invalid edits",async()=>{
  const store=new CycleStore(new DatabaseSync(":memory:")),today="2026-11-22",quote="改一下我的周期设置";
  const [read,,,,settings]=cycleTools(store,"a",quote,today);
  await read.execute("read",{});
  await assert.rejects(settings.execute("call",{expectedPeriodDays:28,quote}));
  await assert.rejects(settings.execute("call",{cycleDays:35,quote:"其他人的要求"}));
  store.sync("a",[{seq:1,kind:"settings",length:30,duration:6}],today);
  await assert.rejects(settings.execute("call",{cycleDays:35,quote}),/变化/);
  await read.execute("read",{});
  await settings.execute("call",{cycleDays:35,quote});
  await settings.execute("call",{expectedPeriodDays:7,quote});
  assert.deepEqual(store.sync("a",[],today),{length:35,duration:7,periods:[],through:1,errors:[]});
  assert.equal(store.read("b").length,28);
});
