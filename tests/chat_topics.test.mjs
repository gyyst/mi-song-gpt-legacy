import assert from 'node:assert/strict';
import test from 'node:test';
import { load, qaConfigOf, turnOf, storageOf, ChatMemoryService } from './chat_fixture.mjs';

const cfg = qaConfigOf({ memory_enabled: true });
const connection = { api_url: 'https://x/v1', api_key: 'k', model: 'm', timeout: 30 };
const similar = ['今天上证指数多少', '今天中证500指数多少', '今天中证红利指数多少', '今天创业板指数多少', '今天科创50指数多少'];

function serviceOf(t, { label = 'A股指数行情', fail = false } = {}) {
  const kinds = [];
  const memory = new ChatMemoryService(async (_conn, messages, kind) => {
    kinds.push(kind);
    if (kind === 'summary')
      return '摘要';
    if (messages.some(m => m.content.includes('话题标签'))) {
      if (fail)
        throw new Error('naming down');
      return label;
    }
    return '[]';
  });
  t.after(() => memory.close());
  return { memory, kinds };
}

test('三轮同类提问不生成话题记忆，第四轮用 LLM 标签生成一条', async (t) => {
  storageOf(t);
  const { memory } = serviceOf(t);
  for (let i = 0; i < 3; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: similar[i] }), cfg);
  await memory.maintain('a', connection, cfg);
  assert.deepEqual((await memory.load('a')).memories, [], '未达阈值不生成');
  await memory.saveTurn('a', turnOf('t3', { user: similar[3] }), cfg);
  await memory.maintain('a', connection, cfg);
  const value = await memory.load('a');
  assert.equal(value.memories.length, 1);
  const topic = value.memories[0];
  assert.equal(topic.topic, true);
  assert.equal(topic.manual, false);
  assert.equal(topic.content, '用户经常询问：A股指数行情（近30天4次）');
  assert.equal(topic.source_ids.length, 4);
});

test('第五轮同类提问原地刷新计数，不新建条目', async (t) => {
  storageOf(t);
  const { memory, kinds } = serviceOf(t);
  for (let i = 0; i < 5; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: similar[i] }), cfg);
  await memory.maintain('a', connection, cfg);
  const topics = (await memory.load('a')).memories.filter(m => m.topic);
  assert.equal(topics.length, 1, '同话题只保留一条');
  assert.equal(topics[0].content, '用户经常询问：A股指数行情（近30天5次）');
  assert.equal(topics[0].source_ids.length, 5);
  assert.equal(kinds.filter(kind => kind === 'memory').length, 6, '5轮提取 + 1次命名');
  kinds.length = 0;
  await memory.saveTurn('a', turnOf('t5', { user: '今天深证成指多少' }), cfg);
  await memory.maintain('a', connection, cfg);
  const after = (await memory.load('a')).memories.filter(m => m.topic);
  assert.equal(after.length, 1);
  assert.equal(after[0].content, '用户经常询问：A股指数行情（近30天6次）', '已有标签不重新命名');
  assert.deepEqual(kinds, ['memory'], '只有新轮次的提取调用，不再命名');
});

test('不相似的问题不聚类', async (t) => {
  storageOf(t);
  const { memory } = serviceOf(t);
  const texts = ['今天上证指数多少', '下一首歌', '播放我的歌单', '明天天气怎么样', '音量调到50', '现在几点了'];
  for (let i = 0; i < texts.length; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: texts[i] }), cfg);
  await memory.maintain('a', connection, cfg);
  assert.deepEqual((await memory.load('a')).memories, []);
});

test('LLM 命名失败降级为代表问句文案', async (t) => {
  storageOf(t);
  const { memory } = serviceOf(t, { fail: true });
  for (let i = 0; i < 4; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: similar[i] }), cfg);
  await memory.maintain('a', connection, cfg);
  const topic = (await memory.load('a')).memories.find(m => m.topic);
  assert.ok(topic);
  assert.equal(topic.content, `用户经常询问：「${similar[3]}」等类似问题（近30天4次）`);
});

test('历史清理到阈值以下后话题记忆被回收', async (t) => {
  storageOf(t);
  const { memory } = serviceOf(t);
  for (let i = 0; i < 4; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: similar[i] }), cfg);
  await memory.maintain('a', connection, cfg);
  assert.equal((await memory.load('a')).memories.filter(m => m.topic).length, 1);
  await memory.mutate('a', value => { value.history = value.history.slice(0, 2); });
  await memory.maintain('a', connection, cfg);
  assert.equal((await memory.load('a')).memories.filter(m => m.topic).length, 0, '组掉到4次以下回收话题记忆');
});

test('关闭用户记忆时不做话题聚合', async (t) => {
  storageOf(t);
  const off = qaConfigOf({ memory_enabled: false });
  const { memory, kinds } = serviceOf(t);
  for (let i = 0; i < 4; i++)
    await memory.saveTurn('a', turnOf(`t${i}`, { user: similar[i] }), off);
  await memory.maintain('a', connection, off);
  assert.deepEqual((await memory.load('a')).memories, []);
  assert.deepEqual(kinds, []);
});
