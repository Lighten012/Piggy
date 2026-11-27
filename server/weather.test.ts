import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { WeatherLocations, locationTool, weatherTool, forecast, cityWeatherTool } from "./weather.ts";

const now=Date.parse("2026-11-27T23:15:00+08:00");
const city={adm2:"杭州",name:"西湖",fxLink:"https://www.qweather.com/"};
function provider(t:TestContext,respond:(url:URL)=>unknown) {
  const host=process.env.QWEATHER_API_HOST,key=process.env.QWEATHER_API_KEY;
  process.env.QWEATHER_API_HOST="test.qweatherapi.com";
  process.env.QWEATHER_API_KEY="fixture-only";
  t.after(()=>{
    if (host===undefined) delete process.env.QWEATHER_API_HOST; else process.env.QWEATHER_API_HOST=host;
    if (key===undefined) delete process.env.QWEATHER_API_KEY; else process.env.QWEATHER_API_KEY=key;
  });
  t.mock.method(Date,"now",()=>now);
  t.mock.method(globalThis,"fetch",async(url:string,init:RequestInit)=>{
    const u=new URL(url);
    assert.equal(u.host,"test.qweatherapi.com");
    assert.equal(new Headers(init.headers).get("X-QW-Api-Key"),"fixture-only");
    assert.equal(u.searchParams.get("lang"),"zh");
    return Response.json(await respond(u));
  });
}
const area={code:"200",location:[city]};
test("authorized coarse location resolves to an area; stale and revoked fixes stay unavailable",async t=>{
  provider(t,url=>{
    assert.equal(url.pathname,"/geo/v2/city/lookup");
    assert.equal(url.searchParams.get("location"),"120.20,30.30");
    return area;
  });
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const store=new WeatherLocations(db),session="test";
  const read=async()=>JSON.parse((await locationTool(store,session).execute("test",{})).content[0].text);
  const fix={lat:30.267,lon:120.153,observed:now};
  assert.deepEqual(await read(),{available:false});
  store.sync(session,{revision:1,place:fix});
  assert.deepEqual(await read(),{available:true,area:"杭州 · 西湖",observedAt:"2026-11-27T23:15:00+08:00",timezone:"Asia/Shanghai"});
  store.sync(session,{revision:2,place:null});
  store.sync(session,{revision:1,place:fix});
  assert.deepEqual(await read(),{available:false});
  store.sync(session,{revision:3,place:fix});
  store.expire(now+86400000);
  assert.deepEqual(await read(),{available:false});
});

test("daily view uses provider min/max and Beijing date; city-only names are not doubled",async t=>{
  provider(t,url=>{
    if (url.pathname.startsWith("/geo/")) return {code:"200",location:[{...city,name:"杭州"}]};
    assert.equal(url.pathname,"/weather/v1/daily/30.31/120.21");
    assert.equal(url.searchParams.get("days"),"3");
    return {metadata:{attributions:["测试来源"]},days:[{forecastStartTime:"2026-11-27T16:00Z",
      temperatureMin:{value:8},temperatureMax:{value:19},daytime:{condition:{text:"晴"}},nighttime:{condition:{text:"阴"}}}]};
  });
  const result=await cityWeatherTool.execute("test",{lat:30.31,lon:120.21});
  assert.deepEqual(JSON.parse(result.content[0].text),{area:"杭州",url:city.fxLink,source:"和风天气",timezone:"Asia/Shanghai",
    attributions:["测试来源"],daily:[{date:"2026-11-28",minTemp:8,maxTemp:19,daytime:"晴",nighttime:"阴"}]});
  await assert.rejects(cityWeatherTool.execute("test",{lat:0,lon:0}),/核实城市/);
});

test("hourly view reports measurements without choosing reminder thresholds",async t=>{
  provider(t,url=>{
    if (url.pathname.startsWith("/geo/")) return area;
    assert.equal(url.pathname,"/weather/v1/hourly/30.32/120.22");
    return {hours:[{forecastTime:"2026-11-27T16:00Z",temperature:{value:16},condition:{text:"小雨"},
      wind:{speed:{value:3}},precipitation:{amount:{value:1.2},type:"rain"}}]};
  });
  assert.deepEqual((await forecast({lat:30.32,lon:120.22},"hourly")).periods,
    [{time:"2026-11-28T00:00:00+08:00",temp:16,sky:"小雨",windMs:3,precipMm:1.2,precipType:"rain"}]);
});

test("warning results keep active notices and distinguish no warnings from missing data",async t=>{
  let response:any={alerts:[
    {id:"old",messageType:{code:"alert"},headline:"已被替代"},
    {messageType:{code:"update",supersedes:["old"]},headline:"大风预警",senderName:"气象台"},
    {messageType:{code:"alert"},headline:"过期",expireTime:"2026-11-26T00:00Z"}]};
  provider(t,url=>url.pathname.startsWith("/geo/")?area:response);
  const read=()=>forecast({lat:30.33,lon:120.23},"warnings");
  assert.deepEqual((await read()).warnings.map(w=>w.headline),["大风预警"]);
  response={metadata:{zeroResult:true}};
  assert.deepEqual((await read()).warnings,[]);
  response={};await assert.rejects(read(),/预警数据暂缺/);
});

test("revoking a location during lookup prevents its forecast reaching the model",async t=>{
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const store=new WeatherLocations(db);
  store.sync("s",{revision:1,place:{lat:31,lon:121,observed:now}},now);
  provider(t,url=>{
    if (url.pathname.startsWith("/geo/")) return area;
    store.sync("s",{revision:2,place:null});
    return {metadata:{zeroResult:true}};
  });
  const result=await weatherTool(store,"s").execute("test",{view:"warnings"});
  assert.deepEqual(JSON.parse(result.content[0].text),{unavailable:"没有近期有效定位。"});
});
