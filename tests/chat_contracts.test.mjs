import assert from 'node:assert/strict';
import test from 'node:test';
import { flush } from './chat_loader.mjs';
import { load, configOf, turnOf, chatOf, storageOf, validateChatConfig, chatConnection, chatScope, ChatMemoryService } from './chat_fixture.mjs';
const { registerChatHandlers, chatBody } = load('../src/handlers/chat.ts');
const { handleChatWebSocket } = load('../src/ws/chat-stream.ts');
const { createRouter } = load('../../../toolchain/packages/plugin-sdk/src/index.ts');
const target = { account_id: 'a', device_id: 'd' }, scope = chatScope('a', 'd');
function routesOf(t, options = {}) {
  const h = chatOf(t, options), router = createRouter();
  h.config.getAccounts = async () => [{ id: 'a' }, { id: 'b' }];
  h.config.getDevices = async () => [{ device_id: 'd', managed: true }, { device_id: 'e', managed: false }];
  h.config.saveChatConfig = async (updates) => { const value = validateChatConfig(updates, await h.config.getChatConfig()); h.setConfig(value); return value; };
  registerChatHandlers(router, h.config, h.chat);
  const request = async (method, path, body, query = new URLSearchParams(target).toString()) => {
    const response = await router.handle({ method, path, query, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
    return { code: response.statusCode, body: JSON.parse(response.body) };
  };
  return { ...h, request };
}
for (const [field, min, max] of [['timeout', 1, 30], ['followup_seconds', 0, 300], ['context_turns', 1, 24], ['history_limit', 12, 500], ['history_days', 1, 30]]) {
  test(`config ${field}: accepts bounds and rejects wrong types/fraction/out-of-range`, () => {
    for (const value of [min, max])
      assert.equal(validateChatConfig({ [field]: value })[field], value);
    for (const value of [min - 1, max + 1, '2', null, 1.5, Infinity, NaN])
      assert.throws(() => validateChatConfig({ [field]: value }));
  });
}
for (const field of ['enabled', 'fallback_enabled', 'resume_music', 'memory_enabled']) {
  test(`config ${field}: only accepts booleans`, () => {
    for (const value of [false, true])
      assert.equal(validateChatConfig({ [field]: value })[field], value);
    for (const value of [0, 1, 'false', null])
      assert.throws(() => validateChatConfig({ [field]: value }));
  });
}
test('config validates all string/trigger fields and never mutates default arrays', () => {
  for (const field of ['api_url', 'api_key', 'model', 'system_prompt']) {
    for (const value of [123, [], null, 'x'.repeat(field === 'system_prompt' ? 4001 : 2001)])
      assert.throws(() => validateChatConfig({ [field]: value }));
  }
  for (const triggers of [[], [' '], ['x'.repeat(31)], Array(21).fill('x'), [1], '问'])
    assert.throws(() => validateChatConfig({ trigger_words: triggers }));
  for (const value of [null, [], 'config'])
    assert.throws(() => validateChatConfig(value));
  assert.deepEqual(validateChatConfig({ trigger_words: [' 问 ', '问'] }).trigger_words, ['问']);
  const base = configOf({ trigger_words: ['问'] }), next = validateChatConfig({ model: ' new ' }, base);
  next.trigger_words.push('别的');
  assert.deepEqual(base.trigger_words, ['问']);
  assert.equal(next.model, 'new');
  assert.equal(chatConnection(configOf(), { model: 'wrong' }).model, 'model');
});
for (const raw of ['null', '[]', '1', '"string"', '{bad', new Uint8Array([255])]) {
  test(`request body rejects invalid JSON objects: ${String(raw)}`, () => assert.throws(() => chatBody({ body: raw })));
}
test('request body decodes UTF-8 text and accepts missing body', () => {
  assert.deepEqual(chatBody({ body: new TextEncoder().encode('{"text":"请问天气😀"}') }), { text: '请问天气😀' });
  assert.deepEqual(chatBody({}), {});
});
for (const body of [{}, { account_id: 1, device_id: 'd' }, { account_id: 'missing', device_id: 'd' }, { account_id: 'a', device_id: 'missing' }, { account_id: 'a', device_id: 'e' }]) {
  test(`HTTP rejects missing/unmanaged target ${JSON.stringify(body)}`, async (t) => {
    const h = routesOf(t), response = await h.request('POST', '/chat/messages', { ...body, text: '问题', speak: false });
    assert.equal(response.code, 400);
    assert.equal(response.body.error, 'chat_request_failed');
    assert.equal(h.chat.busyReason(), '');
  });
}
for (const [path, body] of [
  ['/chat/messages', { text: '', speak: false }], ['/chat/messages', { text: 'x'.repeat(2001) }], ['/chat/messages', { text: 1 }], ['/chat/messages', { text: '问', speak: 'false' }],
  ['/chat/cancel', { close_session: 0 }], ['/chat/cancel', { resume_music: 'true' }], ['/chat/clear', { range: 'bad' }], ['/chat/memories', { content: 42 }], ['/chat/memories', { content: ' ' }], ['/chat/memories', { content: 'x'.repeat(301) }],
]) {
  test(`HTTP validates ${path} ${Object.keys(body).join(',')}`, async (t) => {
    const h = routesOf(t), response = await h.request('POST', path, { ...target, ...body });
    assert.equal(response.code, 400);
    assert.equal(typeof response.body.detail, 'string');
  });
}
test('HTTP chat defaults, partial config save, disabled chat and byte-array submit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = routesOf(t, { config: { enabled: false } });
  assert.equal((await h.request('GET', '/chat/config')).body.enabled, false);
  assert.equal((await h.request('POST', '/chat/messages', { ...target, text: '问', speak: false })).code, 400);
  const saved = await h.request('PUT', '/chat/config', { enabled: true, followup_seconds: 0 });
  assert.equal(saved.code, 200);
  assert.equal(saved.body.model, 'model');
  const submitted = await h.request('POST', '/chat/messages', new TextEncoder().encode(JSON.stringify({ ...target, text: '问题', speak: false })));
  assert.equal(submitted.code, 202);
  assert.equal(submitted.body.phase, 'queued');
  t.mock.timers.tick(0);
  await flush();
  const status = await h.request('GET', '/chat/status');
  assert.equal(status.body.task_id, submitted.body.task_id);
  assert.equal(status.body.phase, 'completed');
  assert.ok(!h.calls.some(c => Array.isArray(c) && ['pause', 'speak', 'resume'].includes(c[0])));
});
test('HTTP history pagination/order, retention, independent account scope, delete and reset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = routesOf(t);
  for (let i = 0; i < 5; i++)
    await h.chat.memory.saveTurn(scope, turnOf(String(i)), configOf());
  await h.chat.memory.editMemory(scope, '手工偏好');
  const query = new URLSearchParams({ ...target, limit: '2', offset: '1' }).toString();
  assert.deepEqual((await h.request('GET', '/chat/history', undefined, query)).body.history.map(t => t.id), ['3', '2']);
  assert.equal((await h.request('GET', '/chat/history', undefined, 'account_id=b&device_id=d')).body.total, 0);
  assert.equal((await h.request('DELETE', '/chat/history/missing')).code, 400);
  assert.equal((await h.request('DELETE', '/chat/history/4')).code, 200);
  await flush();
  assert.equal((await h.request('GET', '/chat/history')).body.total, 4);
  assert.equal((await h.request('POST', '/chat/reset', target)).code, 200);
  const value = await h.chat.memory.load(scope);
  assert.equal(value.summary, '');
  assert.equal(value.history.length, 4);
  assert.equal(value.memories.length, 1);
});
test('HTTP memory CRUD and each clear range preserve the intended data', async (t) => {
  const h = routesOf(t);
  let response = await h.request('POST', '/chat/memories', { ...target, content: ' 偏好 ' });
  assert.equal(response.code, 201);
  const id = response.body.id;
  assert.equal((await h.request('PUT', `/chat/memories/${id}`, { ...target, content: '新的偏好' })).body.manual, true);
  assert.equal((await h.request('PUT', `/chat/memories/${id}`, { ...target, content: 2 })).code, 400);
  assert.equal((await h.request('GET', '/chat/memories')).body.memories[0].content, '新的偏好');
  assert.equal((await h.request('DELETE', `/chat/memories/${id}`)).code, 200);
  assert.equal((await h.request('DELETE', `/chat/memories/${id}`)).code, 400);
  for (const range of ['history', 'memory', 'all']) {
    await h.chat.memory.saveTurn(scope, turnOf('turn'), configOf());
    await h.chat.memory.editMemory(scope, '偏好');
    const cleared = await h.request('POST', '/chat/clear', { ...target, range });
    assert.equal(cleared.code, 200);
    const value = await h.chat.memory.load(scope);
    assert.equal(value.history.length, range === 'memory' ? 1 : 0);
    assert.equal(value.memories.length, range === 'history' ? 1 : 0);
    await h.chat.memory.clear(scope, 'all');
  }
});
for (const result of ['valid', '401', '500', 'malformed', 'bad-json']) {
  test(`HTTP model list ${result}`, async (t) => {
    const h = routesOf(t);
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      if (result === '401' || result === '500')
        return new Response('', { status: Number(result) });
      if (result === 'bad-json')
        return new Response('bad');
      return Response.json(result === 'malformed' ? { data: {} } : { data: [{ id: 'm' }, null, { id: 7 }] });
    });
    const response = await h.request('GET', '/chat/models');
    assert.equal(response.code, result === 'valid' ? 200 : 400);
    if (result === 'valid')
      assert.deepEqual(response.body.models, [{ id: 'm' }]);
  });
}
test('memory migrates old checkpoints, prunes TTL, preserves snapshots and limits preferences', async (t) => {
  const { values } = storageOf(t), memory = new ChatMemoryService();
  const old = { version: 1, revision: 0, context_since: 0, summary: '', summary_sources: [], history: [turnOf('expired', { created_at: Date.now() - 31 * 86400000 })], memories: [{ id: 'm', content: '旧偏好', source_ids: ['old'], manual: false, created_at: 1, updated_at: 1 }] };
  values.set('chat:v1:s', JSON.stringify(old));
  assert.deepEqual((await memory.load('s')).extracted_sources, ['old']);
  await memory.saveTurn('s', turnOf('new'), configOf());
  const copy = await memory.load('s');
  copy.history.length = 0;
  assert.equal((await memory.load('s')).history.length, 1);
  for (let i = 0; i < 99; i++)
    await memory.editMemory('s', `偏好${i}`);
  await assert.rejects(memory.editMemory('s', '溢出'), /100/);
  await memory.editMemory('s', '编辑仍可保存', 'm');
  assert.equal((await memory.load('s')).memories.length, 100);
});
function socketOf() {
  const frames = [], closes = [], events = {};
  return { OPEN: 1, readyState: 1, frames, closes, events, async send(frame) { frames.push(JSON.parse(frame)); }, async close(...args) { closes.push(args); }, onClose(fn) { events.close = fn; }, onError(fn) { events.error = fn; } };
}
test('WebSocket sends initial snapshot, isolates accounts/devices and unsubscribes on close/error', async (t) => {
  const h = routesOf(t), socket = socketOf();
  await handleChatWebSocket({ query: 'account_id=a&device_id=d' }, socket, h.config, h.chat);
  assert.equal(socket.frames.length, 1);
  assert.equal(socket.frames[0].type, 'chat_status');
  for (const listener of h.chat.listeners) {
    listener(chatScope('b', 'd'), { phase: 'speaking' });
    listener(scope, { phase: 'generating' });
  }
  assert.equal(socket.frames.length, 2);
  socket.readyState = 3;
  for (const listener of h.chat.listeners)
    listener(scope, { phase: 'completed' });
  assert.equal(socket.frames.length, 2);
  socket.events.close();
  assert.equal(h.chat.listeners.size, 1); // the fixture's observer remains
  const other = socketOf();
  await handleChatWebSocket({ query: 'account_id=a&device_id=d' }, other, h.config, h.chat);
  other.events.error();
  assert.equal(h.chat.listeners.size, 1);
});
for (const failure of ['target', 'initial-send', 'update-send']) {
  test(`WebSocket cleans subscriptions after ${failure}`, async (t) => {
    const h = routesOf(t), socket = socketOf();
    if (failure === 'initial-send')
      socket.send = async () => { throw new Error('closed'); };
    await handleChatWebSocket({ query: failure === 'target' ? 'account_id=missing&device_id=d' : 'account_id=a&device_id=d' }, socket, h.config, h.chat);
    if (failure === 'update-send') {
      socket.send = async () => { throw new Error('closed'); };
      for (const listener of h.chat.listeners)
        listener(scope, { phase: 'speaking' });
      await flush();
    }
    else
      assert.equal(socket.closes[0][0], 1008);
    assert.equal(h.chat.listeners.size, 1);
  });
}
