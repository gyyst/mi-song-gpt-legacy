import type { ConfigManager } from '../config/manager';
import type { MinaService } from '../service/service';

interface SmartResumeTask {
  accountId: string;
  deviceId: string;
  revision: number;
  startedAt: number;
  position: number;
}

const SMART_RESUME_INITIAL_DELAY_MS = 1000;
const SMART_RESUME_FAST_INTERVAL_MS = 1000;
const SMART_RESUME_FAST_QUERIES = 4;
const SMART_RESUME_NORMAL_INTERVAL_MS = 5000;

export class VoiceResumeCoordinator {
  private tasks = new Map<string, { task: SmartResumeTask; timer: ReturnType<typeof setTimeout> }>();
  constructor(private configManager: ConfigManager, private minaService: MinaService, private enabled: () => boolean) { }
  /** 取消待执行的语音恢复操作。 */
  cancel(accountId?: string, deviceId?: string): void {
    for (const [key, entry] of this.tasks) {
      if (accountId && entry.task.accountId !== accountId) continue;
      if (deviceId && entry.task.deviceId !== deviceId) continue;
      clearTimeout(entry.timer); this.tasks.delete(key);
    }
  }

  /**
   * 给小爱一秒启动播报，短窗口内读取新状态；旧任务在每次异步返回后核对身份。
   */
  schedule(pm: import('../player/manager').PlaylistManager, accountId: string, deviceId: string): void {
    this.cancel(accountId, deviceId);
    const task: SmartResumeTask = {
      accountId, deviceId,
      revision: pm.getPlaybackRevision(),
      startedAt: Date.now(),
      position: pm.getPosition(),
    };
    const key = JSON.stringify([accountId, deviceId]);
    const timer = setTimeout(() => {
      void this.smartResume(pm, task).catch(e => {
        songloft.log.warn('[VoiceEngine] Smart resume failed: ' + String(e));
      });
    }, SMART_RESUME_INITIAL_DELAY_MS);
    this.tasks.set(key, { task, timer });
  }

