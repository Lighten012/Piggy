<script setup>
import { onMounted, onUnmounted, ref } from "vue";

const catalog = ref(null);
const loading = ref(false);
const error = ref("");
const controller = new AbortController();

async function reload() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/capabilities", {cache:"no-store", signal:controller.signal});
    if (!response.ok) throw new Error(response.status === 401 ? "请刷新页面后重新登录" : "无法读取能力清单，请重试");
    const data = await response.json();
    if (!Array.isArray(data.skills) || !Array.isArray(data.tools)) throw new Error("能力清单格式有误");
    catalog.value = data;
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
    <div class="heading"><h1>Agent 能力</h1><button type="button" class="reload" :disabled="loading" @click="reload">刷新</button></div>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在读取能力清单…</p>
    <template v-if="catalog">
      <section aria-labelledby="skills-title">
        <h2 id="skills-title">Skills <span>{{ catalog.skills.length }}</span></h2>
        <p v-if="!catalog.skills.length" class="empty-note">当前服务端未加载任何技能。</p>
        <details v-for="skill in catalog.skills" :key="skill.name">
          <summary><strong>{{ skill.name }}</strong><small>{{ skill.description }}</small></summary>
          <pre>{{ skill.instructions }}</pre>
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
.reload:disabled {opacity:.6}
section {margin-top:16px;padding:20px 24px;background:#fffdfc;border:1px solid var(--line);border-radius:18px}
h2 {display:flex;align-items:center;gap:10px;margin:0;font-size:1.15rem}
h2 span {font-size:.85rem;font-weight:500;padding:0 9px;border-radius:12px;color:var(--berry);background:#f4e9ec}
.empty-note,small {color:var(--muted)}
.empty-note {margin:8px 0 0}
details {margin-top:12px;border-top:1px solid var(--line);overflow-wrap:anywhere}
summary {cursor:pointer;padding:12px 0 4px}
small {display:block;margin:3px 0 0 18px;font:inherit;font-size:.9rem}
pre {white-space:pre-wrap;overflow-wrap:anywhere;max-height:25rem;overflow:auto;padding:12px;border-radius:8px;background:#f7f1f2;font-size:.85rem}
@media(max-width:600px) {section {padding:16px}}
</style>
