<script setup lang="ts">
import AIModelSettings from './AIModelSettings.vue';
import SectionCard from '../../ui/SectionCard.vue';
</script>

<template>
  <SectionCard title="AI 设置" icon="auto_awesome">
    <div class="ai-card-body">
      <AIModelSettings />
      <slot />
    </div>
  </SectionCard>
</template>

<style scoped>
.ai-card-body { display: grid; gap: 16px; min-width: 0; padding: 16px 20px; }
.ai-card-body :deep(.form-body) { padding: 0; }
.ai-card-body :deep(.card-title) { margin: 0 0 8px; font-size: 13px; font-weight: 600; letter-spacing: .02em; }
.ai-card-body :deep(.setting-row) { min-height: 0; padding: 0; border-bottom: 0; }
.ai-card-body :deep(.setting-row:hover) { background: transparent; }
</style>