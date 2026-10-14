import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSdk } from './chat_loader.mjs';
import { load, qaConfigOf, turnOf, storageOf, ChatMemoryService } from './chat_fixture.mjs';
const { registerChatHandlers, chatBody } = load('../src/handlers/chat.ts');
const { createRouter } = loadSdk();

function routesOf(t, options = {}) {
  const { values } = storageOf(t);
  const memory = new ChatMemoryService();
  const config = {
    getAccounts: async () => [{ id: 'a' }, { id: 'b' }],
    getQAConfig: async () => qaConfigOf(options.qaConfig),
  };
  const router = createRouter();
  registerChatHandlers(router, config, memory);
  const request = async (method, path, body, search = 'account_id=a') => {
    const response = await router.handle({ method, path, query: search, body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
    return { code: response.statusCode, body: JSON.parse(response.body) };
  };
  return { values, memory, request };
}

test('chatBody parses JSON string and Uint8Array bodies, rejects invalid input', () => {
  assert.deepEqual(chatBody({ body: '{"a":1}' }), { a: 1 });
  const bytes = new TextEncoder().encode('{"b":2}');
  assert.deepEqual(chatBody({ body: bytes }), { b: 2 });
  assert.throws(() => chatBody({ body: '{broken' }), /无效/);
  assert.throws(() => chatBody({ body: '[1]' }), /对象/);
});

test('history requires a known account', async (t) => {
  const { request } = routesOf(t);
  assert.equal((await request('GET', '/chat/history', undefined, '')).code, 400);
  const unknown = await request('GET', '/chat/history', undefined, 'account_id=ghost');
  assert.equal(unknown.code, 400);
  assert.equal((await request('GET', '/chat/history')).code, 200);
});

test('memory CRUD is account-scoped and validates content', async (t) => {
  const { request } = routesOf(t);
  const bad = await request('POST', '/chat/memories', { content: '' });
  assert.equal(bad.code, 400);
  const created = await request('POST', '/chat/memories', { account_id: 'a', content: '喜欢摇滚' });
  assert.equal(created.code, 201);
  assert.equal(created.body.manual, true);
  const list = await request('GET', '/chat/memories');
  assert.equal(list.body.memories.length, 1);
  const edited = await request('PUT', `/chat/memories/${created.body.id}`, { account_id: 'a', content: '喜欢爵士' });
  assert.equal(edited.code, 200);
  assert.equal(edited.body.content, '喜欢爵士');
  const missing = await request('PUT', '/chat/memories/nope', { account_id: 'a', content: 'x' });
  assert.equal(missing.code, 400);
  assert.equal((await request('DELETE', `/chat/memories/${created.body.id}`)).code, 200);
  assert.equal((await request('GET', '/chat/memories')).body.memories.length, 0);
  const other = await request('GET', '/chat/memories', undefined, 'account_id=b');
  assert.equal(other.body.memories.length, 0, '账号 b 不受 a 的写入影响');
});

test('history delete removes the turn and clears summary', async (t) => {
  const { request, memory } = routesOf(t);
  await memory.saveTurn('a', turnOf('t1'), qaConfigOf());
  await memory.mutate('a', value => { value.summary = '摘要'; });
  const list = await request('GET', '/chat/history');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.summary, '摘要');
  assert.equal((await request('DELETE', '/chat/history/t1')).code, 200);
  const after = await request('GET', '/chat/history');
  assert.equal(after.body.total, 0);
  assert.equal(after.body.summary, '');
  assert.equal((await request('DELETE', '/chat/history/ghost')).code, 400);
});

test('clear and reset operate on the requesting account only', async (t) => {
  const { request, memory } = routesOf(t);
  await memory.saveTurn('a', turnOf('ta'), qaConfigOf());
  await memory.saveTurn('b', turnOf('tb'), qaConfigOf());
  await memory.editMemory('a', '事实一');
  assert.equal((await request('POST', '/chat/clear', { account_id: 'a', range: 'bogus' })).code, 400);
  assert.equal((await request('POST', '/chat/clear', { account_id: 'a', range: 'all' })).code, 200);
  assert.equal((await memory.load('a')).history.length, 0);
  assert.equal((await memory.load('a')).memories.length, 0);
  assert.equal((await memory.load('b')).history.length, 1, '账号 b 的历史保留');
  await memory.saveTurn('a', turnOf('ta2'), qaConfigOf());
  assert.equal((await request('POST', '/chat/reset', { account_id: 'a' })).code, 200);
  const value = await memory.load('a');
  assert.ok(value.context_since > 0, 'reset 推进上下文起点');
  assert.ok(value.history.length === 1, 'reset 保留历史记录本身');
});

test('history listing honors limit/offset and day retention', async (t) => {
  const { request, memory } = routesOf(t);
  for (let i = 0; i < 5; i++)
    await memory.saveTurn('a', turnOf(`t${i}`), qaConfigOf());
  await memory.mutate('a', value => { value.history[0].created_at = Date.now() - 40 * 86400000; });
  const page = await request('GET', '/chat/history', undefined, 'account_id=a&limit=2&offset=0');
  assert.equal(page.body.total, 4, '超过保留天数的轮次不计');
  assert.equal(page.body.history.length, 2);
  const next = await request('GET', '/chat/history', undefined, 'account_id=a&limit=2&offset=2');
  assert.equal(next.body.history.length, 2);
  assert.notEqual(page.body.history[0].id, next.body.history[0].id);
});