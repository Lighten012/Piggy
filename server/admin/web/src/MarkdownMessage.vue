<script setup>
import { computed } from "vue";
import { renderMarkdown } from "./markdown.js";

const props = defineProps({ text: { type: String, required: true } });
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <div class="message markdown" v-html="html"></div>
</template>
