import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";

const timezone = "Asia/Shanghai";
const hour = 3_600_000;
const day = 86_400_000;
export interface Place {lat:number;lon:number;observed:number;zone:string}
export class WeatherLocations {
  private readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec("CREATE TABLE IF NOT EXISTS weather_location(session TEXT PRIMARY KEY, revision INTEGER NOT NULL, lat REAL, lon REAL, observed INTEGER, zone TEXT)");
  }
  sync(session:string, value:any, now=Date.now()) {
    if (!value || !Number.isSafeInteger(value.revision) || value.revision<=0) return;
    const fix=value.place;
    if (fix!==null && (!fix || !Number.isFinite(fix.lat) || Math.abs(fix.lat)>90 ||
      !Number.isFinite(fix.lon) || Math.abs(fix.lon)>180 || !Number.isSafeInteger(fix.observed) || fix.observed>now+300_000)) return;
    const usable=fix && fix.observed>now-day;
    const update=this.db.prepare(`INSERT INTO weather_location VALUES(?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET
      revision=excluded.revision,lat=excluded.lat,lon=excluded.lon,observed=excluded.observed,zone=excluded.zone
      WHERE excluded.revision>weather_location.revision`).run(session,value.revision,
        usable?Math.round(fix.lat*10)/10:null,usable?Math.round(fix.lon*10)/10:null,usable?fix.observed:null,usable?timezone:null);
    if (update.changes && !usable) cache=undefined;
  }
  latest(session:string, now=Date.now()) {
    return this.db.prepare("SELECT lat,lon,observed,'Asia/Shanghai' AS zone FROM weather_location WHERE session=? AND observed>?").get(session,now-day) as Place|undefined;
  }
  expire(now:number) {
    if (cache && cache.expires<=now) cache=undefined;
    this.db.prepare("UPDATE weather_location SET lat=NULL,lon=NULL,observed=NULL,zone=NULL WHERE observed<=?").run(now-day);
  }
}

type Coordinates={lat:number;lon:number};
type View="daily"|"hourly"|"warnings";
const viewParameter={type:"string",enum:["daily","hourly","warnings"],description:"整日概况用 daily（默认），具体时段和降水用 hourly，气象部门的有效预警用 warnings。"} as const;

function beijingTime(ms:number) {
  return new Date(ms+8*hour).toISOString().slice(0,19)+"+08:00";
}
async function request(path:string,params:Record<string,string>) {
  const host=(process.env.QWEATHER_API_HOST??"").trim().replace(/^https:\/\//,"").replace(/\/$/,"");
  const key=process.env.QWEATHER_API_KEY?.trim();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.qweatherapi\.com$/i.test(host) || !key)
    throw new Error("服务端尚未配置和风天气");
  const res=await fetch("https://"+host+path+"?"+new URLSearchParams({lang:"zh",...params}),{
    headers:{"X-QW-Api-Key":key},redirect:"error",signal:AbortSignal.timeout(12000)});
  if (!res.ok) throw new Error("和风天气请求失败（HTTP "+res.status+"）");
  return res.json();
}
async function resolveArea(place:Coordinates) {
  const raw=await request("/geo/v2/city/lookup",{location:place.lon.toFixed(2)+","+place.lat.toFixed(2),number:"1"});
  const city=raw.location?.[0];
  if (raw.code!=="200" || !city?.name) throw new Error("暂时无法确认天气对应的城市或区县");
  return {area:[...new Set([city.adm2,city.name].filter(Boolean))].join(" · "),url:city.fxLink || "https://www.qweather.com/"};
}
async function readWeather(coords:string,view:View,now:number) {
  const today=beijingTime(now).slice(0,10);
  if (view==="daily") {
    const data=await request("/weather/v1/daily/"+coords,{days:"3"});
    const daily=(data.days??[]).flatMap((d:any)=>{
      const start=Date.parse(d.forecastStartTime),minTemp=d.temperatureMin?.value,maxTemp=d.temperatureMax?.value;
      if (!Number.isFinite(start) || !Number.isFinite(minTemp) || !Number.isFinite(maxTemp) || minTemp>maxTemp) return [];
      const date=beijingTime(start).slice(0,10);
      return date<today?[]:[{date,minTemp,maxTemp,daytime:d.daytime?.condition?.text,nighttime:d.nighttime?.condition?.text}];
    });
    if (!daily.length) throw new Error("近期逐日预报暂缺");
    return {daily,attributions:data.metadata?.attributions??[]};
  }
  if (view==="hourly") {
    const data=await request("/weather/v1/hourly/"+coords,{hours:"48"});
    const periods=(data.hours??[]).flatMap((h:any)=>{
      const time=Date.parse(h.forecastTime);
      if (!Number.isFinite(time) || time<=now-hour || !Number.isFinite(h.temperature?.value) || !h.condition?.text) return [];
      return [{time:beijingTime(time),temp:h.temperature.value,sky:h.condition.text,windMs:h.wind?.speed?.value,
        precipMm:h.precipitation?.amount?.value,precipType:h.precipitation?.type}];
    });
    if (!periods.length) throw new Error("近期逐小时预报暂缺");
    return {periods,attributions:data.metadata?.attributions??[]};
  }
  if (view!=="warnings") throw new Error("天气查询类型无效");
  const data=await request("/weatheralert/v1/current/"+coords,{});
  if (!Array.isArray(data.alerts) && data.metadata?.zeroResult!==true) throw new Error("气象预警数据暂缺");
  const alerts=data.alerts??[];
  const superseded=new Set(alerts.flatMap((w:any)=>w.messageType?.supersedes??[]));
  const warnings=alerts.filter((w:any)=>!superseded.has(w.id) && ["alert","update"].includes(w.messageType?.code) && w.headline &&
    (!w.expireTime || Date.parse(w.expireTime)>now)).map((w:any)=>({headline:w.headline,sender:w.senderName,
      effectiveTime:w.effectiveTime,expires:w.expireTime,instruction:w.instruction}));
  return {warnings,attributions:data.metadata?.attributions??[]};
}
let cache:{key:string;expires:number;data:Awaited<ReturnType<typeof readWeather>>}|undefined;
export async function forecast(place:Coordinates,view:View="daily") {
  const coords=place.lat.toFixed(2)+"/"+place.lon.toFixed(2);
  const key=coords+"/"+view,now=Date.now();
  const cached=cache?.key===key && cache.expires>now ? cache.data:undefined;
  const [area,data]=await Promise.all([resolveArea(place),cached??readWeather(coords,view,now)]);
  // 只缓存天气值，行政区按本次坐标重新解析。跨整点后重查。
  if (!cached && view!=="warnings") cache={key,expires:(Math.floor(now/hour)+1)*hour,data};
  return {source:"和风天气",timezone,...area,...data};
}

