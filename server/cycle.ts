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
    const period=state.periods.find(p=>p.start===start)!;
    if(period.end!==null) return {...period,estimatedEnd:null};
    // Match the phone: count the start as day one and stop before the next recorded period.
    const next=state.periods.find(p=>p.start>start);
    const dayMs=86_400_000;
    const estimated=Math.min(Date.parse(start)+(state.duration-1)*dayMs,next ? Date.parse(next.start)-dayMs : Infinity);
    return {...period,estimatedEnd:new Date(estimated).toISOString().slice(0,10)};
  }
  updatePeriod(session:string, expected:Period, newStart:string|undefined, newEnd:string|undefined, today:string) {
    if(newStart===undefined && newEnd===undefined) throw new Error("请提供要更正的开始日或结束日");
    const state=this.read(session);
    const index=state.periods.findIndex(p=>p.start===expected.start);
    if(index<0 || state.periods[index].end!==expected.end) throw new Error("记录已变化，请重新读取日历核对");
    const start=newStart===undefined ? expected.start : newStart;
    const end=newEnd===undefined ? expected.end : newEnd;
    if(start!==expected.start && state.periods.some(p=>p.start===start)) throw new Error("目标开始日已有另一条记录");
    // Validate against the remaining records; persist the replacement only after all checks pass.
    state.periods.splice(index,1);
    apply(state,{kind:"period",start,end},today);
    this.save(session,state);
    return {start,end};
  }
  updateSettings(session:string, length:number|undefined, duration:number|undefined, expected:CalendarData, today:string) {
    if(length===undefined && duration===undefined) throw new Error("请提供要调整的周期或持续天数");
    const state=this.read(session);
    if((length!==undefined && state.length!==expected.length) || (duration!==undefined && state.duration!==expected.duration))
      throw new Error("周期设置已变化，请重新读取日历核对");
    apply(state,{kind:"settings",length:length===undefined?state.length:length,duration:duration===undefined?state.duration:duration},today);
    this.save(session,state);
    return {cycleDays:state.length,expectedPeriodDays:state.duration};
  }
  cancel(session:string, expected:Period, target:"period"|"end", today:string) {
    const state=this.read(session);
    const current=state.periods.find(p=>p.start===expected.start);
    if(!current) return {status:"not_found",start:expected.start};
    if(current.end!==expected.end) throw new Error("这条记录已更改，请重新读取日历核对");
    if(target==="end" && current.end===null) return {status:"no_end",start:expected.start};
    apply(state,{kind:target==="period"?"remove":"end",start:expected.start,end:null},today);
    this.save(session,state);
    return {status:target==="period"?"period_removed":"end_cleared",start:expected.start};
  }

}
export const readCycle = {name:"read_cycle_calendar",description:"读取当前用户的实际经期记录、预测设置和当地今天的日期。",
  parameters:{type:"object",properties:{},required:[],additionalProperties:false}} as const;
export const recordPeriod = {name:"record_period",description:"按用户本轮亲述登记实际经期。start 为开始日期；只要开始日就能登记，尚未结束时省略 end 或传 null。estimatedEnd 是预测的最后一天。已存在的开始日可补录或更正结束日。",
  parameters:{type:"object",properties:{start:{type:"string",description:"YYYY-MM-DD"},end:{anyOf:[{type:"string"},{type:"null"}],description:"仅填写用户确认的实际最后一天 YYYY-MM-DD，未知时省略或传 null"},quote:{type:"string",description:"逐字引用本条消息中描述自己实际经期的原话"}},
    required:["start","quote"],additionalProperties:false}} as const;
export const cancelPeriod = {name:"cancel_period_record",description:"按已核对的实际开始日撤销一条经期记录，或只清除这次的实际结束日。仅在用户明确要求撤销时使用。",
  parameters:{type:"object",properties:{
    start:{type:"string",description:"已读取的记录开始日期 YYYY-MM-DD"},
    target:{type:"string",enum:["period","end"],description:"period 撤销整次记录；end 只撤销实际结束日"},
    quote:{type:"string",description:"逐字引用用户本轮要求撤销的原话"}},
    required:["start","target","quote"],additionalProperties:false}} as const;
