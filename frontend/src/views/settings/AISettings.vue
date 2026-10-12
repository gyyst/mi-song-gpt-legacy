<script setup lang="ts">
import AIModelSettings from './AIModelSettings.vue';
import ChatSettings from './ChatSettings.vue';
</script>

<template>
  <div class="ai-settings">
    <p class="ai-settings-intro">先配置默认模型连接，再分别开启口令分析或 AI 对话。两项功能可使用不同模型和超时。</p>
    <AIModelSettings />
    <ChatSettings />
  </div>
</template>

<style scoped>
.ai-settings { display: grid; gap: 16px; min-width: 0; }
.ai-settings-intro { margin: 0; color: var(--md-on-surface-variant); }
</style>