export const locationDeclaration={name:"get_recent_location",description:"查询手机近期授权的大致位置，返回已核实的城市或区县、采集时间和时区。",parameters:{type:"object",properties:{},additionalProperties:false}} as const;
export function locationTool(store:WeatherLocations,session:string):AgentTool {
  return {...locationDeclaration,label:"查询近期定位",async execute(){
    const place=store.latest(session);
    let result:Record<string,unknown>={available:false};
    if (place) {
      const area=await resolveArea(place);
      const latest=store.latest(session);
      if (latest?.lat===place.lat && latest.lon===place.lon)
        result={available:true,area:area.area,observedAt:beijingTime(latest.observed),timezone};
    }
    return {content:[{type:"text",text:JSON.stringify(result)}],details:{}};
  }};
}

export const cityWeatherDeclaration={name:"get_city_weather",description:"查询用户指定城市的和风天气，使用已核实的公开城市中心坐标。",parameters:{type:"object",properties:{lat:{type:"number",minimum:-90,maximum:90},lon:{type:"number",minimum:-180,maximum:180},view:viewParameter},required:["lat","lon"],additionalProperties:false}} as const;
export const cityWeatherTool:AgentTool={...cityWeatherDeclaration,label:"查询指定城市天气",async execute(_id,center){
  if (!Number.isFinite(center.lat) || Math.abs(center.lat)>90 || !Number.isFinite(center.lon) || Math.abs(center.lon)>180 || (center.lat===0 && center.lon===0))
    throw new Error("请先核实城市中心坐标");
  return {content:[{type:"text",text:JSON.stringify(await forecast(center,center.view))}],details:{}};
}};

export const weatherDeclaration={name:"get_local_weather",description:"按手机近期授权定位查询和风天气及对应地区。",parameters:{type:"object",properties:{view:viewParameter},additionalProperties:false}} as const;
export function weatherTool(store:WeatherLocations,session:string):AgentTool {
  return {...weatherDeclaration,label:"查询当地天气",async execute(_id,args){
    const place=store.latest(session);
    let result;
    if (place) {
      const weather=await forecast(place,args.view);
      const latest=store.latest(session);
      if (latest?.lat===place.lat && latest.lon===place.lon) result=weather;
    }
    return {content:[{type:"text",text:JSON.stringify(result??{unavailable:"没有近期有效定位。"})}],details:{}};
  }};
}
