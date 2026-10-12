import { loader } from './chat_loader.mjs';
export const load = loader();
export const { DEFAULT_CHAT_CONFIG, validateChatConfig, chatConnection, chatScope } = load('../src/chat/types.ts');
export const { AIChatService } = load('../src/chat/service.ts');
export const { PlaybackCoordinator } = load('../src/playback/coordinator.ts');
export const { ChatMemoryService } = load('../src/chat/memory.ts');
export const configOf = (updates = {}) => ({ ...DEFAULT_CHAT_CONFIG, enabled: true, memory_enabled: false, connection: 'independent', api_url: 'https://example.test/v1', api_key: 'test-only', model: 'model', ...updates });
export const turnOf = (id, updates = {}) => ({ id, user: `问题${id}`, assistant: `答案${id}`, phase: 'completed', created_at: Date.now(), ...updates });
export function storageOf(t) {
  const previous = globalThis.songloft, values = new Map(), logs = [];
  globalThis.songloft = { log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, text => logs.push([level, text])])), storage: { get: async (key) => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } } };
  t.after(() => { globalThis.songloft = previous; });
  return { values, logs };
}
export function chatOf(t, options = {}) {
  const storage = storageOf(t), calls = [], listeners = [];
  let config = configOf(options.config), revision = 1, state = options.state || 'playing', guard;
  const manager = {
    getPosition: () => 43, getInteractionPosition: () => 43, getPlaybackRevision: () => revision,
    isPlaying: () => state === 'playing', getStatus: () => ({ state }), isExternalPlayback: () => options.external || false,
    setInteractionGuard(callback) {
      guard = callback;
      return () => {
        if (guard === callback)
          guard = undefined;
      };
    },
    cancelHourlyResume() { calls.push('cancel-hourly'); }, reserveForVoiceInteraction() { revision++; calls.push('reserve'); },
    async replayCurrent(position, current) {
      calls.push(['resume', position]);
      if (!current())
        return false;
      revision++;
      state = 'playing';
      return options.resumeResult ?? true;
    },
    async holdAfterInteraction(position) { calls.push(['hold', position]); revision++; state = 'paused'; },
  };
  let control;
  const devices = {
    setOnControl(callback) { control = callback; },
    async stopForInteraction(account, device, current) { calls.push(['pause', device]); return current() ? (options.pauseResult?.[device] || 'stopped') : 'cancelled'; },
    async interruptAnswer(account, device, current) { calls.push(['interrupt', device]); return { status: current() ? options.interruptResult || 'accepted' : 'cancelled' }; },
    async textToSpeech(account, device, text, current) { calls.push(['tts', device, text]); return current(); },
    async getPlayState() { return { status: 0, sampledAt: Date.now() }; },
  };
  const configuration = { getChatConfig: async () => config, getAIConfig: async () => ({ enabled: false, api_url: 'https://analysis.test/v1', api_key: 'analysis-only', model: 'analysis' }), findDeviceGroup: async () => options.group ? { members: [{ account_id: 'a', device_id: 'd' }, { account_id: 'a', device_id: 'e' }] } : null };
  const playback = new PlaybackCoordinator({ get: () => options.noManager ? null : manager }, devices, configuration);
  const speech = options.speech || {
    async speak(text, token, current) { calls.push(['speak', token.device, text]); return current() ? options.speechResult || 'completed' : 'cancelled'; }, async stop(token) {
      calls.push(['stop-answer', token.device]);
      if (options.stopError)
        throw new Error('停止失败');
    }
  };
  const chat = new AIChatService(configuration, playback, speech);
  chat.client.request = options.request || (async (_config, _messages, kind) => kind === 'chat' ? '测试答案' : kind === 'summary' ? '测试摘要' : '[]');
  chat.subscribe((scope, status) => listeners.push({ scope, ...status }));
  t.after(() => chat.close());
  return { ...storage, chat, playback, manager, devices, config: configuration, calls, listeners, setConfig: updates => { config = configOf(updates); }, control: (device = 'd') => control('a', device), invalidate: () => guard?.(), state: () => state };
}
