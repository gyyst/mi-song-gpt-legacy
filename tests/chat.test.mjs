import assert from 'node:assert/strict';
import test from 'node:test';
import { flush } from './chat_loader.mjs';
import { load, qaConfigOf, turnOf, snapshotOf, storageOf, ChatMemoryService } from './chat_fixture.mjs';
const { ConfigManager } = load('../src/config/manager.ts');
const { accountScope, qaConnection } = load('../src/chat/memory.ts');
const originalSongloft = globalThis.songloft;
globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
test.after(() => { globalThis.songloft = originalSongloft; });
const cfg = qaConfigOf({ memory_enabled: false });
const turn = turnOf;

test('account scope maps to the account itself (shared across devices)', () => {
  assert.equal(accountScope('acc-1'), 'acc-1');
  assert.deepEqual(qaConnection(cfg), { enabled: true, api_url: cfg.api_url, api_key: cfg.api_key, model: cfg.model, timeout: 30 });
});

test('qa_config migration: legacy stored gains new fields, clamps timeout, drops history_max_length', async (t) => {
  const { values } = storageOf(t);
  values.set('qa_config', JSON.stringify({ enabled: true, api_url: 'https://old/v1', api_key: 'k', model: 'm', timeout: 180, history_max_length: 5, followup_seconds: 20 }));
  const value = await new ConfigManager().getQAConfig();
  assert.equal(value.timeout, 30, '宿主硬限 30s');
  assert.equal(value.followup_seconds, 20, '用户已有值不被覆盖');
  assert.equal(value.memory_enabled, true);
  assert.equal(value.context_turns, 12);
  assert.equal(value.history_limit, 500);
  assert.equal(value.history_days, 30);
  assert.equal('history_max_length' in value, false, '废弃字段不得回流');
});

test('qa_config migration: corrupt storage falls back to defaults and is preserved on disk', async (t) => {
  const { values } = storageOf(t);
  values.set('qa_config', '{broken');
  const value = await new ConfigManager().getQAConfig();
  assert.equal(value.enabled, false);
  assert.equal(value.timeout, 30);
  assert.equal(values.get('qa_config'), '{broken', '读取不回写，损坏数据保留');
});

test('qa_config merge clamps out-of-range numbers without touching stored value', async (t) => {
  const { values } = storageOf(t);
  values.set('qa_config', JSON.stringify({ followup_seconds: -5, context_turns: -5, history_limit: 5, history_days: 99, native_answer_wait_sec: 50 }));
  const value = await new ConfigManager().getQAConfig();
  assert.equal(value.followup_seconds, 0);
  assert.equal(value.context_turns, 1, '负值钳到下界');
  assert.equal(value.history_limit, 12);
  assert.equal(value.history_days, 30);
  assert.equal(value.native_answer_wait_sec, 10);
});

test('memory keeps account scopes separate and serializes concurrent mutations', async (t) => {
  storageOf(t);
  const memory = new ChatMemoryService();
  await Promise.all([memory.editMemory('a', '喜欢摇滚'), memory.editMemory('a', '住在上海'), memory.editMemory('b', '喜欢爵士')]);
  assert.equal((await memory.load('a')).memories.length, 2);
  assert.equal((await memory.load('b')).memories.length, 1);
});

test('clear, delete and manual edit reject stale background writes', async (t) => {
  storageOf(t);
  const memory = new ChatMemoryService();
  await memory.saveTurn('a', turn('t1'), cfg);
  const old = await memory.load('a');
  await memory.clear('a', 'all');
  assert.equal(await memory.mutate('a', value => value.memories.push({ content: '旧偏好' }), old.revision), null);
  assert.equal((await memory.load('a')).history.length, 0);
  await memory.saveTurn('a', turn('t2'), cfg);
  await memory.mutate('a', value => { value.summary = '旧摘要'; value.summary_sources = ['t2']; value.memories = [{ id: 'm1', content: '喜欢摇滚', source_ids: ['t2'], manual: false, created_at: 1, updated_at: 1 }, { id: 'm2', content: '喜欢爵士', source_ids: ['t2'], manual: true, created_at: 1, updated_at: 1 }]; });
  await memory.removeTurn('a', 't2');
  const value = await memory.load('a');
  assert.equal(value.summary, '');
  assert.deepEqual(value.memories.map(m => m.id), ['m2']);
  await memory.updateTurn('a', turn('t2'));
  assert.equal((await memory.load('a')).history.length, 0);
});

