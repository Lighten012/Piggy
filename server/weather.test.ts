import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { locationTool, WeatherLocations, todayAlerts, specialWeather } from "./weather.ts";

test("the location tool reads only a recent authorized fix and keeps coordinates private",async()=>{
  const now=Date.now(),session=randomUUID(),db=new DatabaseSync(":memory:");
  const store=new WeatherLocations(db);
  const read=async()=>JSON.parse((await locationTool(store,session).execute("test",{})).content[0].text);
  assert.deepEqual(await read(),{available:false});
  const fix={lat:30.267,lon:120.153,observed:now-3600000,zone:"Asia/Shanghai"};
  store.sync(session,{revision:1,place:fix},now);
  assert.deepEqual(await read(),{available:true,observedAt:new Date(fix.observed).toISOString(),timezone:fix.zone});
  assert.deepEqual({...store.latest(session,now)},{...fix,lat:30.3,lon:120.2});
  store.sync(session,{revision:2,place:null},now);
  store.sync(session,{revision:1,place:fix},now);
  assert.deepEqual(await read(),{available:false});
  store.sync(session,{revision:3,place:fix},now);
  store.expire(now+86400000);
  assert.deepEqual(await read(),{available:false});
  db.close();
});

test("normal days stay silent; threshold and day boundary use forecast hours for the local day",()=>{
  const now=Date.parse("2026-11-26T23:00:00Z"), zone="Asia/Shanghai";
  const base={time:new Date(now).toISOString(),temp:18,wind:2,rain:0,sky:"cloudy"};
  assert.deepEqual(todayAlerts([base,{...base,time:"2026-11-27T16:00:00Z",temp:38}],zone,now),[]);
  for (const [change,kind] of [[{sky:"heavyrainandthunder"},"雷暴"],[{sky:"sleet"},"降雪或雨夹雪"],
    [{rain:2.5},"明显降雨"],[{wind:10.8},"大风"],[{temp:35},"高温"],[{temp:-10},"严寒"]] as const) {
    assert.ok(todayAlerts([{...base,...change}],zone,now).includes(kind));
  }
  assert.deepEqual(specialWeather(Array(5).fill({...base,rain:1})),["明显降雨"]);
  assert.throws(()=>todayAlerts([],zone,now));
});
