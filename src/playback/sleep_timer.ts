import type { MinaService } from '../service/service';
import type { PlaylistManagerMap } from '../player/manager';
import { SleepTimer } from '../sleep_timer';
export class SleepTimerService {
  private timers = new Map<string, SleepTimer>();
  constructor(private players: PlaylistManagerMap, private devices: MinaService) { }
  private key(account: string, device: string): string {
    const primary = this.players.get(account, device)?.getPrimary?.();
    return JSON.stringify(primary ? [primary.account_id, primary.device_id] : [account, device]);
  }
  get(account: string, device: string): {
    active: boolean;
    mode: string;
    remaining: number;
    total: number;
  } {
    const state = this.timers.get(this.key(account, device))?.getState();
    return state || { active: false, mode: 'time', remaining: 0, total: 0 };
  }
  cancel(account: string, device: string): boolean {
    const timer = this.timers.get(this.key(account, device));
    const active = !!timer?.isActive();
    timer?.cancel();
    this.players.get(account, device)?.setOnAdvanceHook(undefined);
    return active;
  }
  set(account: string, device: string, mode: 'time' | 'songs', value: number): ReturnType<SleepTimerService['get']> {
    if (!Number.isInteger(value) || value < 1 || value > (mode === 'time' ? 999 : 99))
      throw new Error('定时参数超出范围');
    const key = this.key(account, device);
    this.timers.get(key)?.cancel();
    const manager = this.players.get(account, device);
    const primary = manager?.getPrimary?.() || { account_id: account, device_id: device };
    const timer = new SleepTimer(() => {
      void (async () => {
        // 分组重建后，旧计时器不能停止新的播放队列。
        if (manager) {
          if (this.players.get(primary.account_id, primary.device_id) === manager)
            await manager.stop();
        }
        else
          await this.devices.stopPlay(primary.account_id, primary.device_id);
      })().catch(error => songloft.log.warn('[SleepTimer] stop_failed=' + String(error)));
    });
    this.timers.set(key, timer);
    manager?.setOnAdvanceHook(undefined);
    if (mode === 'time')
      timer.setTime(value);
    else {
      timer.setSongs(value);
      manager?.setOnAdvanceHook(() => timer!.onSongAdvanced());
    }
    return this.get(account, device);
  }
  close(): void {
    for (const timer of this.timers.values())
      timer.cancel();
    this.timers.clear();
  }
}
