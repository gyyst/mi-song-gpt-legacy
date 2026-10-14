import type { ConversationMessage } from '../types';
import type { MusicCommandService } from '../music/service';
import type { PlaylistManagerMap } from '../player/manager';
/** 监听只提交任务；每设备最新消息使旧分析失效。 */
export class VoiceDispatcher {
  private versions = new Map<string, number>();
  private seen = new Map<string, number>();
  private closed = false;
  constructor(private music: MusicCommandService, private players?: PlaylistManagerMap) { }
  private scopeOf(account: string, device: string): string {
    return JSON.stringify([account, device]);
  }
  /** 同设备或同分组播放器（分组成员共享一个 PlaylistManager）视为同域 */
  private samePlaybackScope(a: string, d: string, account: string, device: string): boolean {
    if (a === account && d === device)
      return true;
    if (!this.players)
      return false;
    const manager = this.players.get(a, d);
    return !!manager && manager === this.players.get(account, device);
  }
  invalidateDevice(account: string, device: string): void {
    for (const [scope, version] of this.versions) {
      const [a, d] = JSON.parse(scope);
      if (this.samePlaybackScope(a, d, account, device))
        this.versions.set(scope, version + 1);
    }
    this.music.cancelPendingResume(account, device);
  }
  submit(message: ConversationMessage): void {
    if (this.closed)
      return;
    const answer = message.message?.response?.answer?.[0];
    const text = (answer?.intention?.query || answer?.question || '').trim();
    if (!text)
      return;
    const scope = this.scopeOf(message.account_id, message.device_id);
    const id = `${scope}:${message.message.request_id || `${message.message.timestamp_ms}:${text}`}`;
    if (this.seen.has(id))
      return;
    this.seen.set(id, Date.now());
    if (this.seen.size > 1000)
      this.seen.delete(this.seen.keys().next().value!);
    this.invalidateDevice(message.account_id, message.device_id);
    const version = (this.versions.get(scope) || 0) + 1;
    this.versions.set(scope, version);
    this.music.cancelPendingResume(message.account_id, message.device_id);
    const current = () => !this.closed && this.versions.get(scope) === version;
    void this.dispatch(message, text, current).catch(error => songloft.log.warn(`[VoiceDispatcher] failed=${String(error)}`));
  }
  private async dispatch(message: ConversationMessage, text: string, current: () => boolean): Promise<void> {
    if (!current())
      return;
    const fixed = await this.music.fixedControlType?.(text);
    if (fixed || await this.music.hasFixedControl(text)) {
      if (!current())
        return;
      await this.music.handleMessage(message, { deferResume: true, current });
      return;
    }
    if (!current())
      return;
    // 音乐意图未命中 → 问答接管在 music.handleMessage 内部处理
    // （小爱原生闸门 + 大模型兜底）；仍未接管则交给派发器统一恢复。
    const handled = await this.music.handleMessage(message, { deferResume: true, current });
    if (!current() || handled)
      return;
    this.music.resumeUnmatched(message.account_id, message.device_id);
  }
  invalidate(): void { this.versions.clear(); }
  close(): void { this.closed = true; this.invalidate(); }
}