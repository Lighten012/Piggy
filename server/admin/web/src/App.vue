<script setup>
import { nextTick, onMounted, onUnmounted, ref } from "vue";

import Capabilities from "./Capabilities.vue";
import MarkdownMessage from "./MarkdownMessage.vue";
import piggyMark from "../../../../android/app/src/main/res/drawable-nodpi/piggy_portrait.webp?no-inline";

function currentView() { return location.hash === "#capabilities" ? "capabilities" : "history"; }
const view = ref(currentView());
async function navigate() {
  view.value = currentView();
  await nextTick();
  if (view.value === "history") refresh();
}
const turns = ref([]);
const thread = ref(null);
const loading = ref(true);
const older = ref(false);
const now = ref(Date.now());
let serverOffset = 0;
function fileUrl(file) { return "/history/files/" + encodeURIComponent(file.key); }
const error = ref("");
const date = new Intl.DateTimeFormat("zh-CN", {year:"numeric", month:"long", day:"numeric"});
const time = new Intl.DateTimeFormat("zh-CN", {hour:"2-digit", minute:"2-digit", hour12:false});
let fetching = false, timer;
const controller = new AbortController();

async function refresh(back = false) {
  if (fetching || view.value !== "history") return;
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
    const timestamp = Date.parse(response.headers.get("Date"));
    if (Number.isFinite(timestamp)) serverOffset = timestamp - Date.now();
    now.value = Date.now() + serverOffset;
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
  window.addEventListener("hashchange", navigate);
  timer = setInterval(() => { if (!document.hidden) { now.value = Date.now() + serverOffset; refresh(); } }, 3000);
  document.addEventListener("visibilitychange", visible);
});
function visible() { if (!document.hidden) { now.value = Date.now() + serverOffset; refresh(); } }
onUnmounted(() => {window.removeEventListener("hashchange", navigate); clearInterval(timer); controller.abort(); document.removeEventListener("visibilitychange", visible);});
</script>
<template>
  <header class="masthead"><div class="bar">
    <div class="brand"><img class="piggy-avatar" :src="piggyMark" alt="" width="44" height="44"><span>Piggy</span></div>
    <nav aria-label="管理端导航">
      <a href="#history" :aria-current="view === 'history' ? 'page' : undefined">对话记录</a>
      <a href="#capabilities" :aria-current="view === 'capabilities' ? 'page' : undefined">Agent 能力</a>
    </nav>
  </div></header>
  <Capabilities v-if="view === 'capabilities'" />
  <main v-show="view === 'history'">
    <div class="heading"><h1>手机对话记录</h1></div>
    <p v-if="error" class="alert" role="status">{{ error }}</p>
    <section id="thread" ref="thread" aria-label="手机对话记录" tabindex="0">
      <div v-if="!turns.length && !error" class="empty">
        <img class="piggy-avatar" :src="piggyMark" alt="" width="64" height="64">
        <p>{{ loading ? "正在读取记录…" : "还没有手机消息" }}</p>
      </div>
      <button v-if="older" type="button" class="older" @click="refresh(true)">查看更早记录</button>
      <article v-for="(row, i) in turns" :key="row.id">
        <div class="day" v-if="i === 0 || date.format(turns[i - 1].created) !== date.format(row.created)"><span>{{ date.format(row.created) }}</span></div>
        <div class="entry mine"><div class="byline">你 <time :datetime="new Date(row.created).toISOString()">{{ time.format(row.created) }}</time></div>
          <div v-for="(file, index) in (row.files ?? (row.filename ? [{name:row.filename,size:row.filesize}] : []))"
               :key="index" class="attachment">
            <span class="file-note">{{ file.name }} · {{ Math.ceil(file.size / 1024) }} KB</span>
            <template v-if="file.key && file.until > now">
              <a v-if="file.preview?.startsWith('image/')" :href="fileUrl(file)" target="_blank" rel="noopener">
                <img class="attachment-photo" :src="fileUrl(file)" :alt="file.name" loading="lazy" decoding="async">
              </a>
              <div class="file-actions">
                <a v-if="file.preview" :href="fileUrl(file)" target="_blank" rel="noopener">查看</a>
                <a :href="fileUrl(file) + '?download=1'" :download="file.name">下载</a>
              </div>
            </template>
          </div>
          <MarkdownMessage class="user" :text="row.question" /></div>
        <div class="entry"><div class="byline"><img class="piggy-avatar" :src="piggyMark" alt="" width="20" height="20">Piggy</div>
          <MarkdownMessage v-if="row.answer" class="assistant" :text="row.answer" />
          <div v-for="file in row.replyFiles" :key="file.key" class="reply-file">
            <span class="file-note">{{ file.name }} · {{ Math.ceil(file.size / 1024) }} KB</span>
            <template v-if="file.until > now">
              <a v-if="file.preview?.startsWith('image/')" :href="fileUrl(file)" target="_blank" rel="noopener">
                <img class="attachment-photo" :src="fileUrl(file)" :alt="file.name" loading="lazy">
              </a>
              <div class="file-actions">
                <a v-if="file.preview" :href="fileUrl(file)" target="_blank" rel="noopener">查看</a>
                <a :href="fileUrl(file) + '?download=1'" :download="file.name">下载</a>
              </div>
            </template>
            <small v-else>附件已过期</small>
          </div>
          <p v-if="row.status !== 'complete'" class="state">{{ row.status === 'pending' ? '正在回复…' : '回复未完成' }}</p>
        </div>
      </article>
    </section>
  </main>
</template>

<style scoped>
nav {display:flex;gap:4px;align-items:center}
nav a {padding:8px 12px;min-height:44px;display:inline-flex;align-items:center;border-radius:22px;text-decoration:none;color:var(--muted);font-size:.92rem}
nav a[aria-current="page"] {color:var(--berry);background:#f2e4e7;font-weight:600}
nav a:focus-visible {outline:2px solid var(--berry);outline-offset:2px}
@media(max-width:440px) { nav a {padding-inline:8px} }
.piggy-avatar { object-fit: contain; border-radius: 50%; }
.attachment { display: grid; justify-items: end; gap: 4px; max-width: 100%; }
.attachment-photo { display: block; max-width: min(180px, 60vw); max-height: 140px; border-radius: 10px; }
.reply-file {display:grid;gap:5px;padding:10px 14px;border:1px solid var(--line);border-radius:14px;background:white;overflow-wrap:anywhere}
.file-actions { display: flex; gap: 16px; }
.file-actions a { color: #754253; font-size: .85rem; padding-block: 3px; }
</style>
