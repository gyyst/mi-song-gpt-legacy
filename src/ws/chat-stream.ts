import { parseQuery } from '@songloft/plugin-sdk';
import type { WebSocketRequest, InboundWebSocket } from '@songloft/plugin-sdk';
import type { AIChatService } from '../chat/service';
import type { ConfigManager } from '../config/manager';
import { validateChatTarget } from '../handlers/chat';
export const WS_CHAT_PATH = '/chat/ws';
export async function handleChatWebSocket(req: WebSocketRequest, socket: InboundWebSocket, config: ConfigManager, chat: AIChatService): Promise<void> {
  let unsubscribe: (() => void) | undefined;
  try {
    const target = await validateChatTarget(config, parseQuery(req.query));
    unsubscribe = chat.subscribe((scope, status) => {
      if (scope === target.scope && socket.readyState === socket.OPEN) {
        try {
          void socket.send(JSON.stringify({ type: 'chat_status', data: status })).catch(() => unsubscribe?.());
        }
        catch {
          unsubscribe?.();
        }
      }
    });
    socket.onClose(unsubscribe);
    socket.onError(unsubscribe);
    await socket.send(JSON.stringify({ type: 'chat_status', data: chat.status(target.account, target.device) }));
  }
  catch {
    unsubscribe?.();
    await socket.close(1008, 'invalid chat target').catch(() => { });
  }
}
