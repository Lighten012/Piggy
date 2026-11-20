<script setup>
import { nextTick, onMounted, onUnmounted, ref } from "vue";

const turns = ref([]);
const thread = ref(null);
const loading = ref(true);
const older = ref(false);
const error = ref("");
const format = new Intl.DateTimeFormat("zh-CN", {dateStyle:"medium", timeStyle:"short"});
let fetching = false, timer;
const controller = new AbortController();

async function refresh(back = false) {
  if (fetching) return;
  fetching = true;
  const box = thread.value;
  const first = turns.value[0], last = turns.value.at(-1);
  const pending = turns.value.find(row => row.status === "pending");
  let query = "";
  if (back && first) query = "?before=" + first.id;
  else if (last) query = "?after=" + (pending ? pending.id - 1 : last.id);
  try {
    const response = await fetch("/history" + query, {signal:controller.signal,cache:"no-store"});
    if (!response.ok) throw new Error(response.status === 401 ? "请刷新页面后重新登录" : "暂时无法读取记录，正在重试");
    const {turns:page} = await response.json();
    error.value = "";
    if (!first || back) older.value = page.length === 40;
    const oldHeight = box.scrollHeight;
    const follow = !back && (!first || box.scrollHeight - box.clientHeight - box.scrollTop < 80);
    if (back) turns.value.unshift(...page);
    else for (const row of page) {
      const index = turns.value.findIndex(item => item.id === row.id);
      if (index === -1) turns.value.push(row);
      else turns.value[index] = row;
    }
    if (page.length || loading.value) {
      loading.value = false;
      await nextTick();
      if (back) box.scrollTop += box.scrollHeight - oldHeight;
      else if (follow) box.scrollTop = box.scrollHeight;
    }
  } catch (e) {
    if (e.name !== "AbortError") error.value = e.message || "无法读取记录";
  } finally {
    loading.value = false;
    fetching = false;
  }
}
onMounted(() => {
  refresh();
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 3000);
  document.addEventListener("visibilitychange", visible);
});
function visible() { if (!document.hidden) refresh(); }
onUnmounted(() => {clearInterval(timer); controller.abort(); document.removeEventListener("visibilitychange", visible);});
</script>
<template>
  <header><div class="brand"><i aria-hidden="true">P</i> Piggy</div><span>手机对话记录</span></header>
  <main><p v-if="error" role="status">{{ error }}</p>
    <section id="thread" ref="thread" aria-label="手机对话记录" tabindex="0">
      <div v-if="!turns.length && !error" id="empty"><span class="mark" aria-hidden="true">P</span>
        <h1>{{ loading ? "正在读取记录…" : "还没有手机消息" }}</h1></div>
      <button v-if="older" type="button" class="older" @click="refresh(true)">查看更早记录</button>
      <article v-for="row in turns" :key="row.id">
        <time :datetime="new Date(row.created).toISOString()">{{ format.format(row.created) }}</time>
        <p class="message user"><strong>你</strong>{{ row.question }}</p>
        <p v-if="row.answer" class="message assistant"><strong>Piggy</strong>{{ row.answer }}</p>
        <p v-if="row.status !== 'complete'" class="state">{{ row.status === 'pending' ? '正在回复…' : '回复未完成' }}</p>
      </article>
    </section>
  </main>
</template>
<style>
#app { height:100%; display:flex; flex-direction:column }
#app main { margin:0 auto }
header span,time,.state {color:#526457;font-size:.875rem}
article {display:flex;flex-direction:column;gap:12px;padding:14px 0 22px}
time {align-self:center}
.older {align-self:center;min-height:44px;padding:0 16px;border-radius:22px;background:white;border:1px solid #adbbaa;color:inherit}
.state {margin:0}
</style>