  /**
   * 等待小爱 TTS 播报结束后重新推送当前歌曲 URL
   */
  private async smartResume(pm: import('../player/manager').PlaylistManager, task: SmartResumeTask): Promise<void> {
    const isTaskCurrent = () => this.enabled() && this.tasks.get(JSON.stringify([task.accountId, task.deviceId]))?.task === task;
    const isCurrent = () => isTaskCurrent() && pm.isPlaying() && pm.getPlaybackRevision() === task.revision;
    if (!isCurrent()) return;
    const config = await this.configManager.getConfig();
    if (!isCurrent()) return;
    const timeoutSec = Math.max(5, Math.min(120, config.smart_resume_timeout ?? 30));
    const maxWaitMs = timeoutSec * 1000;
    let deviceBecameIdle = false;
    let deviceTakenOver = false;
    let resumePosition = task.position;
    let fastQueries = 0;
    let idleConfirmationQueries = 0;
    let idleHits = 0;
    let lastPosition = -1;
    let lastSampleAt = -1;
    let lastStatus = -1;
    let progressStalled = false;

    while (Date.now() - task.startedAt < maxWaitMs) {
      if (!isCurrent()) return;
      // 快速窗口耗尽后，首次发现 idle 仍可加一次确认，避免已说完又等五秒。
      const confirmIdle = idleHits === 1 && idleConfirmationQueries < 1;
      const fast = fastQueries < SMART_RESUME_FAST_QUERIES || confirmIdle;
      if (fastQueries < SMART_RESUME_FAST_QUERIES) fastQueries++;
      else if (confirmIdle) idleConfirmationQueries++;
      const st = await this.minaService.getPlayState(task.accountId, task.deviceId, fast ? { verify: true } : {});
      if (!isCurrent()) return;
      const sampleAt = st.sampledAt ?? Date.now();
      if (st.status < 0) {
        // 查询失败不是「播报结束」。停止快速回读，遵守 Mina 的失败退避。
        fastQueries = SMART_RESUME_FAST_QUERIES;
        idleHits = 0;
        lastPosition = -1;
        lastStatus = -1;
        progressStalled = false;
      } else if (sampleAt >= task.startedAt && sampleAt > lastSampleAt) {
        lastSampleAt = sampleAt;
        lastStatus = st.status;
        const stream = pm.matchDeviceStream({ ...st, status: 1 });
        // 某些固件在实际播放时连续误报 paused/stopped；进度推进时只校准，不再发 play（#449）。
        if ((st.status === 0 || st.status === 1 || st.status === 2) && stream !== 'foreign' && st.hasPosition) {
          if (lastPosition >= 0 && st.position - lastPosition + 1e-6 >= 0.1) {
            songloft.log.info('[VoiceEngine] Device auto-resumed, progress confirmed; resetting timer only');
            pm.resetAutoNextTimer(st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec());
            return;
          }
          progressStalled = lastPosition >= 0 && st.position >= lastPosition;
          lastPosition = st.position;
        } else {
          lastPosition = -1;
          progressStalled = false;
        }
        if (st.status === 0 || st.status === 2) {
          idleHits++;
          progressStalled = false;
          if (st.hasPosition && stream === 'ours') {
            resumePosition = st.position * pm.getPlaybackSpeed() + pm.getStreamSeekOffsetSec();
          }
          // 两次新采样确认，给延迟启动的播报留出窗口，缓存不能累积命中。
          if (idleHits >= 2) {
            deviceBecameIdle = true;
            break;
          }
        } else if (st.status === 1) {
          idleHits = 0;
          if (stream === 'foreign') {
            // 外来媒体可能就是正在播报的小爱回答，先等结束，不能立刻重推打断。
            deviceTakenOver = true;
            lastPosition = -1;
            progressStalled = false;
          }
        } else {
          idleHits = 0;
          lastPosition = -1;
          lastStatus = -1;
          progressStalled = false;
        }
      }
      const remainingMs = maxWaitMs - (Date.now() - task.startedAt);
      if (remainingMs <= 0) break;
      const interval = fastQueries < SMART_RESUME_FAST_QUERIES || (idleHits === 1 && idleConfirmationQueries < 1)
        ? SMART_RESUME_FAST_INTERVAL_MS : SMART_RESUME_NORMAL_INTERVAL_MS;
      await new Promise(r => setTimeout(r, Math.min(interval, remainingMs)));
    }

    if (!isCurrent()) return;
    if (!deviceBecameIdle && (lastStatus < 0 || (!deviceTakenOver && !progressStalled))) {
      // 未知状态/缺失进度不能证明已续播，也不能据此重推。恢复本地驱动，不发送设备指令。
      songloft.log.warn('[VoiceEngine] Smart resume timed out without playback evidence; restoring timer only');
      pm.resetAutoNextTimer(resumePosition);
      return;
    }

    if (deviceBecameIdle && !deviceTakenOver) {
      const resumed = await pm.resumePlayback({ positionSec: resumePosition, isCurrent: isTaskCurrent });
      if (resumed) {
        songloft.log.info('[VoiceEngine] Resume command sent after voice interaction; verification pending');
        return;
      }
      if (!isCurrent()) return;
    }

    // 被接管或超时仍无进度：带挂起时的位置重推，不把整个播报等待时间算成已听内容。
    // 失败推送自身只停一次定时器；版本再变化说明已有新操作，不能替它收尾。
    const replayRevision = pm.getPlaybackRevision() + 1;
    const ok = await pm.replayCurrent(resumePosition, isTaskCurrent);
    if (ok) {
      songloft.log.info(`[VoiceEngine] Playback restored via replay after voice interaction seek=${resumePosition.toFixed(1)}s`);
    } else if (isTaskCurrent() && pm.getPlaybackRevision() === replayRevision && pm.isPlaying() && pm.isVoiceSuspended()) {
      songloft.log.warn('[VoiceEngine] Failed to restore playback after voice interaction');
      await pm.stop(false);
    }
  }

}
