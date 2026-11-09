import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, loadSdk } from './chat_loader.mjs';
import { storageOf } from './chat_fixture.mjs';

const load = loader();
const { AIClient } = load('../src/ai/client.ts');
const { ConfigManager } = load('../src/config/manager.ts');
const { validateAIHeaders, parseAIHeaders } = load('../src/utils/ai_headers.ts');
const { registerConfigHandlers } = load('../src/handlers/config.ts');
const { registerVoiceCommandHandlers } = load('../src/handlers/voice_command.ts');
const { createRouter } = loadSdk();
const config = { enabled: true, api_url: 'https://gateway.test/v1', api_key: 'test-only', model: 'test', timeout: 6 };
const custom_headers = { 'x-opencode-session': '11111111-2222-4333-8444-555555555555', 'x-api-key': 'private-header-key' };
const answer = { choices: [{ message: { content: '回答' } }] };
function routes() {
  const manager = new ConfigManager(), router = createRouter();
  registerConfigHandlers(router, manager, {}, {}, {}, {});
  registerVoiceCommandHandlers(router, manager, {}, {});
  return {
    manager, request: async (method, path, body) => {
      const result = await router.handle({ method, path, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: result.statusCode, body: JSON.parse(result.body) };
    }
  };
}
test('default headers persist and clear through the shared AI config', async t => {
  storageOf(t);
  const h = routes();
  assert.equal((await h.request('POST', '/config', { ai_config: { ...config, custom_headers } })).body.success, true);
  assert.deepEqual((await new ConfigManager().getAIConfig()).custom_headers, custom_headers);
  await h.request('POST', '/config', { ai_config: { custom_headers: {} } });
  assert.deepEqual((await new ConfigManager().getAIConfig()).custom_headers, {});
});
for (const custom_headers of [null, [], 'bad', { bad: 1 }, { 'bad name': 'x' }, { 'x-key': 'private\r\nInjected: value' }, { 'x-key': 'bad\0value' }, { 'x-key': 'a', 'X-Key': 'b' }, ...['authorization', 'CONTENT-TYPE', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'x-fetch-timeout-ms'].map(key => ({ [key]: 'override' }))]) {
  test(`invalid headers rejected without replacing persisted config: ${JSON.stringify(custom_headers)}`, async t => {
    storageOf(t);
    const h = routes();
    await h.request('POST', '/config', { ai_config: { ...config, custom_headers: { 'x-good': 'keep' } } });
    assert.equal((await h.request('POST', '/config', { ai_config: { custom_headers } })).body.success, false);
    assert.deepEqual((await h.manager.getAIConfig()).custom_headers, { 'x-good': 'keep' });
  });
}
for (const kind of ['chat', 'summary', 'memory']) {
  test(`${kind} sends configured headers in the ordinary HTTP transport`, async t => {
    storageOf(t);
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      for (const [key, value] of Object.entries(custom_headers)) assert.equal(init.headers[key], value);
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      assert.equal(init.headers['Content-Type'], 'application/json');
      return Response.json(answer);
    });
    assert.equal(await new AIClient().request({ ...config, custom_headers }, [{ role: 'user', content: '问' }], kind), '回答');
  });
}
test('streaming chat sends the same configured headers', async t => {
  storageOf(t);
  songloft.net = {
    httpStream: (_url, init) => {
      assert.equal(init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
      assert.equal(init.headers['x-api-key'], custom_headers['x-api-key']);
      assert.equal(init.headers.Authorization, 'Bearer test-only');
      let read = false;
      return { response: Promise.resolve({ status: 200, headers: { 'Content-Type': ['application/json'] } }), read: async () => read ? null : (read = true, new TextEncoder().encode(JSON.stringify(answer))), cancel: async () => { } };
    }
  };
  assert.equal(await new AIClient().request({ ...config, custom_headers }, [{ role: 'user', content: '问' }], 'chat'), '回答');
});
test('model list and command analysis use their configured connection headers', async t => {
  storageOf(t);
  const h = routes(), requests = [];
  await h.manager.saveAIConfig({ ...config, custom_headers });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init });
    return Response.json(init.method === 'GET' ? { data: [{ id: 'test' }] } : { choices: [{ message: { content: '{"action":"resume","params":{},"confidence":"high"}' } }] });
  });
  assert.equal((await h.request('GET', '/voice-commands/models')).body.success, true);
  assert.equal((await h.request('POST', '/voice-commands/ai-test', { query: '继续' })).body.success, true);
  assert.equal(requests[0].init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
  assert.equal(requests[1].init.headers['x-opencode-session'], custom_headers['x-opencode-session']);
});
test('custom header credentials are redacted from upstream errors and logs', async t => {
  const { logs } = storageOf(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('rejected private-header-key'); });
  await assert.rejects(new AIClient().request({ ...config, custom_headers }, [], 'chat'), error => !error.message.includes('private-header-key'));
  assert.ok(!JSON.stringify(logs).includes('private-header-key'));
});
test('old configurations without headers remain valid', async t => {
  storageOf(t);
  assert.deepEqual(parseAIHeaders(''), {});
  assert.deepEqual(validateAIHeaders(undefined ?? {}), {});
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.headers['x-opencode-session'], undefined);
    return Response.json(answer);
  });
  assert.equal(await new AIClient().request(config, [], 'chat'), '回答');
});
