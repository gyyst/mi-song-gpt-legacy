<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlButton from '../../ui/SlButton.vue';
import SlIcon from '../../ui/SlIcon.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSelect from '../../ui/SlSelect.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import AIHeadersField from '../../ui/AIHeadersField.vue';
import { parseAIHeaders } from '../../../../src/utils/ai_headers';
import { get, post } from '../../api';
import { AI_PRESET_PROVIDERS } from '../../aiPresets';
import { messageOf, notify, saveConfig, state } from '../../store';

const selectedPreset = ref('custom'), customModel = ref(false);
const models = ref<Array<{ id: string; ownedBy?: string }>>([]);
const loading = ref(false), modelError = ref(''), latency = ref<number | null>(null);
const connectionState = ref<'idle' | 'loading' | 'ok' | 'error'>('idle');
const testQuery = ref(''), testResult = ref(''), testBusy = ref(false);
const customHeaders = ref(JSON.stringify(state.config.ai_config.custom_headers || {}, null, 2));
let alive = true, requestVersion = 0;
const presetOptions = [
  { value: 'custom', label: '自定义（OpenAI 兼容）' },
  ...AI_PRESET_PROVIDERS.map(p => ({ value: p.id, label: p.name, searchText: p.name })),
];
const preset = computed(() => AI_PRESET_PROVIDERS.find(p => p.id === selectedPreset.value));
const CUSTOM_MODEL = '__custom_model__';
const modelOptions = computed(() => [...models.value.map(m => ({ value: m.id, label: m.ownedBy ? `${m.id} (${m.ownedBy})` : m.id, searchText: m.id })), { value: CUSTOM_MODEL, label: '自定义模型名…' }]);
const modelValue = computed(() => customModel.value ? CUSTOM_MODEL : state.config.ai_config.model || '');
const signature = () => {
  let headers: unknown = customHeaders.value;
  try { headers = parseAIHeaders(customHeaders.value); } catch { }
  return JSON.stringify([state.config.ai_config.api_url, state.config.ai_config.api_key, headers]);
};
const connectionText = computed(() => {
  if (connectionState.value === 'loading') return '连接检测中…';
  if (connectionState.value === 'ok') return `已连接 · ${latency.value} ms`;
  if (connectionState.value === 'error') return `连接失败：${modelError.value}`;
  return state.config.ai_config.api_url && state.config.ai_config.api_key ? '未检测' : '未配置';
});

function syncPreset() {
  const url = (state.config.ai_config.api_url || '').trim().replace(/\/+$/, '');
  selectedPreset.value = AI_PRESET_PROVIDERS.find(p => p.baseUrl.replace(/\/+$/, '') === url)?.id || 'custom';
}
async function saveConnection() {
  let headers: Record<string, string>;
  try { headers = parseAIHeaders(customHeaders.value); }
  catch (error) { notify(messageOf(error), 'error'); throw error; }
  await saveConfig({ ai_config: { ...state.config.ai_config, custom_headers: headers } });
}
async function applyPreset(id: string) {
  selectedPreset.value = id;
  const next = AI_PRESET_PROVIDERS.find(p => p.id === id);
  if (!next) return;
  state.config.ai_config.api_url = next.baseUrl;
  if (next.defaultModel) state.config.ai_config.model = next.defaultModel;
  customModel.value = true;
  try { await saveConnection(); } catch { }
}
function selectModel(value: string) {
  customModel.value = value === CUSTOM_MODEL;
  if (customModel.value) return;
  state.config.ai_config.model = value;
  void saveConnection().catch(() => { });
}
async function refreshModels(silent = false) {
  const version = ++requestVersion, identity = signature();
  const current = () => alive && version === requestVersion && identity === signature();
  if (!state.config.ai_config.api_url || !state.config.ai_config.api_key) return;
  loading.value = true; modelError.value = ''; connectionState.value = 'loading';
  const started = Date.now();
  try {
    if (!silent) await saveConnection();
    if (!current()) return;
    const result = await get<{ models: Array<{ id: string; ownedBy?: string }> }>('/voice-commands/models');
    if (!current()) return;
    models.value = Array.isArray(result.models) ? result.models : [];
    latency.value = Date.now() - started; connectionState.value = 'ok';
    customModel.value = !!state.config.ai_config.model && !models.value.some(m => m.id === state.config.ai_config.model);
    if (!silent) notify(`已获取 ${models.value.length} 个模型`, 'success');
  } catch (error) {
    if (!current()) return;
    models.value = []; modelError.value = messageOf(error); connectionState.value = 'error'; customModel.value = true;
    if (!silent) notify(modelError.value, 'error');
  } finally { if (current()) loading.value = false; }
}
async function enableAnalysis(enabled: boolean) {
  if (enabled && !state.config.voice_command_enabled) { notify('请先开启语音口令', 'warning'); return; }
  try { await saveConfig({ ai_config: { ...state.config.ai_config, enabled } }); } catch { }
}
async function testAnalysis() {
  if (testBusy.value || !testQuery.value.trim()) return;
  testBusy.value = true; testResult.value = '';
  const question = testQuery.value.trim();
  const identity = JSON.stringify([signature(), state.config.ai_config.model, state.config.ai_config.timeout]);
  const current = () => alive && testQuery.value.trim() === question && identity === JSON.stringify([signature(), state.config.ai_config.model, state.config.ai_config.timeout]);
  try {
    await saveConnection();
    if (!current()) return;
    const result = await post<Record<string, unknown>>('/voice-commands/ai-test', { query: question });
    if (current()) testResult.value = JSON.stringify(result, null, 2);
  } catch (error) { if (current()) testResult.value = messageOf(error); }
  finally { if (alive) testBusy.value = false; }
}
watch(signature, () => { requestVersion++; models.value = []; loading.value = false; modelError.value = ''; latency.value = null; connectionState.value = 'idle'; syncPreset(); });
watch(() => JSON.stringify(state.config.ai_config.custom_headers || {}), () => { customHeaders.value = JSON.stringify(state.config.ai_config.custom_headers || {}, null, 2); });
onMounted(() => { syncPreset(); customModel.value = !!state.config.ai_config.model; void refreshModels(true); });
onUnmounted(() => { alive = false; requestVersion++; });
</script>

