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

const source="晴天钟（7Timer!）";
const credit="https://www.7timer.info/doc.php?lang=zh-CN";
const skies:Record<string,string>={clear:"晴",pcloudy:"少云",mcloudy:"多云",cloudy:"阴",humid:"潮湿或有雾",lightrain:"小雨",oshower:"局部阵雨",ishower:"零星阵雨",lightsnow:"小雪",rain:"雨",snow:"雪",rainsnow:"雨雪混合",ts:"雷暴",tsrain:"雷雨"};
const windScale=["无风","1–2级","3–4级","5级","6–7级","8–9级","10–11级","12级以上"];
const rainRates=["无","低于0.25","0.25–1","1–4","4–10","10–16","16–30","30–50","50–75","超过75"];

function beijingTime(ms:number) {
  return new Date(ms+8*hour).toISOString().slice(0,19)+"+08:00";
}
function readForecast(raw:any,now:number) {
  const stamp=/^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(raw?.init);
  const issued=stamp?Date.parse(stamp[1]+"-"+stamp[2]+"-"+stamp[3]+"T"+stamp[4]+":00:00Z"):NaN;
  if (raw?.product!=="civil" || !Array.isArray(raw.dataseries) || !Number.isFinite(issued) || issued>now || now-issued>day)
    throw new Error("天气预报未更新");
  const periods=[];
  for (const row of raw.dataseries) {
    const temp=row?.temp2m, wind=row?.wind10m?.speed, rain=row?.prec_amount;
    const sky=skies[String(row?.weather).replace(/(day|night)$/,"")];
    if (!Number.isInteger(row?.timepoint) || row.timepoint<0 || row.timepoint>192 || !sky || !Number.isFinite(temp) || temp< -76 || temp>60 ||
        !Number.isInteger(wind) || wind<1 || wind>8 || !Number.isInteger(rain) || rain<0 || rain>9) continue;
    const time=beijingTime(issued+row.timepoint*hour);
    const alerts:string[]=[];
    if (sky==="雷暴" || sky==="雷雨") alerts.push("雷暴");
    if (row.prec_type==="frzr") alerts.push("冻雨");
    else if (["snow","icep"].includes(row.prec_type) || sky.includes("雪")) alerts.push("降雪或雨雪混合");
    else if (rain>=4 && row.prec_type==="rain") alerts.push("明显降雨");
    if (wind>=5) alerts.push("大风");
    if (temp>=35) alerts.push("高温");
    if (temp<=-10) alerts.push("严寒");
    periods.push({time,temp,sky,wind:windScale[wind-1],precipitationRate:rainRates[rain],alerts});
  }
  return {issuedAt:beijingTime(issued),periods};
}
let cache:{key:string;expires:number;data:ReturnType<typeof readForecast>}|undefined;

export async function forecast(place:{lat:number;lon:number}) {
  const key=place.lat+","+place.lon, now=Date.now();
  if (!cache || cache.key!==key || cache.expires<=now) {
    const params=new URLSearchParams({lon:String(place.lon),lat:String(place.lat),product:"civil",output:"json",unit:"metric"});
    const response=await fetch("https://www.7timer.info/bin/api.pl?"+params,{signal:AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error("晴天钟暂时不可用");
    const data=readForecast(await response.json(),now);
    if (!data.periods.length) throw new Error("天气预报数据不完整");
    cache={key,expires:Math.min(now+hour,Date.parse(data.issuedAt)+day),data};
  }
  const periods=cache.data.periods.filter(p=>Date.parse(p.time)>now-3*hour && Date.parse(p.time)<=now+48*hour);
  if (!periods.length || Date.parse(periods[0].time)>now+3*hour) throw new Error("近期天气预报暂缺");
  const today=beijingTime(now).slice(0,10);
  const todayAlerts=[...new Set(periods.filter(p=>p.time.startsWith(today)).flatMap(p=>p.alerts))];
  return {source,url:credit,timezone,issuedAt:cache.data.issuedAt,units:"北京时间 UTC+8，每3小时一期；温度 °C，降水强度区间 mm/h",periods,todayAlerts};
}

export const locationDeclaration={name:"get_recent_location",description:"按需查询手机是否有 24 小时内的授权大致定位。返回可用状态、采集时间和时区；坐标仅由当地天气工具读取。",parameters:{type:"object",properties:{},additionalProperties:false}} as const;
export function locationTool(store:WeatherLocations,session:string):AgentTool {
  return {...locationDeclaration,label:"查询近期定位",async execute(){
    const place=store.latest(session);
    const result=place?{available:true,observedAt:beijingTime(place.observed),timezone}:{available:false};
    return {content:[{type:"text",text:JSON.stringify(result)}],details:{}};
  }};
}

export const weatherDeclaration={name:"get_local_weather",description:"按北京时间查询未来约两天的晴天钟三小时预报。当地天气用手机近期定位。用户点名其他城市时可传已核实的城市中心经纬度。",parameters:{type:"object",properties:{cityCenter:{type:"object",description:"仅当用户明确指定城市时填写其公开中心坐标。",properties:{lat:{type:"number",minimum:-90,maximum:90},lon:{type:"number",minimum:-180,maximum:180}},required:["lat","lon"],additionalProperties:false}},additionalProperties:false}} as const;
export function weatherTool(store:WeatherLocations,session:string):AgentTool {
  return {...weatherDeclaration,label:"查询当地天气",async execute(_id,args){
    const center=args.cityCenter;
    if (center!=null && (!Number.isFinite(center.lat) || Math.abs(center.lat)>90 || !Number.isFinite(center.lon) || Math.abs(center.lon)>180))
      throw new Error("城市中心坐标无效");
    const place=center??store.latest(session);
    let result;
    if (place) {
      const weather=await forecast(place);
      const latest=center??store.latest(session);
      if (latest?.lat===place.lat && latest.lon===place.lon) result=weather;
    }
    return {content:[{type:"text",text:JSON.stringify(result??{unavailable:"没有近期有效定位。"})}],details:{}};
  }};
}
