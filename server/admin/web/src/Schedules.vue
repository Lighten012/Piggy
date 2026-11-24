<script setup>
import { onMounted,onUnmounted,ref } from "vue";
const data=ref({connected:false,tasks:[],runs:[]}), error=ref(""), saving=ref(false), edit=ref(null);
const fresh=()=>({name:"",cron:"0 8 * * *",prompt:"",enabled:true});
const form=ref(fresh()), custom=ref(false), clock=ref("08:00");
const statuses={missed:"停机期间错过",queued:"等待生成",generated:"已生成",failed:"失败",pending:"等待处理",unconfigured:"厂商未配置",unregistered:"设备未注册",accepted:"vivo 已受理",expired:"通知已过时"};
const date=value=>new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(value);
async function api(path,method="GET",body) {
  const r=await fetch(path,{method,cache:"no-store",headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error||"请求失败");
  return r.json();
}
async function refresh() {try {data.value=await api("/schedules");} catch(e){error.value=e.message;}}
function reset(t) {
  edit.value=t?.id||null; form.value=t?{...t,enabled:!!t.enabled}:fresh();
  const daily=/^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(form.value.cron);
  custom.value=!daily;clock.value=daily?daily[2].padStart(2,"0")+":"+daily[1].padStart(2,"0"):"08:00";
}
async function change(fn) {saving.value=true;error.value="";try{await fn();await refresh();}catch(e){error.value=e.message;}finally{saving.value=false;}}
function save() {return change(async()=>{
  const [hour,minute]=clock.value.split(":").map(Number);
  await api("/schedules"+(edit.value?"/"+edit.value:""),edit.value?"PUT":"POST",{...form.value,cron:custom.value?form.value.cron:minute+" "+hour+" * * *"});
  reset();
});}
function remove(t){if(confirm("删除「"+t.name+"」？")) return change(async()=>{await api("/schedules/"+t.id,"DELETE");if(edit.value===t.id)reset();});}
let timer;
onMounted(()=>{refresh();timer=setInterval(()=>{if(!document.hidden)refresh();},10000);});onUnmounted(()=>clearInterval(timer));
</script>
<template>
<main class="schedules">
<h1>定时任务</h1>
<p role="alert" v-if="error">{{ error }}</p>
<section><h2>{{ edit ? "编辑任务" : "新建任务" }}</h2>
<form @submit.prevent="save">
<label>任务名称<input v-model.trim="form.name" required maxlength="80" placeholder="早安问候"></label>
<small v-if="!data.connected">首次打开新版 Piggy 后，定时任务会发到绑定的客户端。</small>
<label>重复方式<select v-model="custom"><option :value="false">每天</option><option :value="true">自定义 Cron</option></select></label>
<label v-if="custom">Cron 表达式（北京时间）<input required v-model="form.cron" placeholder="0 8 * * 1-5"></label>
<label v-else>发送时间（北京时间）<input required type="time" v-model="clock"></label>
<label class="wide">交给 Piggy 的任务<textarea required maxlength="1500" v-model.trim="form.prompt" placeholder="自然地跟她说声早安。" rows="3"></textarea></label>
<div class="wide actions"><button :disabled="saving">{{edit?"保存修改":"创建任务"}}</button><button type="button" v-if="edit" @click="reset()">取消</button></div></form></section>
<section><h2>已设任务</h2><p v-if="!data.tasks.length">还没有定时任务。</p>
<div class="row" v-for="t in data.tasks" :key="t.id"><div><strong>{{t.name}}</strong><small>{{t.enabled ? '下次 '+date(t.next) : '已暂停'}} · {{t.cron}}</small></div>
<div class="actions"><button @click="reset(t)">编辑</button><button :disabled="saving" @click="change(()=>api('/schedules/'+t.id,'PUT',{...t,enabled:!t.enabled}))">{{t.enabled?'暂停':'启用'}}</button><button :disabled="saving" @click="remove(t)">删除</button></div></div></section>
<section><h2>最近执行</h2><p v-if="!data.configured">vivo 推送尚未配置。手机打开 Piggy 后可接收消息。</p>
<div class="row" v-for="(r,i) in data.runs" :key="i"><span>{{r.name}} · {{date(r.due)}}</span><span>{{statuses[r.status]}}<template v-if="r.status==='generated'"> · {{statuses[r.push]}}</template></span></div></section>
</main></template>
<style scoped>
.schedules{max-width:800px;margin:auto;padding:18px 20px 60px;display:block;height:auto;overflow:auto}.schedules section{background:white;border:1px solid var(--line);border-radius:16px;padding:20px;margin:14px 0}.schedules h2{margin:0 0 14px;font-size:1.1rem}.schedules form{display:grid;grid-template-columns:1fr 1fr;gap:12px}.schedules label,small{display:grid;gap:6px}.wide,.schedules form>small{grid-column:1/-1}.schedules input,.schedules textarea,.schedules select,.schedules button{font:inherit;border:1px solid var(--line);border-radius:8px;padding:8px;max-width:100%;min-width:0}.schedules button{cursor:pointer;background:#faf5f7;color:var(--berry)}.row,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.row{justify-content:space-between;padding:12px 0;border-top:1px solid var(--line)}small,p{color:var(--muted)}@media(max-width:520px){.schedules form{grid-template-columns:1fr}}
</style>
