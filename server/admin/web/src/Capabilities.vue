<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";

import { renderMarkdown } from "./markdown.js";

const catalog = ref(null);
const loading = ref(false);
const error = ref("");
const controller = new AbortController();

const draft = ref(null);
const saving = ref(false);
const feedback = ref("");
const saveError = ref(false);
const effortLabels = {off:"关闭",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最高"};
const tierLabels = {default:"标准",priority:"快速 · Fast",ultrafast:"极速 · Ultrafast"};
const choice = computed(() => catalog.value?.models.find(m => m.id === draft.value?.model));
const dirty = computed(() => draft.value && ["model","effort","tier"].some(k => draft.value[k] !== catalog.value.active[k]));

function switchModel() {
  if (!choice.value.efforts.includes(draft.value.effort)) draft.value.effort = choice.value.efforts[0];
  if (!choice.value.tiers.includes(draft.value.tier)) draft.value.tier = "default";
}
async function save() {
  if (!dirty.value || saving.value) return;
  saving.value = true;
  feedback.value = "";
  try {
    const res = await fetch("/model-settings",{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(draft.value),signal:controller.signal});
    if (!res.ok) throw new Error(res.status === 401 ? "请刷新页面后重新登录" : "保存失败，请重试");
    catalog.value.active = await res.json();
    draft.value = {...catalog.value.active};
    saveError.value = false;
    feedback.value = "已保存，将用于手机的下一条消息。";
  } catch (e) {
    if (e.name !== "AbortError") { saveError.value = true; feedback.value = e.message; }
  } finally { saving.value = false; }
}
async function reload() {
  if (loading.value || saving.value) return;
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/capabilities", {cache:"no-store", signal:controller.signal});
    if (!response.ok) throw new Error(response.status === 401 ? "请刷新页面后重新登录" : "无法读取能力清单，请重试");
    const data = await response.json();
    if (!Array.isArray(data.skills) || !Array.isArray(data.tools)) throw new Error("能力清单格式有误");
    catalog.value = data;
    draft.value = {...data.active};
    feedback.value = "";
  } catch (e) {
    if (e.name !== "AbortError") error.value = e.message;
  } finally {
    loading.value = false;
  }
}
onMounted(reload);
onUnmounted(() => controller.abort());
</script>
<template>
  <main class="catalog">
    <div class="heading"><h1>Agent 能力</h1><button type="button" class="reload" :disabled="loading || saving" @click="reload">刷新</button></div>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取能力清单…</p>
    <template v-if="catalog">
      <section aria-labelledby="model-title" v-if="choice">
        <h2 id="model-title">手机对话模型</h2>
        <p class="empty-note">保存后从手机的下一条消息生效。</p>
        <form @submit.prevent="save" @change="feedback = ''">
          <fieldset :disabled="saving || loading">
            <div class="field"><label for="chat-model">模型</label><select id="chat-model" v-model="draft.model" @change="switchModel">
              <option v-for="m in catalog.models" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select></div>
            <div class="field"><label for="chat-effort">思考强度</label><select id="chat-effort" v-model="draft.effort">
              <option v-for="e in choice.efforts" :key="e" :value="e">{{ effortLabels[e] }}</option>
            </select></div>
            <div class="field"><label for="chat-tier">回复速度</label><select id="chat-tier" v-model="draft.tier" aria-describedby="speed-note">
              <option v-for="t in choice.tiers" :key="t" :value="t">{{ tierLabels[t] }}</option>
            </select></div>
          </fieldset>
          <p id="speed-note" class="empty-note">快速和极速由 OpenAI 按更高费率计费，实际可用性取决于账号额度。</p>
          <div class="save-row">
            <button class="save" :disabled="!dirty || saving || loading">{{ saving ? "正在保存…" : "保存设置" }}</button>
            <span role="status" :class="{problem:saveError}">{{ feedback }}</span>
          </div>
        </form>
      </section>
      <section aria-labelledby="skills-title">
        <h2 id="skills-title">Skills <span>{{ catalog.skills.length }}</span></h2>
        <p v-if="!catalog.skills.length" class="empty-note">当前服务端未加载任何技能。</p>
        <details v-for="skill in catalog.skills" :key="skill.name">
          <summary><strong>{{ skill.name }}</strong><small>{{ skill.description }}</small></summary>
          <div class="markdown skill-body" v-html="renderMarkdown(skill.instructions)"></div>
        </details>
      </section>
      <section aria-labelledby="tools-title">
        <h2 id="tools-title">Tools <span>{{ catalog.tools.length }}</span></h2>
        <p v-if="!catalog.tools.length" class="empty-note">当前 Agent 未注册可调用的工具。</p>
        <details v-for="tool in catalog.tools" :key="tool.name">
          <summary><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small></summary>
          <p v-if="!tool.parameters">由 OpenAI 执行</p>
          <pre v-else aria-label="工具参数">{{ JSON.stringify(tool.parameters, null, 2) }}</pre>
        </details>
      </section>
    </template>
  </main>
</template>
<style scoped>
.catalog {overflow:auto;padding-bottom:32px}
.heading {display:flex;align-items:center;justify-content:space-between;gap:16px}
.reload {font:inherit;font-size:.9rem;color:var(--berry);background:transparent;border:1px solid #d8c3c8;border-radius:22px;padding:6px 18px;min-height:40px;cursor:pointer}
fieldset {display:grid;grid-template-columns:1.45fr 1fr 1.15fr;gap:14px;border:0;margin:18px 0 0;padding:0;min-width:0}
.field {display:grid;gap:6px;min-width:0}
label {font-size:.9rem;font-weight:600}
select {font:inherit;color:inherit;border:1px solid #d8c3c8;border-radius:10px;background:white;padding:0 10px;min-height:44px;width:100%}
.save-row {display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px;font-size:.9rem}
.save {border:0;border-radius:20px;min-height:44px;padding:0 20px;background:var(--berry);color:white;font:inherit;cursor:pointer}
.save:disabled {background:#efe8e9;color:#695b60;cursor:default}
.problem {color:#9a333f}
@media(max-width:640px){fieldset {grid-template-columns:1fr}}
.reload:disabled {opacity:.6}
section {margin-top:16px;padding:20px 24px;background:#fffdfc;border:1px solid var(--line);border-radius:18px}
h2 {display:flex;align-items:center;gap:10px;margin:0;font-size:1.15rem}
h2 span {font-size:.85rem;font-weight:500;padding:0 9px;border-radius:12px;color:var(--berry);background:#f4e9ec}
.empty-note,small {color:var(--muted)}
.empty-note {margin:8px 0 0}
details {margin-top:12px;border-top:1px solid var(--line);overflow-wrap:anywhere}
summary {cursor:pointer;padding:12px 0 4px}
small {display:block;margin:3px 0 0 18px;font:inherit;font-size:.9rem}
.skill-body {max-inline-size:72ch;padding:6px 0 12px;line-height:1.65}
pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:25rem;overflow:auto;padding:12px;border-radius:8px;background:#f7f1f2;font-size:.85rem}
@media(max-width:600px) {section {padding:16px}}
</style>
