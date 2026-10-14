import { jsonResponse, parseQuery } from '@songloft/plugin-sdk';
import type { Router, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import type { ConfigManager } from '../config/manager';
import type { ChatMemoryService } from '../chat/memory';
import { accountScope, qaConnection } from '../chat/memory';

/** 解析入站 JSON body（main.ts 的设备控制作废逻辑也复用） */
export function chatBody(req: HTTPRequest): Record<string, unknown> {
  const raw = !req.body ? '{}' : typeof req.body === 'string' ? req.body : decodeURIComponent(Array.from(req.body).map(byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  }
  catch {
    throw new Error('请求 JSON 无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('请求必须是对象');
  return parsed as Record<string, unknown>;
}

/** 用户记忆按账号作用域：只需校验账号存在 */
async function validateAccount(config: ConfigManager, input: Record<string, unknown>): Promise<{
  account: string;
  scope: string;
}> {
  const account = input.account_id;
  if (typeof account !== 'string' || !account)
    throw new Error('请选择账号');
  if (!(await config.getAccounts()).some(a => a.id === account))
    throw new Error('账号不存在');
  return { account, scope: accountScope(account) };
}

/**
 * 用户记忆/对话历史端点（按账号）。
 * 原 AI 对话子系统拆除后，这里只保留记忆管理面：历史查看/删除、长期记忆 CRUD、
 * 会话重置与清理。摘要重建走 ChatMemoryService.maintain（连接取 qa_config）。
 */
export function registerChatHandlers(router: Router, config: ConfigManager, memory: ChatMemoryService): void {
  const wrap = (run: (req: HTTPRequest, params: Record<string, string>) => Promise<HTTPResponse>) => async (req: HTTPRequest, params: Record<string, string>) => {
    try {
      return await run(req, params);
    }
    catch (error) {
      const detail = error instanceof Error ? error.message : '对话数据操作失败';
      songloft.log.warn('[chat] request_failed: ' + detail);
      return jsonResponse({ error: 'chat_request_failed', message: detail, detail }, 400);
    }
  };
  const target = (req: HTTPRequest, body?: Record<string, unknown>) => validateAccount(config, body || parseQuery(req.query));
  router.get('/chat/history', wrap(async (req) => {
    const t = await target(req), q = parseQuery(req.query), value = await memory.load(t.scope);
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 20)), offset = Math.max(0, Math.floor(Number(q.offset) || 0));
    const cfg = await config.getQAConfig();
    const history = value.history.filter(turn => turn.created_at >= Date.now() - cfg.history_days * 86400000).slice(-cfg.history_limit).reverse();
    return jsonResponse({ history: history.slice(offset, offset + limit), total: history.length, summary: value.summary });
  }));
  router.delete('/chat/history/:id', wrap(async (req, params) => {
    const t = await target(req);
    await memory.removeTurn(t.scope, params.id);
    const cfg = await config.getQAConfig();
    void memory.maintain(t.scope, qaConnection(cfg), cfg, true).catch(() => { });
    return jsonResponse({ deleted: true });
  }));
  router.post('/chat/reset', wrap(async (req) => {
    const t = await target(req, chatBody(req));
    await memory.reset(t.scope);
    return jsonResponse({ reset: true });
  }));
  router.post('/chat/clear', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    if (!['history', 'memory', 'all'].includes(body.range as string))
      throw new Error('清理范围无效');
    await memory.clear(t.scope, body.range as 'history' | 'memory' | 'all');
    return jsonResponse({ cleared: true });
  }));
  router.get('/chat/memories', wrap(async (req) => { const t = await target(req); return jsonResponse({ memories: (await memory.load(t.scope)).memories }); }));
  router.post('/chat/memories', wrap(async (req) => {
    const body = chatBody(req), t = await target(req, body);
    if (typeof body.content !== 'string')
      throw new Error('记忆内容必须是文本');
    const item = await memory.editMemory(t.scope, body.content);
    return jsonResponse(item, 201);
  }));
  router.put('/chat/memories/:id', wrap(async (req, params) => {
    const body = chatBody(req), t = await target(req, body);
    if (typeof body.content !== 'string')
      throw new Error('记忆内容必须是文本');
    const item = await memory.editMemory(t.scope, body.content, params.id);
    return jsonResponse(item);
  }));
  router.delete('/chat/memories/:id', wrap(async (req, params) => { const t = await target(req); await memory.removeMemory(t.scope, params.id); return jsonResponse({ deleted: true }); }));
}