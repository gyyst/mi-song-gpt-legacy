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

const noop = () => { };
const { OnlineSearcher } = loadSource('../src/voicecmd/online_searcher.ts', {
  '../service/service': { MinaService: class { } },
  '../utils/http': {
    getHostAPIBaseUrl: async () => 'http://host/api',
    getHostBaseUrl: async () => 'http://host',
  },
  '../player/url_builder': { URLBuilder: { buildSongURL: async () => '' }, playbackOptionsOf: () => ({}) },
  '../config/manager': { ConfigManager: class { } },
  '../indexing/manager': { IndexingManager: class { } },
  '../group/coordinator': { GroupCoordinator: class { } },
});

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function withGlobals(run) {
  const original = globalThis.songloft;
  globalThis.songloft = {
    log: { info: noop, warn: noop, error: noop },
    plugin: { getToken: async () => 'test-token' },
    songs: { search: async () => [] },
  };
  return Promise.resolve(run()).finally(() => {
    globalThis.songloft = original;
  });
}

/** 只模拟 PlaylistManager 的队列补充接口，验证链路的歌源选择与去重。 */
function fakePlayer(seed, generation = 1) {
  const state = { songs: [seed], generation, hook: undefined };
  return {
    state,
    getQueueGeneration: () => state.generation,
    getSongs: () => state.songs,
    setQueueRefillHook(hook) { state.hook = hook; },
    async replenishQueue() {
      if (!state.hook) return 0;
      const songs = await state.hook();
      if (!songs) return 0;
      const existing = new Set(state.songs.map(s => s.id));
      let added = 0;
      for (const song of songs) {
        if (existing.has(song.id)) continue;
        existing.add(song.id);
        state.songs.push(song);
        added++;
      }
      return added;
    },
  };
}

const config = {
  external_search_enabled: true,
  external_search_auto_continue: true,
  external_search_no_import: false,
  external_search_sources: [{ id: 's', name: 'source', url: 'http://source.test/search', enabled: true }],
  external_search_timeout: 6,
};

function buildSearcher() {
  const searcher = new OnlineSearcher({ getConfig: async () => config });
  let nextId = 100;
  searcher.importSong = async () => ({ id: nextId++, url: '/api/v1/songs/play' });
  searcher.buildStandaloneSong = async (imported, candidate) => ({
    id: imported.id,
    title: candidate.title,
    artist: candidate.artist || '',
    type: 'remote',
    duration: 120,
    url: imported.url,
  });
  // 单测不走真实搜索：候选耗尽后的外部搜索直接视为无结果
  searcher.search = async () => null;
  return searcher;
}

const seed = { title: '晴天', artist: '周杰伦', id: 1 };
const candidates = [
  { title: '晴天', artist: '周杰伦' },       // 与种子相同，必须过滤
  { title: '七里香', artist: '周杰伦' },
  { title: '七里香', artist: '周杰伦' },     // 批内重复，只能导入一次
  { title: '夜曲', artist: '周杰伦' },
  { title: '稻香', artist: '周杰伦' },
];

test('auto-continue prefills the temp queue from provider candidates and skips duplicates', async () => {
  await withGlobals(async () => {
    const searcher = buildSearcher();
    const pm = fakePlayer(seed);

    await searcher.startAutoContinue(pm, { ...seed, candidates });
    await flush();

    assert.deepEqual(pm.state.songs.map(s => s.title), ['晴天', '七里香', '夜曲', '稻香']);
    assert.ok(pm.state.hook, 'refill hook should be installed');

    // 候选耗尽、外部搜索与曲库都没有新歌 → 链路结束并摘掉 hook
    assert.equal(await pm.state.hook(), null);
    assert.equal(pm.state.hook, undefined);
  });
});

test('auto-continue stops immediately when the queue generation no longer matches', async () => {
  await withGlobals(async () => {
    const searcher = buildSearcher();
    const pm = fakePlayer(seed);
    await searcher.startAutoContinue(pm, { ...seed, candidates });
    await flush();

    pm.state.generation = 2; // 用户换了新队列
    const hook = pm.state.hook;
    assert.equal(await hook(), null);
    assert.equal(pm.state.hook, undefined, 'stale chain should uninstall itself');
  });
});

test('auto-continue does nothing when the option or external search is disabled', async () => {
  await withGlobals(async () => {
    const searcher = buildSearcher();
    const pm = fakePlayer(seed);

    config.external_search_auto_continue = false;
    await searcher.startAutoContinue(pm, { ...seed, candidates });
    await flush();
    assert.equal(pm.state.hook, undefined);
    assert.deepEqual(pm.state.songs.map(s => s.id), [1]);

    config.external_search_auto_continue = true;
    config.external_search_enabled = false;
    await searcher.startAutoContinue(pm, { ...seed, candidates });
    await flush();
    assert.equal(pm.state.hook, undefined);
    assert.deepEqual(pm.state.songs.map(s => s.id), [1]);

    config.external_search_enabled = true;
  });
});
