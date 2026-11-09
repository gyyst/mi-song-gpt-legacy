import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deferred } from './chat_loader.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// 与其它测试一致：转译成 CJS 再注入依赖（qa_fallback → ai_url 无扩展名，Node ESM 解析不了）
function loadTs(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const module = { exports: {} };
  new Function('require', 'exports', outputText)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw new Error('unexpected dependency: ' + name);
  }, module.exports);
  return module.exports;
}

const originalSongloft = globalThis.songloft;
globalThis.songloft = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  storage: { get: async () => null, set: async () => {} },
};
test.after(() => { globalThis.songloft = originalSongloft; });

const aiUrl = loadTs('../src/utils/ai_url.ts');
const memoryModule = {
  accountScope: (account) => account,
  qaConnection: (config) => ({ enabled: config.enabled, api_url: config.api_url, api_key: config.api_key, model: config.model, timeout: config.timeout }),
  ChatMemoryService: class {},
};
const { isXiaoAIAnswerFailure, QAFallback } = loadTs('../src/voicecmd/qa_fallback.ts', {
  '../utils/ai_url': aiUrl,
  '../chat/memory': memoryModule,
  '../utils/ai_request': { requestAI: async () => { throw new Error('unused in tests'); } },
});

// ===== isXiaoAIAnswerFailure：小爱兜底话术 =====

const failures = [
  '我不知道',
  '我还在学习中',
  '这个问题把我问住了',
  '被难住了诶',
  '没听懂你说的话',
  '暂时不支持该功能',
  '没有找到歌曲',
  '无法找到相关内容',
  '换个问题试试吧',
  '我还不支持这个功能',
  '回答不了',
  '不太清楚',
  '这个问题落到我的盲区了，我要加紧学习了',
  '我的盲区',
  '我要加紧学习了',
];
for (const t of failures) {
  assert.equal(isXiaoAIAnswerFailure(t), true, `应当判为失败话术: ${t}`);
}

const valid = [
  '好的，为你播放周杰伦的晴天',
  '北京今天晴，气温25度',
  '已将音量调到50',
  '嗯',
  '在的',
];
for (const t of valid) {
  assert.equal(isXiaoAIAnswerFailure(t), false, `不应当判为失败话术: ${t}`);
}

// ===== splitForTTS：分段 =====

assert.deepEqual(QAFallback.splitForTTS('你好世界', 100), ['你好世界']);
assert.equal(QAFallback.splitForTTS('很长'.repeat(300), 0).length, 1);

{
  const long = '第一句话。第二句话！第三句话？这是一段没有句号的很长很长很长的内容';
  const parts = QAFallback.splitForTTS(long, 10);
  assert.ok(parts.length > 1, '应当被切分');
  for (const p of parts) {
    assert.ok(p.length <= 10, `分段超长: ${p} (${p.length})`);
  }
}

{
  const parts = QAFallback.splitForTTS('啊'.repeat(35), 10);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map(p => p.length), [10, 10, 10, 5]);
}

// ===== sanitizeForTTS：清洗 =====

assert.equal(
  QAFallback.sanitizeForTTS('详情见[官网](https://example.com)或 https://a.b/c 引用[1] *重点* #标题#'),
  '详情见官网或 引用 重点 标题',
);

assert.equal(QAFallback.sanitizeForTTS('<think>推理过程</think>答案'), '答案');

// ===== 行为测试：记忆接入 / 追问窗口 / 原生闸门 =====

