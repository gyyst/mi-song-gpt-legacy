import assert from 'node:assert/strict';
import test from 'node:test';
import { loader, loadSdk } from './chat_loader.mjs';

function fixture(t, fetchHost) {
  const requests = [], warnings = [];
  const previous = { fetch: globalThis.fetch, songloft: globalThis.songloft };
  globalThis.songloft = {
    plugin: { getToken: async () => 'fixture-token', getHostUrl: async () => 'http://127.0.0.1:58091' },
    log: { warn: message => warnings.push(message) },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return fetchHost(url, options);
  };
  t.after(() => Object.assign(globalThis, previous));
  const load = loader();
  const { createRouter } = loadSdk();
  const router = createRouter();
  load('../src/handlers/lyric.ts').registerLyricHandlers(router);
  return {
    requests, warnings,
    async get(query) {
      const result = await router.handle({ method: 'GET', path: '/lyric', query });
      return { status: result.statusCode, body: JSON.parse(result.body) };
    },
  };
}

test('slow provider result survives the proxy budget and preserves all lyric fields', async t => {
  const payload = { lyric: '[00:01]搜索命中', tlyric: 'translation', rlyric: 'romanized', lxlyric: 'enhanced' };
  const h = fixture(t, async (_url, { headers }) => {
    assert.equal(headers.Authorization, 'Bearer fixture-token');
    // A valid provider may take up to 15 seconds. Model the fetch deadline.
    if (Number(headers['X-Fetch-Timeout-Ms']) < 15000) throw new Error('context deadline exceeded');
    return new Response(JSON.stringify(payload));
  });
  const result = await h.get('song_id=123');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, payload);
  assert.equal(h.requests[0].url, 'http://127.0.0.1:58091/api/v1/songs/123/lyric');
});

test('manual retry forwards refresh to the unified host lyric endpoint', async t => {
  const h = fixture(t, async () => new Response('{"lyric":"[00:01]fresh"}'));
  await h.get('song_id=123&refresh=1');
  assert.equal(h.requests[0].url, 'http://127.0.0.1:58091/api/v1/songs/123/lyric?refresh=1');
});

test('host 404 remains a successful empty result without a warning', async t => {
  const h = fixture(t, async () => new Response('not found', { status: 404 }));
  assert.deepEqual(await h.get('song_id=123'), {
    status: 200, body: { success: true, data: { lyric: '', tlyric: '', rlyric: '', lxlyric: '' } },
  });
  assert.deepEqual(h.warnings, []);
});

for (const failure of ['timeout', 'upstream']) {
  test(`${failure} is reported as a retryable error, rather than no lyrics`, async t => {
    const h = fixture(t, async () => {
      if (failure === 'timeout') throw new Error('context deadline exceeded');
      return new Response('upstream failed', { status: 502 });
    });
    const result = await h.get('song_id=123');
    assert.equal(result.status, 502);
    assert.equal(result.body.success, false);
    assert.ok(result.body.error);
    assert.equal(h.warnings.length, 1);
  });
}
