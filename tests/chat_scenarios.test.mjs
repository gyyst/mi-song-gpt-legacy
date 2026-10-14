import assert from 'node:assert/strict';
import test from 'node:test';
import { flush, deferred } from './chat_loader.mjs';
import { dispatcherOf } from './chat_fixture.mjs';
const originalSongloft = globalThis.songloft;
globalThis.songloft = { log: { info() { }, warn() { }, error() { } } };
test.after(() => { globalThis.songloft = originalSongloft; });

const controls = ['set_play_mode', 'favorite', 'next', 'previous', 'resume', 'stop', 'sleep_timer', 'cancel_sleep_timer', 'query_sleep_timer', 'play_index'];

for (const type of controls) {
  test(`fixed ${type} routes to music without resume`, async (t) => {
    const h = dispatcherOf(t, { fixed: type });
    h.send('播放下一首');
    await flush();
    assert.deepEqual(h.calls, [['music', '播放下一首']]);
  });
}

test('music handled=true does not resume unmatched', async (t) => {
  const h = dispatcherOf(t, { handled: true });
  h.send('播放周杰伦的歌');
  await flush();
  assert.deepEqual(h.calls, [['music', '播放周杰伦的歌']]);
});

test('music handled=false falls back to resumeUnmatched', async (t) => {
  const h = dispatcherOf(t, { handled: false });
  h.send('一个找不到的问题');
  await flush();
  assert.deepEqual(h.calls, [['music', '一个找不到的问题'], ['resume', 'a', 'd']]);
});

test('duplicate request id is dispatched only once', async (t) => {
  const h = dispatcherOf(t, { handled: true });
  h.send('播放周杰伦的歌', 'd', 'same-id');
  h.send('播放周杰伦的歌', 'd', 'same-id');
  await flush();
  assert.deepEqual(h.calls, [['music', '播放周杰伦的歌']]);
});

test('newer message invalidates older in-flight analysis', async (t) => {
  const wait = deferred(), calls = [];
  const music = {
    cancelPendingResume() { }, fixedControlType: async () => undefined, hasFixedControl: async () => false,
    handleMessage: async (message, options) => {
      const text = message.message.response.answer[0].question;
      if (text === '旧问题')
        await wait.promise;
      if (options.current())
        calls.push(text);
      return true;
    },
    resumeUnmatched() { },
  };
  const { VoiceDispatcher } = await import('./chat_fixture.mjs');
  const dispatcher = new VoiceDispatcher(music, { get: () => null });
  t.after(() => dispatcher.close());
  const message = (id, text) => ({ account_id: 'a', device_id: 'd', message: { request_id: id, timestamp_ms: 1, response: { answer: [{ question: text }] } } });
  dispatcher.submit(message('old', '旧问题'));
  await flush();
  dispatcher.submit(message('new', '新问题'));
  await flush();
  wait.resolve();
  await flush();
  assert.deepEqual(calls, ['新问题']);
});

test('invalidateDevice cancels pending resume and invalidates in-flight analysis', async (t) => {
  const h = dispatcherOf(t, { handled: true });
  h.dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'x', timestamp_ms: 1, response: { answer: [{ question: '慢问题' }] } } });
  await flush();
  h.pending.length = 0;
  h.dispatcher.invalidateDevice('a', 'd');
  assert.deepEqual(h.pending, [['cancel-pending', 'a', 'd']]);
});

test('group members share one playback scope for invalidation', async (t) => {
  const manager = { id: 'shared' };
  const managers = new Map([['a:d', manager], ['a:e', manager]]);
  const h = dispatcherOf(t, { handled: true, managers });
  h.dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'g', timestamp_ms: 1, response: { answer: [{ question: '慢问题' }] } } });
  await flush();
  h.pending.length = 0;
  h.dispatcher.invalidateDevice('a', 'e');
  assert.deepEqual(h.pending, [['cancel-pending', 'a', 'e']], '同分组成员操作应作废该域');
});

test('different groups are separate scopes', async (t) => {
  const managers = new Map([['a:d', { id: 'one' }], ['a:e', { id: 'two' }]]);
  const h = dispatcherOf(t, { handled: true, managers });
  h.dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'g2', timestamp_ms: 1, response: { answer: [{ question: '问题' }] } } });
  await flush();
  h.pending.length = 0;
  h.dispatcher.invalidateDevice('a', 'e');
  assert.deepEqual(h.pending, [['cancel-pending', 'a', 'e']], '不同分组不互相作废（仅当前设备自身被取消）');
});

test('empty question text is ignored', async (t) => {
  const h = dispatcherOf(t);
  h.dispatcher.submit({ account_id: 'a', device_id: 'd', message: { request_id: 'e', timestamp_ms: 1, response: { answer: [{ question: '   ' }] } } });
  await flush();
  assert.deepEqual(h.calls, []);
});

test('close stops further dispatch', async (t) => {
  const h = dispatcherOf(t, { handled: true });
  h.dispatcher.close();
  h.send('播放音乐');
  await flush();
  assert.deepEqual(h.calls.filter(c => c[0] === 'music'), []);
});

test('music throw does not escape dispatch', async (t) => {
  const h = dispatcherOf(t, { throwing: true });
  h.send('播放音乐');
  await flush();
  assert.deepEqual(h.calls.filter(c => Array.isArray(c) && c[0] === 'resume'), [], '异常时不 resume，交给上层错误处理');
});