import type { ConfigManager } from '../config/manager';
import type { MinaService } from '../service/service';
import type { PlaylistManager, PlaylistManagerMap } from '../player/manager';
import type { DeviceTargetRef } from '../types';
import { chatScope } from '../chat/types';
export interface InteractionToken {
  id: string;
  order: number;
  account: string;
  device: string;
  active: boolean;
  members: DeviceTargetRef[];
  manager?: PlaylistManager;
  position: number;
  revision: number;
  restore: boolean;
  restoring?: boolean;
  wasPaused?: boolean;
  isCurrent: () => boolean;
  onCancel?: () => void;
  releaseGuard?: () => void;
}
/** 交互只借用队列；所有新媒体操作都撤销恢复凭证。 */
export class PlaybackCoordinator {
  private sequence = 0;
  private tokens = new Set<InteractionToken>();
  private onDeviceControl?: (account: string, device: string) => void;
  setOnDeviceControl(callback: (account: string, device: string) => void): void { this.onDeviceControl = callback; }
  sameScope(a: string, d: string, account: string, device: string): boolean {
    if (a === account && d === device)
      return true;
    const manager = this.players.get(a, d);
    return !!manager && manager === this.players.get(account, device);
  }
  constructor(private players: PlaylistManagerMap, private devices: MinaService, private config: ConfigManager) {
    devices.setOnControl((account, device) => { this.invalidate(account, device); this.onDeviceControl?.(account, device); });
  }
  token(id: string, account: string, device: string): InteractionToken {
    this.invalidate(account, device);
    const token: InteractionToken = {
      id, order: ++this.sequence, account, device, active: true, members: [{ account_id: account, device_id: device }], position: 0, revision: 0, restore: false,
      isCurrent: () => token.active && (!token.manager || ((token.restoring || token.manager.getPlaybackRevision() === token.revision) && !token.manager.isExternalPlayback()))
    };
    this.tokens.add(token);
    return token;
  }
  invalidate(account?: string, device?: string): void {
    for (const token of [...this.tokens]) {
      if (account && !token.members.some(m => m.account_id === account && (!device || m.device_id === device)))
        continue;
      this.release(token);
      token.onCancel?.();
    }
  }
  async prepare(token: InteractionToken): Promise<void> {
    const group = await this.config.findDeviceGroup(token.account, token.device);
    if (!token.active)
      return;
    token.members = group?.members || token.members;
    for (const other of [...this.tokens]) {
      if (other !== token && other.members.some(m => token.members.some(n => chatScope(m.account_id, m.device_id) === chatScope(n.account_id, n.device_id)))) {
        if (other.order > token.order) {
          this.release(token);
          token.onCancel?.();
          return;
        }
        this.release(other);
        other.onCancel?.();
      }
    }
    const manager = this.players.get(token.account, token.device);
    if (manager?.isExternalPlayback())
      throw new Error('请先停止 DLNA 投放，再开始 AI 对话');
    token.manager = manager || undefined;
    token.position = manager?.getInteractionPosition?.() ?? manager?.getPosition() ?? 0;
    token.revision = manager?.getPlaybackRevision() || 0;
    token.restore = !!manager?.isPlaying();
    token.wasPaused = manager?.getStatus?.().state === 'paused';
    token.releaseGuard = manager?.setInteractionGuard(() => this.invalidate(token.account, token.device));
    manager?.cancelHourlyResume();
    if (manager?.reserveForVoiceInteraction)
      manager.reserveForVoiceInteraction();
    else if (token.restore)
      manager!.suspendForVoiceInteraction();
    token.revision = manager?.getPlaybackRevision() || 0;
    if (token.restore) {
      await Promise.all(token.members.map(async (member) => {
        const result = await this.devices.stopForInteraction(member.account_id, member.device_id, token.isCurrent);
        if (result !== 'stopped' && token.isCurrent()) {
          if (member.account_id === token.account && member.device_id === token.device)
            throw new Error('无法暂停提问音箱');
          songloft.log.warn(`[ChatPlayback] task=${token.id} member_pause_failed`);
        }
      }));
    }
    if (!token.isCurrent())
      return;
    const result = await this.devices.interruptAnswer(token.account, token.device, token.isCurrent);
    if (token.isCurrent() && result.status !== 'accepted')
      throw new Error('无法打断音箱原回答');
  }
  async finish(token: InteractionToken, restore: boolean): Promise<void> {
    if (!token.isCurrent()) {
      this.release(token);
      return;
    }
    const manager = token.manager;
    token.restoring = true;
    // 删除凭证前仍保留 isCurrent，恢复推送在排队及返回时都核对。
    try {
      if (manager && (token.restore || token.wasPaused)) {
        if (restore && token.restore) {
          const resumed = await manager.replayCurrent(token.position, token.isCurrent);
          if (!resumed && token.isCurrent()) {
            await manager.holdAfterInteraction(token.position);
            throw new Error('音乐恢复失败，请手动继续播放');
          }
        }
        else
          await manager.holdAfterInteraction(token.position);
      }
    }
    finally {
      this.release(token);
    }
  }
  release(token: InteractionToken): void {
    token.active = false;
    this.tokens.delete(token);
    token.releaseGuard?.();
    token.releaseGuard = undefined;
  }
  busyReason(): string { return this.tokens.size ? 'voice interaction active' : ''; }
  close(): void { this.invalidate(); }
}
