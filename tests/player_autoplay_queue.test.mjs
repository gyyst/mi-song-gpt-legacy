import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');

function loadSource(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exports = {};
  new Function('require', 'exports', outputText)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

const http = {
  getHostBaseUrl: () => 'http://speaker.test',
  callHostAPI: async () => ({}),
};
const urls = loadSource('../src/player/url_builder.ts', { '../utils/http': http });
const players = loadSource('../src/player/manager.ts', {
  '../config/manager': { playlistProgressScope: () => 'account:speaker' },
  './url_builder': urls,
  '../utils/http': http,
  '../utils/debug': { isDebugLog: () => false },
  '../playback/device_state': loadSource('../src/playback/device_state.ts', {}),
});
const { PlaylistManager } = players;

const log = { info: () => { }, warn: () => { }, error: () => { } };

function song(id, title = `song-${id}`, artist = 'artist') {
  return { id, title, artist, type: 'remote', duration: 180, url: `/api/v1/songs/${id}/play` };
}

/**
 * 构造一个只驱动队列逻辑的 manager：playCurrent 被替换成纯状态更新，
 * 不触发真实的设备推送、定时器和起播确认。
 */
function managerWithQueue(songs, mode = 'order') {
  const manager = new PlaylistManager('account', 'speaker', {
    getPlayState: async () => ({ status: 1, position: 10, duration: 180, hasPosition: true }),
    playURL: async () => true,
    stopPlay: async () => true,
    textToSpeech: async () => { },
  }, {
    getConfig: async () => ({}),
    updateDevice: async () => { },
    savePlaylistProgress: async () => { },
  });
  manager.playCurrent = async () => true;
  return manager.playWithSongs(songs, 0, mode, '单曲测试').then(() => {
    manager.state = 'playing';
    return manager;
  });
}

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function withGlobals(run) {
  const original = { songloft: globalThis.songloft, callHostAPI: http.callHostAPI };
  globalThis.songloft = { log, songs: { search: async () => [] } };
  http.callHostAPI = async () => ({});
  return Promise.resolve(run()).finally(() => {
    globalThis.songloft = original.songloft;
    http.callHostAPI = original.callHostAPI;
  });
}

test('temporary queue appends deduplicate by id and ignore real playlists', async () => {
  await withGlobals(async () => {
    const manager = await managerWithQueue([song(1)]);
    assert.equal(manager.getTotalSongs(), 1);

    assert.equal(manager.appendSongs([song(1), song(2), song(2), song(3)]), 2);
    assert.equal(manager.getTotalSongs(), 3);
    assert.deepEqual(manager.getSongs().map(s => s.id), [1, 2, 3]);

    // 真实歌单不能凭空追加
    const real = new PlaylistManager('account', 'speaker', {
      getPlayState: async () => ({ status: 1, position: 10, duration: 180, hasPosition: true }),
      playURL: async () => true,
      stopPlay: async () => true,
      textToSpeech: async () => { },
    }, { getConfig: async () => ({}), updateDevice: async () => { }, savePlaylistProgress: async () => { } });
    real.initWithSongs([song(11)], 0, 'order', 42);
    assert.equal(real.appendSongs([song(12)]), 0);
    assert.deepEqual(real.getSongs().map(s => s.id), [11]);
    manager.cleanup();
    real.cleanup();
  });
});

test('order queue asks the refill hook when exhausted and continues with the appended song', async () => {
  await withGlobals(async () => {
    const manager = await managerWithQueue([song(1)]);
    let calls = 0;
    manager.setQueueRefillHook(async () => {
      calls++;
      return calls === 1 ? [song(2)] : null;
    });

    await manager.advanceToNext();
    await flush();

    assert.ok(calls >= 1, 'refill hook should be called when order queue has no next');
    assert.equal(manager.getCurrentSong().id, 2);
    assert.equal(manager.state, 'playing');
    assert.deepEqual(manager.getSongs().map(s => s.id), [1, 2]);
    manager.cleanup();
  });
});

test('refill result is discarded when the queue is replaced while the hook is in flight', async () => {
  await withGlobals(async () => {
    const manager = await managerWithQueue([song(1)]);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    manager.setQueueRefillHook(async () => {
      await pending;
      return [song(2)];
    });

    const refill = manager.replenishQueue(true);
    await flush();
    // 补充还在等待外部搜索时，用户点了另一首歌：整体替换队列
    await manager.playWithSongs([song(9)], 0, 'order', '另一首');
    manager.state = 'playing';
    release();
    assert.equal(await refill, 0, 'stale refill must not append to the new queue');
    assert.deepEqual(manager.getSongs().map(s => s.id), [9]);
    manager.cleanup();
  });
});

test('queue generation advances on every full queue replacement', async () => {
  await withGlobals(async () => {
    const manager = await managerWithQueue([song(1)]);
    const first = manager.getQueueGeneration();
    manager.appendSongs([song(2)]);
    assert.equal(manager.getQueueGeneration(), first, 'append keeps the same queue identity');
    await manager.playWithSongs([song(3)], 0, 'order', '换一首');
    assert.ok(manager.getQueueGeneration() > first);
    manager.cleanup();
  });
});
