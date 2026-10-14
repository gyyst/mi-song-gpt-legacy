import assert from 'node:assert/strict';
import { loader } from './chat_loader.mjs';
export const load = loader();
export const { accountScope, qaConnection, ChatMemoryService } = load('../src/chat/memory.ts');
export const { VoiceDispatcher } = load('../src/voicecmd/dispatcher.ts');

/** 完整 QAConfig（与 src/config/manager.ts 的 defaultQAConfig 对齐） */
export const qaConfigOf = (updates = {}) => ({
  enabled: true, api_url: 'https://example.test/v1', api_key: 'test-only', model: 'model', timeout: 30,
  system_prompt: '你是音箱助手', thinking_notice: '', native_answer_wait_sec: 0, web_search_enabled: false,
  web_search_strategy: 'hybrid', web_search_fallback_notice: '', max_reply_length: 0, followup_seconds: 60,
  memory_enabled: false, context_turns: 12, history_limit: 500, history_days: 30, ...updates,
});
export const turnOf = (id, updates = {}) => ({ id, user: `问题${id}`, assistant: `答案${id}`, phase: 'completed', created_at: Date.now(), ...updates });
export const snapshotOf = (updates = {}) => ({ version: 1, revision: 0, context_since: 0, history: [], summary: '', summary_sources: [], extracted_sources: [], memories: [], ...updates });

export function storageOf(t) {
  const previous = globalThis.songloft, values = new Map(), logs = [];
  globalThis.songloft = { log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, text => logs.push([level, text])])), storage: { get: async (key) => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } } };
  t.after(() => { globalThis.songloft = previous; });
  return { values, logs };
}

/** 新版派发器（music + players 两参）；music.handleMessage 返回 handled 决定是否 resumeUnmatched */
export function dispatcherOf(t, { fixed, handled = false, throwing = false, managers = new Map() } = {}) {
  const calls = [];
  const pending = [];
  const music = {
    cancelPendingResume(account, device) { pending.push(['cancel-pending', account, device]); },
    fixedControlType: async () => fixed,
    hasFixedControl: async () => false,
    handleMessage: async (message, options) => {
      calls.push(['music', message.message.response.answer[0].question]);
      assert.ok(options.deferResume, 'dispatch 必须 deferResume');
      if (throwing)
        throw new Error('music failed');
      return handled;
    },
    resumeUnmatched: (account, device) => calls.push(['resume', account, device]),
  };
  const players = { get: (a, d) => managers.get(`${a}:${d}`) || null };
  const dispatcher = new VoiceDispatcher(music, players);
  t.after(() => dispatcher.close());
  return { dispatcher, calls, pending, music, send(text, device = 'd', id = text) { dispatcher.submit({ account_id: 'a', device_id: device, message: { request_id: id, timestamp_ms: 1, response: { answer: [{ question: text }] } } }); } };
}