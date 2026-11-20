<script setup>
import { nextTick, onMounted, onUnmounted, ref } from "vue";

import piggyMark from "./assets/piggy.svg?no-inline";

const turns = ref([]);
const thread = ref(null);
const loading = ref(true);
const older = ref(false);
const error = ref("");
const date = new Intl.DateTimeFormat("zh-CN", {year:"numeric", month:"long", day:"numeric"});
const time = new Intl.DateTimeFormat("zh-CN", {hour:"2-digit", minute:"2-digit", hour12:false});
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
  <header class="masthead"><div class="bar">
    <div class="brand"><img :src="piggyMark" alt="" width="44" height="44"><span>Piggy</span></div>
    <span class="mode">只读</span>
  </div></header>
  <main>
    <div class="heading"><h1>手机对话记录</h1></div>
    <p v-if="error" class="alert" role="status">{{ error }}</p>
    <section id="thread" ref="thread" aria-label="手机对话记录" tabindex="0">
      <div v-if="!turns.length && !error" class="empty">
        <img :src="piggyMark" alt="" width="64" height="64">
        <p>{{ loading ? "正在读取记录…" : "还没有手机消息" }}</p>
      </div>
      <button v-if="older" type="button" class="older" @click="refresh(true)">查看更早记录</button>
      <article v-for="(row, i) in turns" :key="row.id">
        <div class="day" v-if="i === 0 || date.format(turns[i - 1].created) !== date.format(row.created)"><span>{{ date.format(row.created) }}</span></div>
        <div class="entry mine"><div class="byline">你 <time :datetime="new Date(row.created).toISOString()">{{ time.format(row.created) }}</time></div>
          <span v-if="row.filename" class="file-note">{{ row.filename }} · {{ Math.ceil(row.filesize / 1024) }} KB</span>
          <p class="message user">{{ row.question }}</p></div>
        <div class="entry"><div class="byline"><img :src="piggyMark" alt="" width="20" height="20">Piggy</div>
          <p v-if="row.answer" class="message assistant">{{ row.answer }}</p>
          <p v-if="row.status !== 'complete'" class="state">{{ row.status === 'pending' ? '正在回复…' : '回复未完成' }}</p>
        </div>
      </article>
    </section>
  </main>
</template>