export const updatePeriod = {name:"update_period_record",description:"按旧开始日找到一次实际经期，更正开始日、结束日或同时更正两者。省略的日期保留原值。",
  parameters:{type:"object",properties:{
    start:{type:"string",description:"已核对的原开始日期 YYYY-MM-DD"},
    newStart:{type:"string",description:"更正后的实际开始日 YYYY-MM-DD"},
    newEnd:{type:"string",description:"更正后的实际结束日 YYYY-MM-DD"},
    quote:{type:"string",description:"用户本轮要求更正的原话"}},
    required:["start","quote"],additionalProperties:false}} as const;
export const updateSettings = {name:"update_cycle_settings",description:"调整当前用户的周期间隔或预计经期天数。省略的设置保留原值。",
  parameters:{type:"object",properties:{
    cycleDays:{type:"integer",minimum:2,maximum:365,description:"两次开始日间的天数"},
    expectedPeriodDays:{type:"integer",minimum:1,maximum:364,description:"预计每次持续天数，须小于周期间隔"},
    quote:{type:"string",description:"用户本轮要求调整设置的原话"}},
    required:["quote"],additionalProperties:false}} as const;
export function cycleTools(store:CycleStore,session:string,question:string,today:string):AgentTool[] {
  const result=(data:unknown)=>({content:[{type:"text" as const,text:JSON.stringify(data)}],details:{}});
  let reviewed:CalendarData | undefined;
  function reviewedCalendar() {
    if(!reviewed) throw new Error("请先读取经期日历核对实际记录和设置");
    return reviewed;
  }
  function checkQuote(quote:unknown) {
    if(typeof quote!=="string" || !quote.trim() || !question.includes(quote)) throw new Error("请引用用户本轮操作日历的原话");
  }
  return [
    {...readCycle,label:"查看经期日历",async execute(){
      reviewed=store.read(session);
      const {length,duration,periods}=reviewed;
      return result({today,cycleDays:length,expectedPeriodDays:duration,periods});
    }},
    {...recordPeriod,label:"登记实际经期",executionMode:"sequential",async execute(_id,args){
      const {quote,start,end}=args as {quote:string;start:string;end?:string|null};
      checkQuote(quote);
      return result(store.record(session,start,end?.trim() || undefined,today));
    }},
    {...cancelPeriod,label:"撤销经期记录",executionMode:"sequential",async execute(_id,args){
      const {start,target,quote}=args as {start:string;target:"period"|"end";quote:string};
      checkQuote(quote);
      if(target!=="period" && target!=="end") throw new Error("请指定撤销整次记录或仅撤销结束日");
      const period=reviewedCalendar().periods.find(p=>p.start===start);
      if(!period) return result({status:"not_found",start});
      return result(store.cancel(session,period,target,today));
    }},
    {...updatePeriod,label:"更正实际经期",executionMode:"sequential",async execute(_id,args){
      const {start,newStart,newEnd,quote}=args as {start:string;newStart?:string;newEnd?:string;quote:string};
      checkQuote(quote);
      const period=reviewedCalendar().periods.find(p=>p.start===start);
      if(!period) return result({status:"not_found",start});
      if(newEnd!==undefined && typeof newEnd!=="string") throw new Error("请指定有效结束日；清除结束日请使用撤销工具");
      return result(store.updatePeriod(session,period,newStart,newEnd,today));
    }},
    {...updateSettings,label:"调整周期设置",executionMode:"sequential",async execute(_id,args){
      const {cycleDays,expectedPeriodDays,quote}=args as {cycleDays?:number;expectedPeriodDays?:number;quote:string};
      checkQuote(quote);
      return result(store.updateSettings(session,cycleDays,expectedPeriodDays,reviewedCalendar(),today));
    }},
  ];
}
