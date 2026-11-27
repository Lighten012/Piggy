import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { locationTool, WeatherLocations, forecast, cityWeatherTool } from "./weather.ts";

test("the location tool reads only a recent authorized fix and keeps coordinates private",async()=>{
  const now=Date.now(),session=randomUUID(),db=new DatabaseSync(":memory:");
  const store=new WeatherLocations(db);
  const read=async()=>JSON.parse((await locationTool(store,session).execute("test",{})).content[0].text);
  assert.deepEqual(await read(),{available:false});
  const fix={lat:30.267,lon:120.153,observed:now-3600000,zone:"America/Los_Angeles"};
  store.sync(session,{revision:1,place:fix},now);
  assert.deepEqual(await read(),{available:true,observedAt:new Date(fix.observed+8*3600000).toISOString().slice(0,19)+"+08:00",timezone:"Asia/Shanghai"});
  assert.deepEqual({...store.latest(session,now)},{...fix,lat:30.3,lon:120.2,zone:"Asia/Shanghai"});
  store.sync(session,{revision:2,place:null},now);
  store.sync(session,{revision:1,place:fix},now);
  assert.deepEqual(await read(),{available:false});
  store.sync(session,{revision:3,place:fix},now);
  store.expire(now+86400000);
  assert.deepEqual(await read(),{available:false});
  db.close();
});

test("7Timer civil uses Beijing midnight, preserves categories and rejects stale forecasts",async t=>{
  const now=Date.parse("2026-11-27T14:20:00Z");
  t.mock.method(Date,"now",()=>now);
  const base={temp2m:16,wind10m:{speed:2},prec_type:"none",prec_amount:0,weather:"clearnight"};
  const payload={product:"civil",init:"2026112700",dataseries:[
    {...base,timepoint:12}, {...base,timepoint:15}, {...base,timepoint:18,weather:"tsrainnight",temp2m:36,wind10m:{speed:5},prec_type:"rain",prec_amount:4}
  ]};
  t.mock.method(globalThis,"fetch",async (url:string)=>{
    const request=new URL(url);
    assert.equal(request.hostname,"www.7timer.info");
    assert.equal(request.searchParams.get("product"),"civil");
    return Response.json(payload);
  });
  const result=await forecast({lat:30.3,lon:120.2});
  assert.equal(result.periods[0].time,"2026-11-27T20:00:00+08:00");
  assert.deepEqual(result.todayAlerts,[]);
  assert.deepEqual(result.periods[2].alerts,["雷暴","明显降雨","大风","高温"]);
  assert.equal(result.periods[2].wind,"6–7级");
  const city=await cityWeatherTool.execute("test",{lat:30.3,lon:120.2});
  assert.match(city.content[0].text,/晴天钟/);
  await assert.rejects(cityWeatherTool.execute("test",{lat:0,lon:0}),/核实城市/);
  payload.dataseries[1]={...base,timepoint:15,weather:"rainsnownight",prec_type:"frzr",temp2m:-11};
  assert.deepEqual((await forecast({lat:40,lon:116})).todayAlerts,["冻雨","严寒"]);
  payload.init="2026112200";
  await assert.rejects(forecast({lat:32,lon:121}),/未更新/);
});

test("daily ranges use Beijing dates and distinguish incomplete days",async t=>{
  const now=Date.parse("2026-11-27T13:30:00Z");
  t.mock.method(Date,"now",()=>now);
  const temps=[-5,14,18,19,16,8,7,10,13,20,23,17,4,2];
  const dataseries=temps.map((temp2m,i)=>({timepoint:(i+1)*3,temp2m,wind10m:{speed:2},prec_type:"none",prec_amount:0,weather:"clearday"}));
  t.mock.method(globalThis,"fetch",async()=>Response.json({product:"civil",init:"2026112700",dataseries}));
  const result=await forecast({lat:31.2,lon:121.5});
  assert.deepEqual(result.daily,[
    {date:"2026-11-27",minTemp:-5,maxTemp:19,fullDay:false,conditions:["晴"]},
    {date:"2026-11-28",minTemp:4,maxTemp:23,fullDay:true,conditions:["晴"]},
    {date:"2026-11-29",minTemp:2,maxTemp:2,fullDay:false,conditions:["晴"]}
  ]);
});
