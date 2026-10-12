import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, deferred } from './chat_loader.mjs';
import { load, storageOf } from './chat_fixture.mjs';
const { AIClient } = load('../src/ai/client.ts');
const config = { enabled: true, api_url: 'https://api.example.test/v1', api_key: 'private-test-key', model: 'model', timeout: 1 };
const messages = text => [{ role: 'user', content: text }];
const answer = text => Response.json({ choices: [{ message: { content: text } }] });
for (const status of [401, 403, 429, 500]) {
  test(`chat HTTP ${status} rejects and releases its queue slot`, async (t) => {
    storageOf(t);
    let fail = true;
    t.mock.method(globalThis, 'fetch', async () => {
      if (fail) {
        fail = false;
        return new Response('', { status });
      }
      return answer('恢复');
    });
    const client = new AIClient();
    await assert.rejects(client.request(config, messages('问'), 'chat'), new RegExp(String(status)));
    assert.equal(await client.request(config, messages('重试'), 'chat'), '恢复');
  });
}
for (const [name, value] of [['null', null], ['missing choices', {}], ['empty choices', { choices: [] }], ['empty content', { choices: [{ message: { content: ' ' } }] }], ['reasoning only', { choices: [{ message: { reasoning_content: '不应播报的推理' } }] }], ['content array', { choices: [{ message: { content: ['x'] } }] }]]) {
  test(`chat rejects malformed completion: ${name}`, async (t) => {
    storageOf(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(new AIClient().request(config, messages('问'), 'chat'));
  });
}
test('chat returns content only, bounds stored text, and uses non-streaming connection/deadline', async (t) => {
  storageOf(t);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.example.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.model, 'model');
    assert.equal(body.max_tokens, 2048);
    assert.equal(options.headers['X-Fetch-Timeout-Ms'], '1000');
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    return Response.json({ choices: [{ message: { content: '答'.repeat(20000), reasoning_content: '不可播报' } }] });
  });
  const value = await new AIClient().request(config, messages('问'), 'chat');
  assert.equal(value.length, 16000);
  assert.ok(!value.includes('不可播报'));
});
test('timeout, bad JSON and network failures release slots without exposing credentials', async (t) => {
  const { logs } = storageOf(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mode = 'timeout';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'timeout')
      return new Promise(() => { });
    if (mode === 'json')
      return new Response('bad JSON');
    if (mode === 'network')
      throw new Error('failed private-test-key');
    return answer('成功');
  });
  const client = new AIClient(), pending = client.request(config, messages('问'), 'chat'), rejected = assert.rejects(pending, /timed out/);
  await flush();
  t.mock.timers.tick(1000);
  await rejected;
  await flush();
  for (const failure of ['json', 'network']) {
    mode = failure;
    await assert.rejects(client.request(config, messages('问'), 'chat'));
  }
  mode = 'success';
  assert.equal(await client.request(config, messages('问'), 'chat'), '成功');
  assert.ok(logs.every(([, line]) => !line.includes('private-test-key')));
});
test('two foreground slots and one per scope; background yields but cannot block new questions', async (t) => {
  storageOf(t);
  const client = new AIClient(), first = deferred(), second = deferred(), background = deferred(), starts = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const text = JSON.parse(init.body).messages[0].content;
    starts.push(text);
    if (text === 'bg-1')
      await background.promise;
    return answer(text);
  });
  const a = client.foregroundRequest(async () => { starts.push('fg-a'); await first.promise; return 'a'; }, () => true, 'a');
  const b = client.foregroundRequest(async () => { starts.push('fg-b'); await second.promise; return 'b'; }, () => true, 'b');
  const queued = client.foregroundRequest(async () => { starts.push('fg-a-next'); return 'next'; }, () => true, 'a');
  const bg1 = client.request(config, messages('bg-1'), 'summary'), bg2 = client.request(config, messages('bg-2'), 'memory');
  await flush();
  assert.deepEqual(starts, ['fg-a', 'fg-b']);
  first.resolve();
  await flush();
  assert.ok(starts.includes('fg-a-next'));
  assert.ok(!starts.includes('bg-1'));
  second.resolve();
  await flush();
  assert.ok(starts.includes('bg-1'));
  assert.ok(!starts.includes('bg-2'));
  const foreground = client.request(config, messages('new-question'), 'chat', () => true, 'c');
  await flush();
  assert.ok(starts.includes('new-question'));
  background.resolve();
  await Promise.all([a, b, queued, bg1, bg2, foreground]);
  assert.ok(starts.indexOf('bg-2') > starts.indexOf('new-question'));
});
for (const kind of ['chat', 'summary']) {
  test(`${kind} queue overflow is bounded and stale queued jobs send no HTTP`, async (t) => {
    storageOf(t);
    const client = new AIClient(), wait = deferred();
    let current = true;
    const sent = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => { const text = JSON.parse(init.body).messages[0].content; sent.push(text); return answer(text); });
    const blocker = client.foregroundRequest(() => wait.promise, () => true, 'busy');
    const jobs = Array.from({ length: 32 }, (_, i) => client.request(config, messages(String(i)), kind, () => current, 'busy').catch(error => error.message));
    await assert.rejects(client.request(config, messages('overflow'), kind, () => current, 'busy'), /队列已满/);
    current = false;
    wait.resolve('done');
    await blocker;
    const results = await Promise.all(jobs);
    assert.ok(results.every(result => /取消/.test(result)));
    assert.deepEqual(sent, []);
  });
}
test('cancellation after fetch invalidates the answer and missing connection never calls fetch', async (t) => {
  storageOf(t);
  const wait = deferred();
  let current = true, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return wait.promise; });
  const client = new AIClient(), pending = client.request(config, messages('问'), 'chat', () => current), rejected = assert.rejects(pending, /取消/);
  await flush();
  current = false;
  wait.resolve(answer('迟到答案'));
  await rejected;
  for (const key of ['api_url', 'api_key', 'model'])
    await assert.rejects(client.request({ ...config, [key]: '' }, messages('问'), 'chat'), /配置不完整/);
  assert.equal(calls, 1);
});
