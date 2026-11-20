<script setup>
import { nextTick, ref } from "vue";

const messages = ref([]);
const draft = ref("");
const busy = ref(false);
const status = ref("");
const thread = ref(null);
const input = ref(null);
let session;

function reset() {
  session = undefined;
  messages.value = [];
  draft.value = status.value = "";
  input.value.focus();
}

function enter(event) {
  if (event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send();
}

async function send() {
  const text = draft.value.trim();
  if (!text || busy.value) return;
  const start = messages.value.length;
  messages.value.push({ role: "user", text }, { role: "assistant", text: "" });
  busy.value = true;
  draft.value = "";
  status.value = "正在回复…";
  await nextTick();
  thread.value.scrollTop = thread.value.scrollHeight;
  try {
    const response = await fetch("/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, session }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "", complete = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const lines = (pending + chunk.value).split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        if (event.delta) {
          const box = thread.value;
          const follow = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
          messages.value[start + 1].text += event.delta;
          if (follow) { await nextTick(); box.scrollTop = box.scrollHeight; }
        }
        if (event.done) { session = event.session; complete = true; }
      }
    }
    if (!complete) throw new Error("回复中断，请重试");
    status.value = "";
  } catch (error) {
    messages.value.splice(start);
    draft.value = text;
    status.value = error.message || "发送失败，请重试";
  } finally {
    busy.value = false;
    await nextTick();
    input.value.focus();
  }
}
</script>
<template>
  <header><div class="brand"><i aria-hidden="true">P</i> Piggy</div>
    <button type="button" :disabled="busy" @click="reset">＋ 新对话</button></header>
  <main><section id="thread" ref="thread" aria-label="对话记录" tabindex="0">
    <div v-if="!messages.length" id="empty"><span class="mark" aria-hidden="true">P</span><h1>今天想聊什么？</h1></div>
    <div id="messages"><p v-for="(m, i) in messages" :key="i" class="message" :class="m.role"><strong>{{ m.role === "user" ? "你" : "Piggy" }}</strong>{{ m.text }}</p></div>
  </section>
  <form @submit.prevent="send"><label for="message">给 Piggy 发消息</label>
    <div class="composer"><textarea id="message" ref="input" v-model="draft" :readonly="busy" rows="2" maxlength="8000" placeholder="输入消息…" required @keydown.enter="enter"></textarea><button type="submit" :disabled="busy || !draft.trim()">发送 ↑</button></div>
    <div id="status" role="status">{{ status }}</div>
  </form></main>
</template>
<style>
#app { height: 100%; display: flex; flex-direction: column; }
#app main { margin: 0 auto; }
header button, .composer button { min-height: 44px; }
</style>
