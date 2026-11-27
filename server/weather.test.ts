import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { Installation } from "./installation.ts";
import { Schedules } from "./schedules.ts";
import { weatherReminder, specialWeather } from "./weather.ts";

test("07:00 Shanghai uses one recent authorized fix, once per day, including after restart",()=>{
  const now=Date.parse("2026-11-26T23:00:00Z"),session=randomUUID();
  const db=new DatabaseSync(":memory:"), installation=new Installation(db), store=new Schedules(db,installation);
  db.prepare("INSERT INTO mobile_installation VALUES(1,'test',?)").run(session);
  const fix={lat:30.267,lon:120.153,observed:now-3600000,zone:"Asia/Shanghai"};
  store.enqueue(now);
  assert.equal(store.snapshot().runs.length,0);
  store.weather.sync(session,{revision:1,place:fix},now);
  assert.deepEqual({...store.weather.latest(session,now)}, {...fix,lat:30.3,lon:120.2});
  store.enqueue(now-1);
  assert.equal(store.snapshot().runs.length,0);
  store.enqueue(now);
  new Schedules(db,installation).enqueue(now+120000);
  assert.equal(store.snapshot().runs.length,1);
  assert.equal(store.snapshot().runs[0].due,now);
  store.enqueue(now+86400000);
  assert.equal(store.snapshot().runs.length,1);
  store.weather.sync(session,{revision:2,place:null},now);
  store.weather.sync(session,{revision:1,place:fix},now);
  assert.equal(store.weather.latest(session,now),undefined);
  store.weather.sync(session,{revision:3,place:fix},now);
  store.weather.expire(now+86400000);
  assert.equal(db.prepare("SELECT lat FROM weather_location").get()?.lat,null);
  db.close();
});

test("normal days stay silent; threshold and day boundary use forecast hours for the local day",()=>{
  const now=Date.parse("2026-11-26T23:00:00Z"), zone="Asia/Shanghai";
  const base={time:new Date(now).toISOString(),temp:18,wind:2,rain:0,sky:"cloudy"};
  assert.equal(weatherReminder([base,{...base,time:"2026-11-27T16:00:00Z",temp:38}],zone,now),null);
  for (const [change,kind] of [[{sky:"heavyrainandthunder"},"雷暴"],[{sky:"sleet"},"降雪"],
    [{rain:2.5},"明显降雨"],[{wind:10.8},"大风"],[{temp:35},"高温"],[{temp:-10},"严寒"]] as const) {
    assert.ok(weatherReminder([{...base,...change}],zone,now)?.includes(kind));
  }
  assert.deepEqual(specialWeather(Array(5).fill({...base,rain:1})),["明显降雨"]);
  assert.throws(()=>weatherReminder([],zone,now));
});
