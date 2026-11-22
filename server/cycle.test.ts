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
