import type { AIConfig } from '../types';
import { aiChatCompletionsUrl } from '../utils/ai_url';
import { requestAI } from '../utils/ai_request';
export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
type Job<T> = {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  current: () => boolean;
  scope: string;
};
/** 前台有界并发；后台摘要永远不占用前台名额。 */
export class AIClient {
  private foreground = 0;
  private activeScopes = new Set<string>();
  private background = false;
  private queue: Job<unknown>[] = [];
  private backgroundQueue: Job<unknown>[] = [];
  private drain(): void {
    while (this.foreground < 2 && this.queue.length) {
      // 作废队列里的旧问题，并只启动该设备最新的待处理请求。
      const stale = this.queue.filter(job => !job.current());
      this.queue = this.queue.filter(job => job.current());
      for (const job of stale)
        job.reject(new Error('任务已取消'));
      const index = this.queue.findIndex(job => !this.activeScopes.has(job.scope));
      if (index < 0)
        break;
      const job = this.queue.splice(index, 1)[0];
      if (!job.current()) {
        job.reject(new Error('任务已取消'));
        continue;
      }
      this.foreground++;
      this.activeScopes.add(job.scope);
      void job.run().then(job.resolve, job.reject).finally(() => { this.foreground--; this.activeScopes.delete(job.scope); this.drain(); });
    }
    if (!this.foreground && !this.queue.length && !this.background && this.backgroundQueue.length) {
      const job = this.backgroundQueue.shift()!;
      if (!job.current()) {
        job.reject(new Error('任务已取消'));
        this.drain();
        return;
      }
      this.background = true;
      void job.run().then(job.resolve, job.reject).finally(() => { this.background = false; this.drain(); });
    }
  }
  foregroundRequest<T>(run: () => Promise<T>, current = () => true, scope = ''): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= 32) {
        reject(new Error('AI 任务队列已满'));
        return;
      }
      this.queue.push({ run, current, scope, resolve: value => resolve(value as T), reject });
      this.drain();
    });
  }
  request(config: AIConfig, messages: AIMessage[], kind: 'chat' | 'summary' | 'memory', current = () => true, scope = ''): Promise<string> {
    if (!config.api_url || !config.api_key || !config.model)
      return Promise.reject(new Error('AI 配置不完整'));
    return new Promise((resolve, reject) => {
      const queue = kind === 'chat' ? this.queue : this.backgroundQueue;
      if (queue.length >= 32) {
        reject(new Error('AI 任务队列已满'));
        return;
      }
      queue.push({
        scope, current, resolve: v => resolve(v as string), reject, run: async () => {
          const value = await requestAI(aiChatCompletionsUrl(config.api_url), {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
            body: JSON.stringify({ model: config.model, stream: false, messages, max_tokens: kind === 'chat' ? 2048 : 1200 }),
          }, config.timeout, { kind, model: config.model }, async (response) => {
            if (!response.ok)
              throw new Error(`AI API error: ${response.status}`);
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim())
              throw new Error('AI 返回了空回答');
            return content.trim().slice(0, 16000);
          });
          if (!current())
            throw new Error('任务已取消');
          return value;
        }
      });
      this.drain();
    });
  }
}
