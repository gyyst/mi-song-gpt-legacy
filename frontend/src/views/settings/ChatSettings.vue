<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { DEFAULT_CHAT_CONFIG } from '../../../../src/chat/types';
import type { ChatConfig, ChatMemory, ChatTurn } from '../../../../src/chat/types';
import { del, get, messageOf, post, put, query } from '../../api';
import { confirmAction, deviceId, deviceName, managedDevices, notify, saveConfig, selectDevice, state } from '../../store';
import SectionCard from '../../ui/SectionCard.vue';
import SettingRow from '../../ui/SettingRow.vue';
import SlInput from '../../ui/SlInput.vue';
import SlSwitch from '../../ui/SlSwitch.vue';
import SlButton from '../../ui/SlButton.vue';
import SlSelect from '../../ui/SlSelect.vue';

const config = reactive<ChatConfig>({ ...DEFAULT_CHAT_CONFIG, trigger_words: [...DEFAULT_CHAT_CONFIG.trigger_words] });
const triggers = ref(config.trigger_words.join('、'));
const loaded = ref(false), busy = ref(false), error = ref(''), question = ref(''), speak = ref(true);
const history = ref<ChatTurn[]>([]), memories = ref<ChatMemory[]>([]), summary = ref(''), offset = ref(0), total = ref(0);
const memoryDrafts = reactive<Record<string, string>>({});
let refreshVersion = 0;
const newMemory = ref(''), models = ref<Array<{ id: string }>>([]);
const target = computed(() => ({ account_id: state.currentAccountId, device_id: state.currentDeviceId }));
const targetQuery = computed(() => query(target.value));
const phases: Record<string, string> = { queued: '排队中', preparing: '暂停音乐', generating: '生成回答', speaking: '播报中', resuming: '恢复音乐', completed: '已完成', cancelled: '已取消', failed: '失败', unknown: '播报结束未确认' };
const deviceSelection = computed(() => JSON.stringify([state.currentAccountId, state.currentDeviceId]));
const deviceOptions = computed(() => managedDevices.value.map(item => ({ value: JSON.stringify([item.accountId, deviceId(item.device)]), label: `${deviceName(item.device)} · ${item.accountName}` })));
const phase = computed(() => state.chatStatus ? phases[state.chatStatus.phase] : '空闲');
const active = computed(() => !!state.chatStatus && ['queued', 'preparing', 'generating', 'speaking', 'resuming'].includes(state.chatStatus.phase));

async function action(run: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await run(); } catch (e) { error.value = messageOf(e); notify(error.value, 'error'); }
  finally { busy.value = false; }
}
async function refresh() {
  const version = ++refreshVersion;
  if (!target.value.account_id || !target.value.device_id) { history.value = []; memories.value = []; summary.value = ''; return; }
  const identity = targetQuery.value;
  const [h, m] = await Promise.all([
    get<{ history: ChatTurn[]; total: number; summary: string }>(`/chat/history${query({ ...target.value, offset: offset.value, limit: 20 })}`),
    get<{ memories: ChatMemory[] }>(`/chat/memories${identity}`),
  ]);
  if (!alive || version !== refreshVersion || identity !== targetQuery.value) return;
  history.value = h.history; total.value = h.total; summary.value = h.summary; memories.value = m.memories;
}
async function save() {
  config.trigger_words = triggers.value.split(/[、,，\n]/).map(v => v.trim()).filter(Boolean);
  Object.assign(config, await put<ChatConfig>('/chat/config', config));
  notify('AI 对话设置已保存', 'success');
}
async function submit() {
  await post('/chat/messages', { ...target.value, text: question.value, speak: speak.value });
  question.value = ''; await refresh();
}
async function clear(range: 'history' | 'memory' | 'all') {
  const identity = targetQuery.value;
  if (!(await confirmAction('清理对话数据', '此操作会取消当前回答并删除所选数据。', '清理', true)).confirmed) return;
  if (!alive || identity !== targetQuery.value) return;
  await post('/chat/clear', { ...target.value, range }); offset.value = 0; await refresh();
}
async function removeTurn(id: string) {
  const identity = targetQuery.value;
  if (!(await confirmAction('删除对话', '相关自动记忆也会删除，摘要将重新构建。', '删除', true)).confirmed) return;
  if (!alive || identity !== targetQuery.value) return;
  await del(`/chat/history/${encodeURIComponent(id)}${targetQuery.value}`); await refresh();
}
watch(targetQuery, () => { history.value = []; memories.value = []; summary.value = ''; total.value = 0; for (const id of Object.keys(memoryDrafts)) delete memoryDrafts[id]; offset.value = 0; void refresh().catch(e => { error.value = messageOf(e); }); });
watch(() => [state.chatStatus?.task_id, state.chatStatus?.phase, state.chatStatus?.memory_revision], () => { void refresh().catch(e => { error.value = messageOf(e); }); });
onMounted(() => { void action(async () => { Object.assign(config, await get<ChatConfig>('/chat/config')); triggers.value = config.trigger_words.join('、'); loaded.value = true; await refresh(); }); });
let alive = true;
onUnmounted(() => { alive = false; refreshVersion++; });
const safeAction = (run: () => Promise<void>) => { if (alive) void action(run); };
</script>