const qaConfigOf = (updates = {}) => ({
  enabled: true, api_url: 'https://example.test/v1', api_key: 'test-only', model: 'model', timeout: 30,
  system_prompt: '人设', thinking_notice: '', native_answer_wait_sec: 0, web_search_enabled: false,
  web_search_strategy: 'hybrid', web_search_fallback_notice: '', max_reply_length: 0, followup_seconds: 60,
  memory_enabled: true, context_turns: 12, history_limit: 500, history_days: 30, ...updates,
});
const snapshotOf = (updates = {}) => ({ version: 1, revision: 0, context_since: 0, history: [], summary: '', summary_sources: [], extracted_sources: [], memories: [], ...updates });
const turnOf = (id, updates = {}) => ({ id, user: `问题${id}`, assistant: `答案${id}`, phase: 'completed', created_at: Date.now(), ...updates });
const messageOf = (text) => ({ account_id: 'acc', device_id: 'd', message: { request_id: 'r1', timestamp_ms: 1, response: { answer: [{ question: text }] } } });
const baseInput = (text = '今天天气怎么样') => ({ msg: messageOf(text), query: text, accountId: 'acc', aiResult: null, aiEnabled: false });

function qaOf(t, { config, snapshot, answer = '大模型答案', native, client: clientOverride } = {}) {
  const calls = { native: 0, stop: 0, tts: [], saveTurn: [], maintain: [], requests: [] };
  const configManager = { getQAConfig: async () => qaConfigOf(config) };
  const minaService = {
    async stopPlay() { calls.stop++; },
    async textToSpeech(_a, _d, text) { calls.tts.push(text); },
  };
  const memory = {
    async load() { return snapshot === null ? null : (snapshot ?? snapshotOf()); },
    messages(_snapshot, cfg, query) { return [{ role: 'system', content: cfg.system_prompt }, { role: 'user', content: query }]; },
    async saveTurn(scope, turn) { calls.saveTurn.push({ scope, turn }); },
    async maintain(scope) { calls.maintain.push(scope); },
  };
  const client = clientOverride || {
    async request(_connection, messages, kind, _current, scope) { calls.requests.push({ kind, scope, messages }); return answer; },
  };
  const qa = new QAFallback(configManager, minaService, memory, client);
  let nativeFn = async () => { calls.native++; return native; };
  qa.waitForNativeAnswer = (...args) => nativeFn(...args);
  return { qa, calls, setNative: (fn) => { nativeFn = async (...args) => { calls.native++; return fn(...args); }; } };
}

test('followup window skips the native gate and records the turn with account scope', async () => {
  const { qa, calls } = qaOf(t => t, { snapshot: snapshotOf({ history: [turnOf('prev', { created_at: Date.now() - 5000 })] }), answer: '追问答案' });
  const result = await qa.handle(baseInput('那之后呢'));
  assert.equal(result.outcome, 'answered_by_llm');
  assert.equal(result.handled, true);
  assert.equal(calls.native, 0, '追问窗口内不等小爱');
  assert.deepEqual(calls.requests.map(r => [r.kind, r.scope]), [['chat', 'acc']]);
  assert.equal(calls.saveTurn.length, 1);
  assert.equal(calls.saveTurn[0].scope, 'acc', '记忆按账号作用域');
  assert.equal(calls.saveTurn[0].turn.assistant, '追问答案');
  assert.deepEqual(calls.maintain, ['acc']);
});

test('valid native answer wins outside the followup window', async () => {
  const { qa, calls } = qaOf(t => t, { native: '北京今天晴，25度' });
  const result = await qa.handle(baseInput());
  assert.equal(result.outcome, 'answered_by_xiaoai');
  assert.equal(result.handled, false);
  assert.equal(calls.native, 1);
  assert.equal(calls.requests.length, 0, '原生回答有效时不打扰大模型');
  assert.equal(calls.saveTurn.length, 0, '小爱自答不写入记忆');
});

for (const native of ['我不知道', null]) {
  test(`native ${native === null ? 'timeout' : 'fallback phrase'} hands over to the LLM`, async () => {
    const { qa, calls } = qaOf(t => t, { native });
    const result = await qa.handle(baseInput());
    assert.equal(result.outcome, 'answered_by_llm');
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.saveTurn.length, 1);
  });
}

