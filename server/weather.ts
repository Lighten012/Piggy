import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DatabaseSync } from "node:sqlite";

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
    let zone="Asia/Shanghai";
    if (typeof fix?.zone==="string" && fix.zone.length<=80) {
      try {zone=new Intl.DateTimeFormat("en",{timeZone:fix.zone}).resolvedOptions().timeZone;} catch {}
    }
    this.db.prepare(`INSERT INTO weather_location VALUES(?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET
      revision=excluded.revision,lat=excluded.lat,lon=excluded.lon,observed=excluded.observed,zone=excluded.zone
      WHERE excluded.revision>weather_location.revision`).run(session,value.revision,
        usable?Math.round(fix.lat*10)/10:null,usable?Math.round(fix.lon*10)/10:null,usable?fix.observed:null,usable?zone:null);
  }
  latest(session:string, now=Date.now()) {
    return this.db.prepare("SELECT lat,lon,observed,zone FROM weather_location WHERE session=? AND observed>?").get(session,now-day) as Place|undefined;
  }
  expire(now:number) {
    this.db.prepare("UPDATE weather_location SET lat=NULL,lon=NULL,observed=NULL,zone=NULL WHERE observed<=?").run(now-day);
  }
}

interface Hour {time:string; temp:number; wind:number; rain:number; sky:string}
const source="挪威气象局 MET Norway";
const credit="https://api.met.no/weatherapi/locationforecast/2.0/documentation";
let cache:{key:string;expires:number;hours:Hour[]}|undefined;

export async function forecast(place:Place) {
  const key=place.lat+","+place.lon, now=Date.now();
  if (!cache || cache.key!==key || cache.expires<=now) {
    const params=new URLSearchParams({lat:String(place.lat),lon:String(place.lon)});
    const response=await fetch("https://api.met.no/weatherapi/locationforecast/2.0/compact?"+params,{
      headers:{"User-Agent":"Piggy/0.18 (https://github.com/Lighten012/Piggy)"},signal:AbortSignal.timeout(12_000)});
    if (!response.ok) throw new Error("天气服务暂时不可用");
    const raw=await response.json();
    const hours:Hour[]=[];
    for (const row of raw?.properties?.timeseries ?? []) {
      const instant=row.data?.instant?.details, next=row.data?.next_1_hours;
      if (Number.isFinite(Date.parse(row.time)) && Number.isFinite(instant?.air_temperature) &&
          Number.isFinite(instant.wind_speed) && Number.isFinite(next?.details?.precipitation_amount) && typeof next.summary?.symbol_code==="string")
        hours.push({time:row.time,temp:instant.air_temperature,wind:instant.wind_speed,rain:next.details.precipitation_amount,sky:next.summary.symbol_code});
    }
    if (!hours.length) throw new Error("天气预报数据不完整");
    cache={key,expires:Math.min(Date.parse(response.headers.get("expires")??"") || now+600_000,now+3_600_000),hours};
  }
  const hours=cache.hours.filter(h=>Date.parse(h.time)>now-3_600_000 && Date.parse(h.time)<now+48*3_600_000);
  if (!hours.length || Date.parse(hours[0].time)>now+3_600_000) throw new Error("当地预报暂缺");
  return {source,url:credit,timezone:place.zone,units:"温度 °C，风速 m/s，小时降水 mm；时间为 UTC",hours};
}
export function specialWeather(hours:Hour[]):string[] {
  if (!hours.length) throw new Error("天气预报数据不完整");
  const alerts:string[]=[];
  if(hours.some(h=>h.sky.includes("thunder"))) alerts.push("雷暴");
  if(hours.some(h=>/snow|sleet/.test(h.sky))) alerts.push("降雪或雨夹雪");
  else if(hours.some(h=>h.rain>=2.5) || hours.reduce((sum,h)=>sum+h.rain,0)>=5) alerts.push("明显降雨");
  if(hours.some(h=>h.wind>=10.8)) alerts.push("大风");
  if(hours.some(h=>h.temp>=35)) alerts.push("高温");
  if(hours.some(h=>h.temp<=-10)) alerts.push("严寒");
  return alerts;
}
export function weatherReminder(hours:Hour[], zone:string, now=Date.now()):string|null {
  const day=new Intl.DateTimeFormat("sv-SE",{timeZone:zone});
  const today=day.format(now);
  const remaining=hours.filter(h=>day.format(Date.parse(h.time))===today);
  const warnings=specialWeather(remaining);
  if (!warnings.length) return null;
  return "根据"+source+"当地 "+today+" 接下来几小时的预报，今天可能有"+warnings.join("、")+"。"+
    "预报时段气温 "+Math.min(...remaining.map(h=>h.temp))+"～"+Math.max(...remaining.map(h=>h.temp))+"℃。"+
    "给她一句简短实用的提醒，并注明来源 [MET Norway]("+credit+")。不要称作官方预警。";
}

export const weatherDeclaration={name:"get_local_weather",description:"查询已授权的大致位置的当前及未来约两天的逐小时预报。用户明确指定其他城市时用网页搜索。",parameters:{type:"object",properties:{},additionalProperties:false}} as const;
export function weatherTool(store:WeatherLocations,session:string):AgentTool {
  return {...weatherDeclaration,label:"查询当地天气",async execute(){
    const place=store.latest(session);
    const result=place?await forecast(place):{unavailable:"没有近期授权的位置，请询问城市，或提示可在侧边栏设置里开启当地天气。"};
    return {content:[{type:"text",text:JSON.stringify(result)}],details:{}};
  }};
}
