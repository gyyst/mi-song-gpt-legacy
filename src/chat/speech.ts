import type { MinaService } from '../service/service';
import type { InteractionToken } from '../playback/coordinator';
export type SpeechResult = 'completed' | 'failed' | 'cancelled' | 'unknown';
export function speechSegments(answer: string): string[] {
  let text = answer.replace(/```[\s\S]*?```/g, '（代码请查看对话记录）').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '（链接请查看对话记录）').replace(/[*#`_>]/g, '').trim();
  if (text.length > 1200)
    text = text.slice(0, 1160) + '。完整回答请查看对话记录。';
  const chunks: string[] = [];
  while (text) {
    let end = Math.min(200, text.length);
    if (text.length > 200) {
      const piece = text.slice(0, 200);
      const boundary = Math.max(piece.lastIndexOf('。'), piece.lastIndexOf('！'), piece.lastIndexOf('？'), piece.lastIndexOf('\n'));
      if (boundary >= 50)
        end = boundary + 1;
    }
    chunks.push(text.slice(0, end));
    text = text.slice(end).trim();
  }
  return chunks;
}
export class SpeechService {
  constructor(private devices: MinaService) { }
  async stop(token: InteractionToken): Promise<void> {
    const result = await this.devices.stopForInteraction(token.account, token.device, token.isCurrent);
    if (token.isCurrent() && result !== 'stopped')
      throw new Error('无法确认回答已停止，保持音乐暂停');
  }
  async speak(answer: string, token: InteractionToken, current = token.isCurrent): Promise<SpeechResult> {
    const segments = speechSegments(answer);
    if (!segments.length)
      return 'failed';
    for (const text of segments) {
      if (!current())
        return 'cancelled';
      if (!await this.devices.textToSpeech(token.account, token.device, text, current))
        return current() ? 'failed' : 'cancelled';
      const started = Date.now();
      const protection = Math.max(3000, text.length / 4 * 1000);
      let idle = 0, sample = started;
      while (Date.now() - started < 90000) {
        if (!current())
          return 'cancelled';
        await new Promise<void>(resolve => setTimeout(resolve, 1000));
        if (!current())
          return 'cancelled';
        const status = await this.devices.getPlayState(token.account, token.device);
        if (!current())
          return 'cancelled';
        if (Date.now() - started < protection)
          continue;
        if (status.sampledAt && status.sampledAt > sample) {
          sample = status.sampledAt;
          idle = status.status === 0 || status.status === 2 ? idle + 1 : 0;
          if (idle >= 2)
            break;
        }
      }
      if (idle < 2)
        return 'unknown';
    }
    return 'completed';
  }
}