<template>
  <fieldset class="chat-settings" :disabled="busy || !loaded">
    <p v-if="error" role="alert" class="chat-error">{{ error }}</p>
    <SectionCard title="AI 对话" description="与音乐口令分析分别启用。默认说“请问……”开始，回答后可继续追问。">
      <div class="form-body">
      <SettingRow title="启用 AI 对话"><SlSwitch v-model="config.enabled" :disabled="!loaded || busy" aria-label="启用 AI 对话" /></SettingRow>
      <p v-if="!state.config.conversation_monitor_enabled">语音问答需要对话监听。<SlButton label="一并开启监听" variant="outlined" @click="safeAction(async () => { await saveConfig({ conversation_monitor_enabled: true }); })" /></p>
      <label class="chat-field">触发词（用顿号或逗号分隔）<SlInput v-model="triggers" aria-label="问答触发词" /></label>
      <SettingRow title="音乐口令未命中后交给 AI"><SlSwitch v-model="config.fallback_enabled" aria-label="兜底问答" /></SettingRow>
      <SettingRow title="每轮回答后恢复原音乐"><SlSwitch v-model="config.resume_music" aria-label="回答后恢复音乐" /></SettingRow>
      <label class="chat-field">追问窗口（秒，0 关闭）<SlInput :model-value="String(config.followup_seconds)" type="number" aria-label="追问窗口" @update:model-value="config.followup_seconds = Number($event)" /></label>
      <p>追问仍需唤醒音箱。分组播放时全组暂停，仅提问设备回答；播报结束无法确认时保持暂停。DLNA 投放中请先停止投放。</p>
      </div>
    </SectionCard>
    <SectionCard title="对话模型与角色" description="默认使用上方的模型连接。可单独选择对话模型，或改用独立连接。">
      <div class="form-body">
      <SlSelect :disabled="busy || !loaded" v-model="config.connection" :options="[{ value: 'analysis', label: '复用默认模型连接' }, { value: 'independent', label: '独立连接' }]" aria-label="对话模型连接" />
      <template v-if="config.connection === 'independent'">
        <label class="chat-field">API 地址<SlInput v-model="config.api_url" type="url" aria-label="问答 API 地址" /></label>
        <label class="chat-field">API 密钥<SlInput v-model="config.api_key" type="password" aria-label="问答 API 密钥" /></label>
      </template>
      <p v-if="config.connection === 'analysis'">默认模型：{{ state.config.ai_config.model || '尚未配置' }}。启用对话不需要开启口令分析。</p>
      <label class="chat-field">问答模型<SlInput v-model="config.model" aria-label="问答模型" placeholder="留空则使用默认模型" /></label>
      <SlButton v-if="config.connection === 'independent'" label="保存并获取模型" variant="outlined" :disabled="busy || !loaded" @click="safeAction(async () => { await save(); models = (await get<{ models: Array<{ id: string }> }>('/chat/models')).models; })" />
      <SlSelect :disabled="busy || !loaded" v-if="models.length" v-model="config.model" :options="models.map(m => ({ value: m.id, label: m.id }))" aria-label="可用问答模型" />
      <label class="chat-field">请求超时（1–30 秒）<SlInput :model-value="String(config.timeout)" type="number" aria-label="问答超时" @update:model-value="config.timeout = Number($event)" /></label>
      <label class="chat-field">角色提示词<textarea v-model="config.system_prompt" class="sl-input chat-textarea" aria-label="角色提示词" maxlength="4000"></textarea></label>
      <SlButton label="保存设置" :disabled="busy || !loaded" @click="safeAction(save)" />
      </div>
    </SectionCard>
    <SectionCard title="对话测试" description="使用当前选中的受管理音箱。关闭播报可测试模型而不暂停音乐。">
      <div class="form-body">
      <SlSelect :disabled="busy || !loaded" :model-value="deviceSelection" :options="deviceOptions" aria-label="对话设备" @update:model-value="safeAction(async () => { const [account, device] = JSON.parse($event); await selectDevice(account, device); })" />
      <p>当前状态：<strong>{{ phase }}</strong></p>
      <p v-if="state.chatStatus?.error" role="alert">{{ state.chatStatus.error }}</p>
      <label class="chat-field">问题<textarea v-model="question" class="sl-input chat-textarea" aria-label="对话问题" maxlength="2000"></textarea></label>
      <SettingRow title="在音箱上播报"><SlSwitch v-model="speak" aria-label="播报回答" /></SettingRow>
      <div class="chat-actions">
        <SlButton label="提问" :disabled="busy || !config.enabled || !question.trim() || !target.device_id" @click="safeAction(submit)" />
        <SlButton label="停止回答" variant="outlined" :disabled="busy || !active" @click="safeAction(async () => { await post('/chat/cancel', { ...target, close_session: true, resume_music: false }); await refresh(); })" />
        <SlButton label="退出并恢复音乐" variant="outlined" :disabled="busy || !active" @click="safeAction(async () => { await post('/chat/cancel', { ...target, close_session: true, resume_music: true }); await refresh(); })" />
        <SlButton label="重置会话" variant="outlined" :disabled="busy || !target.device_id" @click="safeAction(async () => { await post('/chat/reset', target); await refresh(); })" />
      </div>
      </div>
    </SectionCard>
    <SectionCard title="聊天历史" description="按账号和设备隔离，默认保存 30 天、最多 500 轮。取消和失败也会显示。">
      <div class="form-body">
      <p v-if="summary" class="chat-text">摘要：{{ summary }}</p>
      <p v-if="!history.length">暂无对话记录</p>
      <article v-for="turn in history" :key="turn.id" class="chat-turn">
        <small>{{ new Date(turn.created_at).toLocaleString() }} · {{ phases[turn.phase] }}</small>
        <p class="chat-text">你：{{ turn.user }}</p><p v-if="turn.assistant" class="chat-text">AI：{{ turn.assistant }}</p><p v-if="turn.error">{{ turn.error }}</p>
        <SlButton label="删除这轮对话" variant="text" :disabled="busy" @click="safeAction(() => removeTurn(turn.id))" />
      </article>
      <div class="chat-actions">
        <SlButton label="上一页" variant="outlined" :disabled="busy || offset === 0" @click="safeAction(async () => { offset = Math.max(0, offset - 20); await refresh(); })" />
        <SlButton label="下一页" variant="outlined" :disabled="busy || offset + history.length >= total" @click="safeAction(async () => { offset += 20; await refresh(); })" />
        <SlButton label="清空历史和摘要" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('history'))" />
      </div>
      </div>
    </SectionCard>
    <SectionCard title="长期记忆" description="从已完成对话自动提取明确的用户事实与偏好。可关闭提取，手工编辑不会被覆盖。">
      <div class="form-body">
      <SettingRow title="自动提取与使用记忆"><SlSwitch v-model="config.memory_enabled" aria-label="长期记忆" /></SettingRow>
      <p>修改开关后请保存设置。</p>
      <label class="chat-field">上下文轮数（1–24）<SlInput :model-value="String(config.context_turns)" type="number" aria-label="上下文轮数" @update:model-value="config.context_turns = Number($event)" /></label>
      <label class="chat-field">历史保留天数（1–30）<SlInput :model-value="String(config.history_days)" type="number" aria-label="历史保留天数" @update:model-value="config.history_days = Number($event)" /></label>
      <label class="chat-field">历史最大轮数（12–500）<SlInput :model-value="String(config.history_limit)" type="number" aria-label="历史最大轮数" @update:model-value="config.history_limit = Number($event)" /></label>
      <SlButton label="保存记忆设置" :disabled="busy || !loaded" @click="safeAction(save)" />
      <article v-for="memory in memories" :key="memory.id" class="chat-turn">
        <SlInput :model-value="memoryDrafts[memory.id] ?? memory.content" @update:model-value="memoryDrafts[memory.id] = $event" aria-label="记忆内容" />
        <small>{{ memory.manual ? '手工维护' : '自动提取' }} · 来源：{{ memory.source_ids.join('、') || '手工添加' }}</small>
        <div class="chat-actions">
          <SlButton label="保存记忆" variant="text" :disabled="busy" @click="safeAction(async () => { await put(`/chat/memories/${encodeURIComponent(memory.id)}`, { ...target, content: memoryDrafts[memory.id] ?? memory.content }); delete memoryDrafts[memory.id]; await refresh(); })" />
          <SlButton label="删除记忆" variant="text" :disabled="busy" @click="safeAction(async () => { await del(`/chat/memories/${encodeURIComponent(memory.id)}${targetQuery}`); await refresh(); })" />
        </div>
      </article>
      <label class="chat-field">新增记忆<SlInput v-model="newMemory" aria-label="新增记忆" /></label>
      <div class="chat-actions">
        <SlButton label="添加记忆" variant="outlined" :disabled="busy || !newMemory.trim() || !target.device_id" @click="safeAction(async () => { await post('/chat/memories', { ...target, content: newMemory }); newMemory = ''; await refresh(); })" />
        <SlButton label="清空长期记忆" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('memory'))" />
        <SlButton label="全部清空" variant="text" :disabled="busy || !target.device_id" @click="safeAction(() => clear('all'))" />
      </div>
      </div>
    </SectionCard>
  </fieldset>
</template>

<style scoped>
.chat-settings { display: grid; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; }
.chat-field { display: grid; gap: 8px; margin-block: 12px; }
.chat-textarea { min-height: 100px; resize: vertical; }
.chat-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 12px; }
.chat-turn { padding-block: 12px; border-bottom: 1px solid var(--md-outline-variant); }
.chat-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.chat-error { color: var(--md-error); }
</style>
