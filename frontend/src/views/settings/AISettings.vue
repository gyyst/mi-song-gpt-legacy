<script setup lang="ts">
import AIModelSettings from './AIModelSettings.vue';
import ChatSettings from './ChatSettings.vue';
import SectionCard from '../../ui/SectionCard.vue';
</script>

<template>
  <SectionCard title="AI 设置" icon="auto_awesome" description="模型连接、口令分析、问答接管与 AI 对话在同一处配置。">
    <div class="ai-card-body">
      <AIModelSettings />
      <slot />
      <ChatSettings />
    </div>
  </SectionCard>
</template>

<style scoped>
.ai-card-body { display: grid; gap: 16px; min-width: 0; }
</style>
