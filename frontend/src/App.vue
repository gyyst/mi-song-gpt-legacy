<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue';
import { get, pluginWebSocketUrl, query } from './api';
import type { ChatStatus } from '../../src/chat/types';
import MainPage from './views/MainPage.vue';
import SettingsPage from './views/SettingsPage.vue';
import FullscreenPlayer from './views/FullscreenPlayer.vue';
import Snackbar from './views/Snackbar.vue';
import ConfirmDialog from './views/ConfirmDialog.vue';
import { detectHostMode, installHostBack, navigation } from './runtime';
import { disposeStore, initialize, state } from './store';

let chatSocket: WebSocket | null = null;
let chatRetry: ReturnType<typeof setTimeout> | undefined;
let chatVersion = 0;
let chatOpenTimer: ReturnType<typeof setTimeout> | undefined;
function stopChatSocket() {
  chatVersion++; clearTimeout(chatRetry); clearTimeout(chatOpenTimer); chatRetry = undefined;
  if (chatSocket) { chatSocket.onclose = null; chatSocket.onerror = null; try { chatSocket.close(1000, 'device changed'); } catch { } chatSocket = null; }
}
function connectChatSocket() {
  stopChatSocket(); state.chatStatus = null;
  const account = state.currentAccountId, device = state.currentDeviceId;
  if (!account || !device) return;
  const version = chatVersion;
  const params = { account_id: account, device_id: device };
  let attempt = 0;
  const connect = () => {
    if (version !== chatVersion) return;
    const requestAttempt = ++attempt;
    let received = false, abandoned = false;
    void get<ChatStatus>(`/chat/status${query(params)}`).then(status => {
      if (version === chatVersion && requestAttempt === attempt && !received) state.chatStatus = status;
    }).catch(() => { });
    let socket: WebSocket;
    const isCurrent = () => version === chatVersion && chatSocket === socket && !abandoned;
    const retry = () => {
      if (!isCurrent()) return;
      abandoned = true; clearTimeout(chatOpenTimer);
      socket.onclose = null; socket.onerror = null;
      try { socket.close(1000, 'reconnect'); } catch { }
      chatRetry = setTimeout(connect, 3000);
    };
    try { socket = new WebSocket(pluginWebSocketUrl(`/chat/ws${query(params)}`)); }
    catch { chatRetry = setTimeout(connect, 3000); return; }
    chatSocket = socket;
    chatOpenTimer = setTimeout(retry, 10000);
    socket.onopen = () => { if (isCurrent()) clearTimeout(chatOpenTimer); };
    socket.onmessage = event => {
      if (!isCurrent()) return;
      try { const frame = JSON.parse(event.data); if (frame.type === 'chat_status') { received = true; state.chatStatus = frame.data; } } catch { }
    };
    socket.onclose = retry;
    socket.onerror = retry;

  };
  connect();
}
watch(() => [state.currentAccountId, state.currentDeviceId], connectChatSocket);

let disposeHostBack: (() => void) | undefined;
onMounted(() => {
  detectHostMode();
  disposeHostBack = installHostBack();
  void initialize();
});

watch(
  () => navigation.page,
  () => {
    navigation.playerPopup = '';
  },
);

onUnmounted(() => {
  stopChatSocket();
  disposeHostBack?.();
  disposeStore();
});
</script>

<template>
  <div class="miot-app">
    <div v-if="state.loading" class="app-state-page">
      <span class="loading-spinner" aria-hidden="true"></span>
      <p>正在加载</p>
    </div>
    <div v-else-if="state.startupError" class="app-state-page">
      <div class="state-icon"><span class="material-symbols-outlined">cloud_off</span></div>
      <h2>页面加载失败</h2>
      <p>{{ state.startupError }}</p>
      <button class="btn-filled" @click="initialize">重试</button>
    </div>
    <template v-else>
      <SettingsPage v-if="navigation.page === 'settings'" />
      <FullscreenPlayer v-if="navigation.page === 'player'" />
      <MainPage v-if="navigation.page !== 'settings' && navigation.page !== 'player'" />
    </template>
    <div v-if="state.chatStatus && ['queued', 'preparing', 'generating', 'speaking', 'resuming', 'unknown', 'failed'].includes(state.chatStatus.phase)" class="chat-activity" role="status">
      {{ ({ queued: 'AI 排队中', preparing: '暂停音乐', generating: 'AI 生成回答中', speaking: 'AI 播报中', resuming: '恢复音乐中', unknown: '播报结束未确认，请手动恢复音乐', failed: 'AI 对话失败' } as Record<string, string>)[state.chatStatus.phase] }}
      <span v-if="state.chatStatus.error"> · {{ state.chatStatus.error }}</span>
    </div>
    <Snackbar />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.chat-activity { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 100; max-width: 90vw; padding: 8px 16px; border-radius: 16px; background: var(--md-surface-container); color: var(--md-on-surface); font-size: 13px; box-shadow: 0 2px 8px #0002; pointer-events: none; }
</style>