test('followup_seconds=0 never opens the followup window', async () => {
  const { qa, calls } = qaOf(t => t, { config: { followup_seconds: 0 }, snapshot: snapshotOf({ history: [turnOf('prev', { created_at: Date.now() })] }), native: '小爱能答' });
  const result = await qa.handle(baseInput());
  assert.equal(result.outcome, 'answered_by_xiaoai');
  assert.equal(calls.native, 1);
});

test('memory load failure degrades to answering without context', async () => {
  const { qa, calls } = qaOf(t => t, { snapshot: null, native: null });
  const result = await qa.handle(baseInput());
  assert.equal(result.outcome, 'answered_by_llm');
  assert.equal(calls.requests[0].messages.length, 2, '无快照时仅 system + user');
});

test('disabled or incomplete config skips takeover', async () => {
  for (const config of [{ enabled: false }, { api_url: '' }, { api_key: '' }, { model: '' }]) {
    const { qa, calls } = qaOf(t => t, { config });
    const result = await qa.handle(baseInput());
    assert.equal(result.handled, false);
    assert.equal(result.outcome, 'skipped');
    assert.equal(calls.requests.length, 0);
  }
});

test('confident music intent is not a QA candidate', async () => {
  const { qa, calls } = qaOf(t => t, { native: '不知道' });
  const result = await qa.handle({ ...baseInput(), aiEnabled: true, aiResult: { action: 'play_song', confidence: 'high' } });
  assert.equal(result.handled, false);
  assert.equal(result.outcome, 'skipped');
  assert.equal(calls.native, 0);
});

test('isBusy reflects in-flight takeover', async () => {
  const gate = deferred();
  const { qa } = qaOf(t => t, {
    snapshot: snapshotOf({ history: [turnOf('prev', { created_at: Date.now() })] }),
    client: { request: async () => { await gate.promise; return '慢答案'; } },
  });
  assert.equal(qa.isBusy(), false);
  const pending = qa.handle(baseInput());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(qa.isBusy(), true);
  gate.resolve();
  await pending;
  assert.equal(qa.isBusy(), false);
});

test('superseded request skips its own TTS', async () => {
  const first = deferred(), answers = ['旧答案', '新答案'];
  let index = 0;
  const { qa, calls } = qaOf(t => t, {
    snapshot: snapshotOf({ history: [turnOf('prev', { created_at: Date.now() })] }),
    client: { request: async () => { const answer = answers[index++]; if (answer === '旧答案') await first.promise; return answer; } },
  });
  const oldRun = qa.handle({ ...baseInput('旧问题'), msg: messageOf('旧问题') });
  await new Promise(resolve => setImmediate(resolve));
  const newRun = qa.handle({ ...baseInput('新问题'), msg: messageOf('新问题') });
  const newResult = await newRun;
  first.resolve();
  const oldResult = await oldRun;
  assert.equal(newResult.answer, '新答案');
  assert.equal(oldResult.note, 'superseded, TTS skipped');
  assert.deepEqual(calls.tts, ['新答案'], '只有新轮播报；被抢的旧轮不得补播');
});

test('testQA requests the model without touching memory or the speaker', async () => {
  const { qa, calls } = qaOf(t => t, { answer: '测试答案' });
  const result = await qa.testQA(' 你好 ');
  assert.equal(result.text, '测试答案');
  assert.equal(result.used_search, false);
  assert.deepEqual(calls.requests.map(r => r.kind), ['chat']);
  assert.deepEqual(calls.requests[0].scope, 'test', '测试不落记忆');
  assert.equal(calls.stop, 0);
  assert.equal(calls.saveTurn.length, 0);
});

test('testQA rejects incomplete configuration', async () => {
  const { qa } = qaOf(t => t, { config: { model: '' } });
  await assert.rejects(qa.testQA('你好'), /配置不完整/);
});

console.log('All qa_fallback tests passed!');