import type { DatabaseSync } from "node:sqlite";
import type { AgentTool } from "@earendil-works/pi-agent-core";

type Period = {start:string; end:string|null};
type CalendarData = {length:number; duration:number; periods:Period[]; through:number};
type Change = {kind:string; start?:string; end?:string|null; length?:number; duration?:number};
export function localToday(zone:unknown):string {
  try {return new Intl.DateTimeFormat("sv-SE",{timeZone:typeof zone==="string"?zone:"Asia/Shanghai"}).format(new Date());}
  catch {return new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai"}).format(new Date());}
}
function validDate(value:unknown,today:string):value is string {
  if (typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value>today) return false;
  const ms=Date.parse(value+"T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10)===value;
}
function apply(state:CalendarData, op:Change, today:string) {
  if(op.kind==="settings"){
    const {length,duration}=op;
    if(typeof length!=="number" || typeof duration!=="number" || !Number.isInteger(length) || !Number.isInteger(duration) ||
        length<2 || length>365 || duration<1 || duration>=length)
      throw new Error("周期和持续天数无效");
    state.length=length;
    state.duration=duration;
    return;
  }
  const {start,end}=op;
  if(!validDate(start,today)) throw new Error("开始日期无效或晚于今天");
  const existing=state.periods.find(p=>p.start===start);
  if(op.kind==="remove"){state.periods=state.periods.filter(p=>p.start!==start);return;}
  if(op.kind==="end" && !existing) throw new Error("这次开始记录已不存在");
  if(op.kind!=="end" && op.kind!=="period") throw new Error("未知经期操作");
  const finish=end===undefined ? existing?.end??null : end;
  if(finish!==null && (!validDate(finish,today)||finish<start)) throw new Error("结束日期须在开始日和今天之间");
  if(state.periods.some(p=>p.start!==start && p.start<=(finish??start) && (p.end??p.start)>=start))
    throw new Error("日期与另一条实记经期重叠");
  if(existing) existing.end=finish;
  else {state.periods.push({start,end:finish});state.periods.sort((a,b)=>a.start.localeCompare(b.start));}
}

export class CycleStore {
  private db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec("CREATE TABLE IF NOT EXISTS cycle_calendars(session TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  read(session:string):CalendarData {
    const row=this.db.prepare("SELECT data FROM cycle_calendars WHERE session=?").get(session);
    return row ? JSON.parse(String(row.data)) : {length:28,duration:5,periods:[],through:0};
  }
  private save(session:string,state:CalendarData) {
    this.db.prepare("INSERT INTO cycle_calendars VALUES(?,?) ON CONFLICT(session) DO UPDATE SET data=excluded.data")
      .run(session,JSON.stringify(state));
  }
  // All reads and writes below are synchronous on the single Pi worker.
  sync(session:string,changes:unknown,today:string) {
    if(!Array.isArray(changes)||changes.length>100) throw new Error("无效的同步批次");
    const state=this.read(session);
    const errors:string[]=[];
    let changed=false;
    for(const op of changes){
      if(!op || !Number.isSafeInteger(op.seq)||op.seq<1||op.seq>state.through+1) throw new Error("同步序号不连续");
      if(op.seq<=state.through) continue;
      try {apply(state,op,today);} catch(e){errors.push(e instanceof Error?e.message:"日期无效");}
      state.through=op.seq;changed=true;
    }
    if(changed)this.save(session,state);
    return {...state,errors};
  }
  record(session:string,start:string,end:string|undefined,today:string) {
    const state=this.read(session);
    apply(state,{kind:"period",start,end},today);
    this.save(session,state);
    return state.periods.find(p=>p.start===start);
  }
}
export const readCycle = {name:"read_cycle_calendar",description:"读取当前用户的实际经期记录、预测设置和当地今天的日期。",
  parameters:{type:"object",properties:{},required:[],additionalProperties:false}} as const;
export const recordPeriod = {name:"record_period",description:"按用户本轮亲述登记实际经期。start 为开始日期；只记录开始时省略 end。已存在的开始日可补录或更正结束日。",
  parameters:{type:"object",properties:{start:{type:"string",description:"YYYY-MM-DD"},end:{type:"string",description:"实际最后一天 YYYY-MM-DD"},quote:{type:"string",description:"逐字引用本条消息中描述自己实际经期的原话"}},
    required:["start","quote"],additionalProperties:false}} as const;
export function cycleTools(store:CycleStore,session:string,question:string,today:string):AgentTool[] {
  const result=(data:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(data)}],details:{}});
  return [
    {...readCycle,label:"查看经期日历",async execute(){
      const {length,duration,periods}=store.read(session);
      return result({today,cycleDays:length,expectedPeriodDays:duration,periods});
    }},
    {...recordPeriod,label:"登记实际经期",executionMode:"sequential",async execute(_id,args){
      const {quote,start,end}=args as {quote:string;start:string;end?:string};
      if(typeof quote!=="string" || !quote.trim() || !question.includes(quote)) throw new Error("请引用用户本轮的实际经期描述");
      return result(store.record(session,start,end??undefined,today));
    }},
  ];
}
