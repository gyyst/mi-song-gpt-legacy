import { reactive, watch } from 'vue';
import { resolveConfirm, state } from './store';

export type AppPage = 'main' | 'settings' | 'player';

export const navigation = reactive({
  page: 'main' as AppPage,
  pageHistory: [] as AppPage[],
  playerPage: 0,
  settingsCategory: '',
  playerPopup: '',
  editorOpen: false,
  dialogOpen: false,
  devicePickerOpen: false,
});

export function openPage(page: AppPage): void {
  if (navigation.page === page) return;
  navigation.pageHistory.push(navigation.page);
  navigation.page = page;
  if (page === 'player') navigation.playerPage = 0;
  navigation.playerPopup = '';
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export function closePage(): void {
  navigation.playerPopup = '';
  navigation.page = navigation.pageHistory.pop() || 'main';
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

/**
 * 宿主返回键回调：按「最上层浮层 → 编辑器 → 设置子分类 → 页面」的顺序收起，
 * 每层都真正关闭并吞掉这次返回；没有浮层时返回 false 交由宿主处理。
 * 之前 dialogOpen/editorOpen 从未被置位，导致弹窗/编辑器打开时返回键会直接退出页面。
 */
function backAction(): (() => void) | undefined {
  if (state.confirm.open) {
    return () => resolveConfirm(false);
  }
  if (navigation.devicePickerOpen) {
    return () => { navigation.devicePickerOpen = false; };
  }
  if (navigation.playerPopup) {
    return () => { navigation.playerPopup = ''; };
  }
  if (navigation.editorOpen) {
    return () => { navigation.editorOpen = false; };
  }
  if (navigation.page === 'settings' && navigation.settingsCategory && window.innerWidth < 600) {
    return () => { navigation.settingsCategory = ''; };
  }
  if (navigation.page === 'player' && navigation.playerPage === 1 && window.innerWidth < 600) {
    return () => { navigation.playerPage = 0; };
  }
  if (navigation.page !== 'main') {
    return () => {
      if (navigation.page === 'settings') navigation.settingsCategory = '';
      closePage();
    };
  }
  return undefined;
}

export function consumeBack(): boolean {
  const action = backAction();
  if (!action) return false;
  action();
  return true;
}

/** Flutter 直接派发事件；Lynx WebView / 跨域 iframe 使用带会话的状态与回执。 */
export function installHostBack(): () => void {
  let session = '';
  let reply: ((message: unknown) => void) | undefined;
  const publishState = (): void => {
    reply?.({ type: 'songloft-back-state', session, canBack: !!backAction() });
  };
  const onBack = (event: Event): void => {
    if (consumeBack()) event.preventDefault();
  };
  const connect = (data: Record<string, unknown>, send: (message: unknown) => void): void => {
    if (typeof data.session !== 'string' || !data.session || data.session.length > 128) return;
    session = data.session;
    reply = send;
    publishState();
  };
  const request = (data: Record<string, unknown>): void => {
    if (!reply || data.session !== session || !Number.isSafeInteger(data.id)) return;
    const consumed = !document.dispatchEvent(new Event('songloft-back', { cancelable: true }));
    reply({ type: 'songloft-back-result', session, id: data.id, consumed, canBack: !!backAction() });
  };
  const nativeConnect = (event: Event): void => {
    const data = (event as CustomEvent).detail;
    if (!data || typeof data !== 'object') return;
    connect(data, (message) => window.postMessage(JSON.stringify(message), '*'));
  };
  const nativeRequest = (event: Event): void => {
    const data = (event as CustomEvent).detail;
    if (data && typeof data === 'object') request(data);
  };
  let parentOrigin = '';
  const onMessage = (event: MessageEvent): void => {
    if (window.parent === window || event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'songloft-back-connect') {
      parentOrigin = event.origin;
      connect(data, (message) => window.parent.postMessage(message, parentOrigin === 'null' ? '*' : parentOrigin));
    } else if (data.type === 'songloft-back-request' && event.origin === parentOrigin) {
      request(data);
    }
  };
  document.addEventListener('songloft-back', onBack);
  document.addEventListener('songloft-back-connect', nativeConnect);
  document.addEventListener('songloft-back-request', nativeRequest);
  window.addEventListener('message', onMessage);
  window.addEventListener('resize', publishState);
  const stop = watch(() => !!backAction(), publishState, { flush: 'sync' });
  return () => {
    stop();
    reply = undefined;
    document.removeEventListener('songloft-back', onBack);
    document.removeEventListener('songloft-back-connect', nativeConnect);
    document.removeEventListener('songloft-back-request', nativeRequest);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('resize', publishState);
  };
}

/**
 * 通知宿主刷新收藏缓存（songloft-org/songloft-plugin-miot#86）。
 *
 * 我们只改了服务端数据，而 Flutter 侧曲库的红心读的是 `FavoriteNotifier` 的内存
 * 缓存，不推这一下就不会同步。
 *
 * ⚠️ **这个方法必须存在于 `common.js` 末尾那个 `window.SongloftPlugin` 字面量里。**
 * 上一版写的是 `SongloftPlugin?.invokeHost?.(...)`，而 `invokeHost` 当时只挂在
 * `window.__SongloftInternal`（内部句柄）、公开对象里并没有 —— 我们却在
 * `env.d.ts` 里自己声明了它，于是 TS 放行、运行时被可选调用**静默吞掉**，
 * 整个功能一个字节都没发出去。加宿主 API 前先去 `common.js` 核对那个字面量。
 *
 * 失败只吞掉：收藏本身已经成功了，不该因为缓存同步失败去打扰用户。
 */
export function notifyHostFavorite(songId: number, isFavorited: boolean): void {
  try {
    void window.SongloftPlugin?.favorite?.refresh?.(songId, isFavorited)?.catch(() => {});
  } catch {
    /* 老客户端没有 favorite 命名空间 */
  }
}

export const hostMode = reactive({ value: 'tab' as 'tab' | 'fullscreen' | 'browser' });

export function detectHostMode(): void {
  let available = false;
  try {
    available = !!window.SongloftPlugin?.host?.isAvailable?.();
  } catch {
    available = false;
  }
  if (!available) hostMode.value = 'browser';
  else if (document.documentElement.classList.contains('embed')) hostMode.value = 'fullscreen';
  else hostMode.value = 'tab';
  document.documentElement.classList.add(`miot-mode-${hostMode.value}`);
}
