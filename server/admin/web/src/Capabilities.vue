<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";

import Stickers from "./Stickers.vue";
import { renderSkillMarkdown } from "./markdown.js";

const catalog = ref(null);
const loading = ref(false);
const error = ref("");
const controller = new AbortController();

const modes = [{id:"chat",name:"聊天模式"}, {id:"work",name:"工作模式"}];
const drafts = ref({});
const saving = ref("");
const feedback = ref({});
const saveError = ref({});
const phrases = ref("");
const savingPhrases = ref(false);
const phraseFeedback = ref("");
const phraseList = computed(() => phrases.value.split("\n").map(s => s.trim()).filter(Boolean));
const phrasesChanged = computed(() => catalog.value && JSON.stringify(phraseList.value) !== JSON.stringify(catalog.value.replyPhrases));
async function savePhrases() {
  savingPhrases.value = true;
  phraseFeedback.value = "";
  try {
    const res = await fetch("/reply-phrases",{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify(phraseList.value),signal:controller.signal});
    if (!res.ok) throw new Error(res.status === 400 ? "请填写 1 至 48 条短句，每条最多 48 个字符。" : "保存失败，请重试。");
    catalog.value.replyPhrases = await res.json();
    phrases.value = catalog.value.replyPhrases.join("\n");
    phraseFeedback.value = "已保存，手机下次同步后生效。";
  } catch (e) {
    if (e.name !== "AbortError") phraseFeedback.value = e.message;
  } finally { savingPhrases.value = false; }
}
const effortLabels = {off:"关闭",low:"低",medium:"中",high:"高",xhigh:"极高",max:"最高"};
const tierLabels = {default:"标准",priority:"快速 · Fast",ultrafast:"极速 · Ultrafast"};
const choice = mode => catalog.value.models.find(m => m.id === drafts.value[mode].model);
const changed = mode => ["model","effort","tier"].some(k => drafts.value[mode][k] !== catalog.value.profiles[mode][k]);
const dirty = computed(() => catalog.value && modes.some(({id}) => changed(id)));

function switchModel(mode) {
  const draft = drafts.value[mode];
  const selected = choice(mode);
  if (!selected.efforts.includes(draft.effort)) draft.effort = selected.efforts[0];
  if (!selected.tiers.includes(draft.tier)) draft.tier = "default";
}
async function save(mode) {
  if (!changed(mode) || saving.value) return;
  saving.value = mode;
  feedback.value[mode] = "";
  try {
    const res = await fetch("/model-settings",{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({mode,...drafts.value[mode]}),signal:controller.signal});
    if (!res.ok) throw new Error(res.status === 401 ? "请刷新页面后重新登录" : "保存失败，请重试");
    const saved = await res.json();
    catalog.value.profiles[mode] = saved;
    drafts.value[mode] = {...saved};
    saveError.value[mode] = false;
    feedback.value[mode] = "已保存，下次使用此模式时生效。";
  } catch (e) {
    if (e.name !== "AbortError") { saveError.value[mode] = true; feedback.value[mode] = e.message; }
  } finally { saving.value = ""; }
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
    phrases.value = data.replyPhrases.join("\n");
    phraseFeedback.value = "";
    drafts.value = Object.fromEntries(modes.map(({id}) => [id, {...data.profiles[id]}]));
    feedback.value = {};
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
    <div class="heading"><h1>Agent 能力</h1><button type="button" class="reload" :disabled="loading || saving || savingPhrases || phrasesChanged || dirty" @click="reload">刷新</button></div>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取能力清单…</p>
    <template v-if="catalog">
      <section aria-labelledby="model-title">
        <h2 id="model-title">手机模式</h2>

        <form v-for="{id, name} in modes" :key="id" @submit.prevent="save(id)" @change="feedback[id] = ''">
          <h3>{{ name }}</h3>
          <fieldset :disabled="saving || loading">
            <div class="field"><label :for="id + '-model'">模型</label><select :id="id + '-model'" v-model="drafts[id].model" @change="switchModel(id)">
              <option v-for="m in catalog.models" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select></div>
            <div class="field"><label :for="id + '-effort'">思考强度</label><select :id="id + '-effort'" v-model="drafts[id].effort">
              <option v-for="e in choice(id).efforts" :key="e" :value="e">{{ effortLabels[e] }}</option>
            </select></div>
            <div class="field"><label :for="id + '-tier'">回复速度</label><select :id="id + '-tier'" v-model="drafts[id].tier" aria-describedby="speed-note">
              <option v-for="t in choice(id).tiers" :key="t" :value="t">{{ tierLabels[t] }}</option>
            </select></div>
          </fieldset>

          <div class="save-row">
            <button class="save" :disabled="!changed(id) || saving || loading">{{ saving === id ? "正在保存…" : "保存" + name }}</button>
            <span role="status" :class="{problem:saveError[id]}">{{ feedback[id] }}</span>
          </div>
        </form>
        <p id="speed-note" class="empty-note">快速和极速由 OpenAI 按更高费率计费，实际可用性取决于账号额度。</p>
      </section>
      <section aria-labelledby="phrases-title">
        <h2 id="phrases-title">回复等待短句</h2>
        <form @submit.prevent="savePhrases">
          <label for="phrases" class="phrase-label">每行一句，按顺序轮播</label>
          <textarea id="phrases" v-model="phrases" rows="4" :disabled="savingPhrases || loading" @input="phraseFeedback = ''"></textarea>
          <div class="save-row">
            <button class="save" :disabled="!phrasesChanged || savingPhrases || loading">{{ savingPhrases ? "正在保存…" : "保存短句" }}</button>
            <span role="status">{{ phraseFeedback }}</span>
          </div>
        </form>
      </section>
      <Stickers />
      <section aria-labelledby="skills-title">
        <h2 id="skills-title">Skills <span>{{ catalog.skills.length }}</span></h2>
        <p v-if="!catalog.skills.length" class="empty-note">当前服务端未加载任何技能。</p>
        <details v-for="skill in catalog.skills" :key="skill.name">
          <summary><strong>{{ skill.name }}</strong><small>{{ skill.description }}</small></summary>
          <div class="markdown skill-body" v-html="renderSkillMarkdown(skill.instructions)"></div>
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
h3 {margin:20px 0 0;font-size:1rem}
fieldset {display:grid;grid-template-columns:1.45fr 1fr 1.15fr;gap:14px;border:0;margin:18px 0 0;padding:0;min-width:0}
.field {display:grid;gap:6px;min-width:0}
label {font-size:.9rem;font-weight:600}
select {font:inherit;color:inherit;border:1px solid #d8c3c8;border-radius:10px;background:white;padding:0 10px;min-height:44px;width:100%}
.save-row {display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:16px;font-size:.9rem}
.save {border:0;border-radius:20px;min-height:44px;padding:0 20px;background:var(--berry);color:white;font:inherit;cursor:pointer}
.save:disabled {background:#efe8e9;color:#695b60;cursor:default}
.phrase-label {display:block;margin:14px 0 6px}
textarea {box-sizing:border-box;width:100%;resize:vertical;border:1px solid #d8c3c8;border-radius:10px;padding:10px 12px;font:inherit;color:inherit;line-height:1.6}
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