test('context excludes cancelled turns, honors reset, and retrieves relevant preferences', async (t) => {
  storageOf(t);
  const memory = new ChatMemoryService();
  await memory.saveTurn('a', turn('old'), cfg);
  await memory.saveTurn('a', turn('cancel', '不该进入上下文', 'cancelled'), cfg);
  await memory.editMemory('a', '我喜欢摇滚乐');
  let messages = memory.messages(await memory.load('a'), { ...cfg, memory_enabled: true }, '推荐摇滚');
  assert.ok(messages.some(m => m.content.includes('喜欢摇滚')));
  assert.ok(!messages.some(m => m.content.includes('不该进入上下文')));
  await memory.reset('a');
  messages = memory.messages(await memory.load('a'), cfg, '新问题');
  assert.deepEqual(messages.map(m => m.content), [cfg.system_prompt, '新问题']);
});

test('corrupt storage never gets overwritten', async (t) => {
  const { values } = storageOf(t);
  values.set('chat:v1:a', 'broken');
  await assert.rejects(new ChatMemoryService().clear('a', 'all'), /损坏/);
  assert.equal(values.get('chat:v1:a'), 'broken');
});

test('history retention and request character budget stay bounded', async (t) => {
  storageOf(t);
  const memory = new ChatMemoryService();
  for (let i = 0; i < 20; i++)
    await memory.saveTurn('a', { ...turn(String(i)), user: '问'.repeat(1000), assistant: '答'.repeat(1500) }, { ...cfg, history_limit: 12 });
  const value = await memory.load('a');
  assert.equal(value.history.length, 12);
  const messages = memory.messages(value, cfg, '现在');
  assert.ok(messages.slice(1, -1).reduce((sum, m) => sum + m.content.length, 0) <= 12000);
});

test('maintain summarizes and extracts facts once per turn', async (t) => {
  storageOf(t);
  const memoryCfg = qaConfigOf({ memory_enabled: true });
  const kinds = [];
  const memory = new ChatMemoryService(async (_conn, messages, kind) => {
    kinds.push(kind);
    if (kind === 'summary')
      return '摘要：用户在北京生活';
    if (messages.some(m => m.content.includes('话题标签')))
      return '测试话题';
    return '["用户住在北京"]';
  });
  for (let i = 0; i < 8; i++)
    await memory.saveTurn('a', turn(`t${i}`), memoryCfg);
  await memory.maintain('a', { api_url: 'https://x/v1', api_key: 'k', model: 'm', timeout: 30 }, memoryCfg);
  const value = await memory.load('a');
  assert.equal(value.summary, '摘要：用户在北京生活');
  assert.deepEqual(value.memories.map(m => m.content), ['用户住在北京', '用户经常询问：测试话题（近30天8次）']);
  assert.equal(value.extracted_sources.length, 8);
  kinds.length = 0;
  await memory.maintain('a', { api_url: 'https://x/v1', api_key: 'k', model: 'm', timeout: 30 }, memoryCfg);
  assert.deepEqual(kinds, [], '已摘要/已提取的轮次不重复请求');
});

test('maintain is a no-op without memoryRequest and after close', async (t) => {
  storageOf(t);
  const bare = new ChatMemoryService();
  await bare.saveTurn('a', turn('t1'), cfg);
  await bare.maintain('a', { api_url: 'x', api_key: 'y', model: 'z', timeout: 30 }, cfg);
  assert.equal((await bare.load('a')).summary, '');
  let called = 0;
  const memory = new ChatMemoryService(async () => { called++; return '[]'; });
  memory.close();
  await memory.saveTurn('a', turn('t1'), cfg);
  await memory.maintain('a', { api_url: 'x', api_key: 'y', model: 'z', timeout: 30 }, cfg, true);
  assert.equal(called, 0);
});

test('concurrent maintain collapses into a single pending rerun', async (t) => {
  storageOf(t);
  const { deferred } = await import('./chat_loader.mjs');
  const gate = deferred();
  let summaries = 0;
  const memory = new ChatMemoryService(async (_conn, _messages, kind) => {
    if (kind === 'summary') {
      summaries++;
      await gate.promise;
      return '摘要' + summaries;
    }
    return '[]';
  });
  await memory.saveTurn('a', turn('t1'), cfg);
  const connection = { api_url: 'x', api_key: 'y', model: 'z', timeout: 30 };
  const first = memory.maintain('a', connection, cfg, true);
  const second = memory.maintain('a', connection, cfg, true);
  await flush();
  gate.resolve();
  await Promise.all([first, second]);
  await flush();
  assert.ok(summaries <= 2, `summarize requests bounded, got ${summaries}`);
});