<template>
  <div class="form-body">
    <h3 class="card-title">AI 口令分析</h3>
    <p class="field-help">可选的 OpenAI 兼容接口，用于解析复杂自然语言口令。</p>
    <SettingRow title="启用 AI 分析" :subtitle="state.config.voice_command_enabled ? '规则和记忆未命中时再调用 AI' : '需要先开启语音口令'"><SlSwitch aria-label="启用 AI 分析" :model-value="!!state.config.ai_config.enabled" :disabled="!state.config.voice_command_enabled" @update:model-value="enableAnalysis" /></SettingRow>
    <div v-if="!state.config.voice_command_enabled" class="dependency-hint"><SlIcon name="warning" :size="18" /><span>需要先开启"语音口令"才能使用 AI 分析。</span></div>
    <div class="field"><label class="field-label">预设服务商</label><SlSelect :model-value="selectedPreset" :options="presetOptions" placeholder="选择预设或自定义" aria-label="选择 AI 预设服务商" @update:model-value="applyPreset" /></div>
    <div v-if="selectedPreset === 'custom'" class="field"><label class="field-label">API 地址</label><SlInput v-model="state.config.ai_config.api_url" aria-label="默认 AI API 地址" placeholder="https://api.example.com/v1" @change="saveConnection().catch(() => {})" /></div>
    <div class="field"><label class="field-label">API Key</label><SlInput v-model="state.config.ai_config.api_key" type="password" placeholder="sk-..." aria-label="默认 AI API 密钥" @change="saveConnection().catch(() => {})" /></div>
    <AIHeadersField v-model="customHeaders" label="默认 AI 自定义请求头" @change="saveConnection().catch(() => {})" />
    <a v-if="preset" class="preset-key-link" :href="preset.apiKeyUrl" target="_blank" rel="noopener">前往 {{ preset.name }} 获取 API Key ↗</a>
    <div class="field-grid">
      <div class="field">
        <label class="field-label">模型</label>
        <div class="inline-fields model-row">
          <SlSelect :model-value="modelValue" :options="modelOptions" placeholder="点击刷新获取可用模型" aria-label="选择 AI 模型" searchable search-placeholder="搜索模型名称" @update:model-value="selectModel" />
          <SlButton label="刷新" variant="outlined" icon="refresh" :disabled="loading || !state.config.ai_config.api_url || !state.config.ai_config.api_key" @click="refreshModels()" title="调用 /models 预检 API、获取模型列表并测量延迟" />
        </div>
        <template v-if="customModel">
          <SlInput v-model="state.config.ai_config.model" class="model-custom-input" aria-label="手动填写 AI 模型名" placeholder="手动填写模型名，如 qwen-plus" @change="saveConnection().catch(() => {})" />
          <div class="field-help">若接口不支持 /v1/models 或列表没有目标模型，可直接填写模型名。</div>
        </template>
      </div>
      <div class="field"><label class="field-label">超时（秒）</label><SlInput :model-value="String(state.config.ai_config.timeout || 6)" type="number" aria-label="AI 口令分析超时" @update:model-value="state.config.ai_config.timeout = Math.max(1, Math.min(30, Number($event) || 6))" @change="saveConnection().catch(() => {})" /></div>
    </div>
    <div class="status-chips"><span class="chip" :class="{ 'chip-success': connectionState === 'ok', 'chip-warning': connectionState === 'error' }">{{ connectionText }}</span></div>
    <div v-if="modelError" class="field-help" style="color:#ef5350;">{{ modelError }}</div>
    <div class="command-test-panel command-test-panel-inset"><strong>AI 分析测试</strong><div class="inline-fields"><SlInput v-model="testQuery" aria-label="AI 分析测试问题" placeholder="输入自然语言口令" @submit="testAnalysis" /><SlButton label="测试分析" variant="outlined" icon="science" :disabled="testBusy || !testQuery.trim()" @click="testAnalysis" /></div><pre v-if="testResult" class="result-pre">{{ testResult }}</pre></div>
  </div>
</template>