// MIoT 智能音箱插件 - 在线歌曲搜索器
// 当本地索引找不到歌曲时，调用用户配置的外部搜索 API 搜索并推送到音箱

/// <reference types="@songloft/plugin-sdk" />

import { MinaService } from '../service/service';
import { getHostAPIBaseUrl, getHostBaseUrl } from '../utils/http';
import { URLBuilder, playbackOptionsOf } from '../player/url_builder';
import { ConfigManager } from '../config/manager';
import { IndexingManager } from '../indexing/manager';
import { GroupCoordinator } from '../group/coordinator';
import type { ExternalSearchSource, PlayMode } from '../types';
import type { PlaylistManager } from '../player/manager';

// 外部搜索 API 请求体
interface SearchOneRequest {
  keyword: string;
  hint?: { title?: string; artist?: string; duration?: number };
  quality?: string;
}

// 外部搜索 API 成功响应 data（provider 中立，不解读内部字段）
export interface OnlineSearchResult {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover_url?: string;
  url?: string;                                      // 直链型 provider 提供
  plugin_entry_path?: string;                        // provider 自身 entryPath；缺省纯外链
  source_data?: string | Record<string, unknown>;   // 不透明；对象则由 MIoT 序列化
  dedup_key?: string;
  lyric?: string;
  lyric_source?: string;
  /**
   * 可选：provider 返回的同批候选（topone 扩展，如 lxmusic 会带 top10）。
   * 自动连播优先从这里挑其他歌曲，避免为一首歌反复发搜索请求。
   */
  candidates?: OnlineSearchResult[];
}

// 外部搜索 API 响应
interface SearchOneResponse {
  code: number;
  msg: string;
  data: OnlineSearchResult | null;
}

// songloft /api/v1/songs/remote 请求体（provider 中立）
interface RemoteSongItem {
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  url: string;               // 直链型 provider 有；解析型为空
  plugin_entry_path: string; // provider 自身 entryPath；缺省 '' 表示纯外链
  source_data: string;
  dedup_key: string;
  lyric?: string;
  lyric_source?: string;
}

// songloft /api/v1/songs/remote 响应
interface RemoteSongsResponse {
  count: number;
  songs: Array<{
    id: number;
    type: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    url: string;
    cover_url: string;
    plugin_entry_path: string;
    source_data: string;
    dedup_key: string;
  }>;
}

/** 单次自动连播补充的歌曲数：补一次够播一阵，同时避免一次导入太多歌 */
const AUTO_CONTINUE_BATCH = 3;
/** 每次补充最多新发几条搜索：外部搜索单条超时可达 6s，不能无限试 */
const AUTO_CONTINUE_SEARCH_ATTEMPTS = 2;

/**
 * 一次「单曲播完自动连播」链路的上下文。
 * 由 startAutoContinue 创建，闭包持有的 PlaylistManager 队列播完时通过
 * queueRefillHook 回调取歌。
 */
interface AutoContinueState {
  pm: PlaylistManager;
  indexingManager?: IndexingManager;
  generation: number;          // 创建时的队列代数，换队列后旧链路自动失效
  title: string;
  artist: string;
  played: Set<string>;         // 本链路已入队歌曲的 title|artist 归一化键
  pending: OnlineSearchResult[]; // 原搜索响应附带的候选，优先消费
  queries: string[];           // 后续搜索的派生关键词，按顺序消耗
  active: boolean;
}

/**
 * 在线歌曲搜索器
 * 封装对用户配置的外部搜索 API（topone）的调用。
 * MIoT 作为中立消费方，不解读 source_data 内部结构，不写死任何插件名。
 */
export class OnlineSearcher {
  private configManager: ConfigManager;
  private groupCoordinator?: GroupCoordinator;

  constructor(configManager: ConfigManager, groupCoordinator?: GroupCoordinator) {
    this.configManager = configManager;
    this.groupCoordinator = groupCoordinator;
  }

  /**
   * 检查是否配置了外部搜索源（总开关开启且至少有一个启用且有 url 的源）
   */
  async isExternalSearchConfigured(): Promise<boolean> {
    const sources = await this.getEnabledSources();
    return sources.length > 0;
  }

  /**
   * 获取当前生效的外部搜索源列表（总开关关闭返回空；数组顺序即优先级）
   */
  private async getEnabledSources(): Promise<ExternalSearchSource[]> {
    const config = await this.configManager.getConfig();
    if (!config.external_search_enabled) return [];
    return config.external_search_sources.filter((s) => s.enabled && (s.url || '').trim() !== '');
  }

  /**
   * 解析单个源的完整地址
   * 支持两种输入：
   * 1. 完整 URL（以 http:// 或 https:// 开头）直接返回
   * 2. 相对路径（以 / 开头）拼接宿主 loopback 地址（调用其他已安装插件）
   */
  private async resolveSourceUrl(source: ExternalSearchSource): Promise<string> {
    const searchUrl = (source.url || '').trim();
    if (!searchUrl) return '';
    if (searchUrl.startsWith('http://') || searchUrl.startsWith('https://')) {
      return searchUrl;
    }
    // 相对路径 = 内部插件/宿主接口，走 loopback API 地址（避免 hairpin NAT）
    const host = await getHostAPIBaseUrl();
    return host + searchUrl;
  }

  /**
   * 解析单个源的认证 Token
   * 源自定义的 token 优先，否则使用插件 token
   */
  private async resolveSourceToken(source: ExternalSearchSource): Promise<string> {
    const userToken = (source.token || '').trim();
    if (userToken) {
      return userToken;
    }
    const pluginToken = await songloft.plugin.getToken();
    return `Bearer ${pluginToken}`;
  }

  /**
   * 判断直链是否音箱可直接播放。音箱（player_play_url）只可靠播放 mp3；
   * webm/opus/ogg/flac/mka/mkv/m4a/wav 等需经 songloft 转码代理（/proxy/transcode）。
   * 判据：URL 的 mime 查询参数（youtube CDN 带 mime=audio/webm）优先，否则看扩展名。
   */
  private isSpeakerPlayableUrl(rawUrl: string): boolean {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return false;
    }
    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    if (mime === 'audio/mpeg' || mime === 'audio/mp3') return true;
    if (mime.startsWith('audio/')) return false; // webm/opus/ogg/flac/mp4/aac/mka 等
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    return ext === 'mp3'; // 无 mime（如 go-music-dl 的 .mp3 直链）→ 仅 .mp3 直推
  }

  /**
   * 解析 no-import 直推 URL：可直接播的原样返回；不可播的构造 songloft 转码代理 URL
   * （/api/v1/proxy/transcode，服务端 ffmpeg 实时转 mp3 流式返回，不入库不落盘）。
   *
   * access_token 必须是首个查询参数——部分音箱固件会把 URL 里的 & 替换为空格，
   * 导致后续参数被合并进 token 值（见 url_builder.ts 同款处理）。URLSearchParams
   * 按 set 顺序输出，故先 set access_token。url 值会被自动 percent-encode，
   * youtube 直链里的 & 不会污染参数分隔。
   */
  private async resolveDirectPushUrl(directUrl: string, duration?: number): Promise<string> {
    if (this.isSpeakerPlayableUrl(directUrl)) return directUrl;
    const base = await getHostBaseUrl(); // 音箱可达地址（server_host），非 loopback 的 getHostAPIBaseUrl
    if (!base) {
      // server_host 未配：无法构造转码 URL，回退原样（大概率播不出，但不构造坏 URL）
      songloft.log.warn('[OnlineSearcher] server_host 未配置，无法走转码代理，原样直推（可能无法解码）');
      return directUrl;
    }
    const token = await songloft.plugin.getToken();
    const params = new URLSearchParams();
    params.set('access_token', token); // 必须第一
    params.set('url', directUrl);
    params.set('format', 'mp3');
    if (duration && duration > 0) params.set('duration', String(duration));
    return `${base}/api/v1/proxy/transcode?${params.toString()}`;
  }

  /**
   * 在线搜索歌曲：并发向所有启用源派发请求，但严格按列表顺序采纳结果
   * （源0 命中即用源0，否则看源1……）。仅返回候选，不导入也不播放。
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @returns 搜索候选，全部未命中或请求失败返回 null
   */
  async search(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
  ): Promise<OnlineSearchResult | null> {
    const sources = await this.getEnabledSources();
    if (sources.length === 0) return null;

    const config = await this.configManager.getConfig();
    const timeoutSec = config.external_search_timeout > 0 ? config.external_search_timeout : 6;
    const timeoutMs = timeoutSec * 1000;

    // 立即并发派发所有源；searchOne 内部 catch，绝不 reject
    const tasks = sources.map((s) => this.searchOne(s, keyword, hint, timeoutMs));

    // 按优先级顺序消费：命中即返回（只等到该源），未命中再看下一个
    for (let i = 0; i < tasks.length; i++) {
      const r = await tasks[i];
      if (r) {
        songloft.log.info(`[OnlineSearcher] Hit from source[${i}] "${sources[i].name || sources[i].url}" for keyword: ${keyword}`);
        return r;
      }
    }
    songloft.log.warn('[OnlineSearcher] No source matched for keyword: ' + keyword);
    return null;
  }

  /**
   * 向单个源发起一次搜索。内部处理超时/网络错/解析失败，全部返回 null，绝不 reject。
   */
  private async searchOne(
    source: ExternalSearchSource,
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    timeoutMs: number,
  ): Promise<OnlineSearchResult | null> {
    const reqBody: SearchOneRequest = {
      keyword,
      hint: hint || undefined,
      quality: '320k',
    };

    let resp: SearchOneResponse | null = null;

    // 带超时的 fetch（用 Promise.race 替代 AbortController，兼容 QuickJS）
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AbortError')), timeoutMs);
    });

    try {
      const baseUrl = await this.resolveSourceUrl(source);
      if (!baseUrl) return null;
      const authToken = await this.resolveSourceToken(source);
      songloft.log.info('[OnlineSearcher] [Diag] Request POST ' + baseUrl + ' body=' + JSON.stringify(reqBody));
      const fetchPromise = fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authToken },
        body: JSON.stringify(reqBody),
      });
      const fetchResp = await Promise.race([fetchPromise, timeoutPromise]);

      const text = await fetchResp.text();
      songloft.log.info('[OnlineSearcher] [Diag] Response status=' + fetchResp.status + ' body=' + text);
      try {
        resp = JSON.parse(text) as SearchOneResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse search/topone response: ' + text);
        return null;
      }
    } catch (e: any) {
      if (e.message === 'AbortError') {
        songloft.log.warn(`[OnlineSearcher] Search/topone timeout (>${timeoutMs / 1000}s) for source "${source.name || source.url}" keyword: ` + keyword);
      } else {
        songloft.log.warn('[OnlineSearcher] Search/topone fetch error: ' + String(e));
      }
      return null;
    }

    // 解析响应
    if (!resp || resp.code !== 0 || !resp.data) {
      songloft.log.warn('[OnlineSearcher] Search/topone returned code=' + (resp?.code ?? 'null') + ' for keyword: ' + keyword);
      return null;
    }

    return resp.data;
  }

  /**
   * 将外部搜索候选导入到 Songloft，并推送到音箱播放。
   */
  async playSearchResult(
    song: OnlineSearchResult,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
    indexingManager?: IndexingManager,
    pm?: PlaylistManager,
  ): Promise<boolean> {
    const config = await this.configManager.getConfig();

    // 不入库直接播放：仅对「直链型」结果生效（song.url 是 http(s) 直链）。
    // 临时链接（签名 CDN 直链）入库后很快失效、堆成死条目，此模式趁链接新鲜时把原始 URL
    // 直接推给音箱（底层 player_play_url），跳过入库/追加歌单/加索引。
    // 解析型结果（url 为空、靠 plugin_entry_path 让宿主运行时解析）无法脱离曲库播放，回退到入库。
    const directUrl = (song.url || '').trim();
    const isDirectLink = directUrl.startsWith('http://') || directUrl.startsWith('https://');
    if (config.external_search_no_import) {
      if (isDirectLink) {
        // 音箱只可靠播放 mp3；webm/opus 等不可解码格式走 songloft 转码代理（songloft-org/songloft#394）
        const pushUrl = await this.resolveDirectPushUrl(directUrl, song.duration);
        const transcoded = pushUrl !== directUrl;
        const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
        songloft.log.info('[OnlineSearcher] [Diag] No-import direct push: songName="' + songName + '" url="' + pushUrl + '"' + (transcoded ? ' (transcoded)' : ''));
        const played = await minaService.playURL(accountId, deviceId, pushUrl, {
          title: song.title,
          artist: song.artist,
        });
        if (!played) {
          songloft.log.error('[OnlineSearcher] No-import: failed to push URL to device: ' + pushUrl);
          return false;
        }
        // 分组同步：让组内其他成员播放同一 URL
        await this.groupCoordinator?.fanOutPlayURL(accountId, deviceId, pushUrl, {
          title: song.title,
          artist: song.artist,
        });
        songloft.log.info('[OnlineSearcher] Playing online song (no-import)' + (transcoded ? ' [transcoded]' : '') + ': ' + song.title + ' - ' + song.artist + ' url=' + pushUrl);
        return true;
      }
      songloft.log.info('[OnlineSearcher] No-import enabled but result is resolution-type (no direct url), falling back to import: ' + song.title);
    }

    // 同步导入到 songloft 数据库，直接拿到 songloft 分配的 id 和 url
    const imported = await this.importSong(song);
    if (!imported) {
      songloft.log.error('[OnlineSearcher] Failed to import song, cannot play: ' + song.title);
      return false;
    }

    // 入库后追加到目标歌单（可选，由配置决定）
    const pid = config.external_search_playlist_id;
    let appendedPlaylistId: number | undefined;
    if (pid) {
      try {
        const plToken = await songloft.plugin.getToken();
        const apiBase = await getHostAPIBaseUrl();
        await fetch(`${apiBase}/api/v1/playlists/${pid}/songs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plToken}` },
          body: JSON.stringify({ song_ids: [imported.id] }),
        });
        const pidNum = Number(pid);
        if (!Number.isNaN(pidNum)) appendedPlaylistId = pidNum;
      } catch (e) { songloft.log.warn(`[OnlineSearcher] 追加歌单失败: ${String(e)}`); }
    }

    // 已追加到目标歌单且提供了播放管理器：接管为完整歌单播放，从这首新歌
    // 开始，播完后由 PlaylistManager 的切歌定时器自动续播歌单其余歌曲。
    // （直接 playURL 单曲推送不会注册切歌定时器，播完即停，见 issue #53）
    if (pm && appendedPlaylistId !== undefined) {
      let playMode: PlayMode = 'loop';
      try {
        const devices = await this.configManager.getDevices(accountId);
        const devCfg = devices.find((d) => d.device_id === deviceId);
        if (devCfg && devCfg.play_mode) playMode = devCfg.play_mode as PlayMode;
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] Failed to read play mode, fallback to loop: ' + String(e));
      }

      const ok = await pm.playPlaylistFromSong(appendedPlaylistId, imported.id, playMode);
      if (ok) {
        // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
        if (indexingManager) {
          indexingManager.addImportedSong(
            { id: imported.id, title: song.title, artist: song.artist, album: song.album },
            appendedPlaylistId,
          );
        }
        songloft.log.info(`[OnlineSearcher] Playing online song via playlist ${appendedPlaylistId} (auto-continue): ${song.title} - ${song.artist}`);
        return true;
      }
      songloft.log.warn(`[OnlineSearcher] Playlist takeover failed for playlist ${appendedPlaylistId}, falling back to single URL push`);
    }

    // 未配置目标歌单：同样交给 PlaylistManager，以「单曲临时列表 + order 模式」播放。
    // 不能直接 playURL——那条路径不注册切歌定时器/结束探测，音箱自然播完后会重拉
    // 同一 URL，表现为单曲无限循环（#437 同类问题）。order 模式单曲列表没有下一首，
    // onSongFinished 会走 stop()，播完即停。
    if (pm) {
      const playable = await this.buildStandaloneSong(imported, song);
      const ok = await pm.playWithSongs([playable], 0, 'order', `单曲: ${song.title}`, '');
      if (ok) {
        // 增量把这首独立远程歌曲加入内存索引，避免下一次点播再次走外部搜索。
        if (indexingManager) {
          indexingManager.addImportedSong(
            { id: imported.id, title: song.title, artist: song.artist, album: song.album },
            undefined,
          );
        }
        songloft.log.info('[OnlineSearcher] Playing online song via standalone playlist (order, stop at end): ' + song.title + ' - ' + song.artist);
        // 配置开启「播完自动连播」时，后台预取其他网络歌曲追加到临时队列。
        // 不 await：预取失败/慢都不该影响这首种子歌的起播。
        void this.startAutoContinue(pm, {
          title: song.title,
          artist: song.artist || '',
          id: imported.id,
          candidates: song.candidates,
        }, indexingManager).catch((e) => {
          songloft.log.warn('[OnlineSearcher] Failed to start auto-continue: ' + String(e));
        });
        return true;
      }
      songloft.log.warn('[OnlineSearcher] Standalone playlist takeover failed, falling back to direct URL push');
    }

    // 用返回的 url 构造完整播放 URL（相对路径，URLBuilder 会拼接 server_host 和 token）。
    // 必须带上 force_mp3 / volume_normalize：直推路径漏了这些选项时，音箱会拿到不能解码的
    // 源格式流而亮灯不出声（songloft-org/songloft-plugin-miot#62）。
    const playUrl = await URLBuilder.buildSongURL({ id: imported.id, url: imported.url }, playbackOptionsOf(config));
    if (!playUrl) {
      songloft.log.error('[OnlineSearcher] Failed to build URL for song id=' + imported.id);
      return false;
    }

    // 推送 URL 到音箱（传「歌名-歌手」供触屏歌词模式匹配曲库）
    const songName = song.artist ? `${song.title}-${song.artist}` : song.title;
    songloft.log.info('[OnlineSearcher] [Diag] Push to device: songName="' + songName + '" importedUrl="' + imported.url + '" playUrl="' + playUrl + '"');
    const played = await minaService.playURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });
    if (!played) {
      songloft.log.error('[OnlineSearcher] Failed to push URL to device: ' + playUrl);
      return false;
    }

    // 分组同步：让组内其他成员播放同一 URL
    await this.groupCoordinator?.fanOutPlayURL(accountId, deviceId, playUrl, {
      title: song.title,
      artist: song.artist,
    });

    // 增量把这首独立远程歌曲加入内存索引，避免为一首歌重建全部歌单缓存。
    if (indexingManager) {
      indexingManager.addImportedSong(
        { id: imported.id, title: song.title, artist: song.artist, album: song.album },
        appendedPlaylistId,
      );
    }

    songloft.log.info('[OnlineSearcher] Playing online song: ' + song.title + ' - ' + song.artist + ' url=' + playUrl);
    return true;
  }

  /**
   * 构造供 PlaylistManager 播放的单曲对象。
   * 优先从宿主读取完整歌曲（含 type/duration/封面等），失败时用导入响应和搜索结果兜底。
   */
  private async buildStandaloneSong(
    imported: { id: number; url: string },
    song: OnlineSearchResult,
  ): Promise<any> {
    try {
      const full = await songloft.songs.getById(imported.id);
      if (full) return full;
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Failed to load imported song, using fallback fields: ' + String(e));
    }
    return {
      id: imported.id,
      type: 'remote',
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      duration: song.duration || 0,
      file_path: '',
      url: imported.url,
      cover_path: '',
      cover_url: song.cover_url || '',
      lyric_url: '',
      file_size: 0,
      format: '',
      bit_rate: 0,
      sample_rate: 0,
      is_live: false,
      cache_hash: '',
    };
  }

  /**
   * 启动「单曲播完自动连播」链路。
   *
   * 仅当配置开启 external_search_auto_continue、外部搜索已启用且不是「不入库直接播放」时生效。
   * 链路把后续网络歌曲追加到 PlaylistManager 当前的临时队列末尾：
   * - 队列剩不到 2 首时提前补充，把搜索/导入耗时藏在正在播放的歌里；
   * - 队列真播完时再等一次补充，仍没有新歌才停播；
   * - 用户切歌单/重新点播后队列代数变化，旧链路自动失效，不会往新队列里塞歌。
   *
   * 歌源优先级：原搜索响应的 candidates → 按歌手派生的关键词再搜索 → 曲库里已导入的网络歌曲。
   *
   * 不阻塞调用方：本方法立即返回，预取在后台进行。
   */
  async startAutoContinue(
    pm: PlaylistManager,
    seed: { title: string; artist?: string; id?: number; candidates?: OnlineSearchResult[] },
    indexingManager?: IndexingManager,
  ): Promise<void> {
    const config = await this.configManager.getConfig();
    if (!config.external_search_enabled || !config.external_search_auto_continue) return;
    if (config.external_search_no_import) {
      songloft.log.info('[OnlineSearcher] 自动连播已开启，但「不入库直接播放」不支持续播，跳过');
      return;
    }
    if (!(await this.isExternalSearchConfigured())) return;

    const state: AutoContinueState = {
      pm,
      indexingManager,
      generation: pm.getQueueGeneration(),
      title: seed.title || '',
      artist: seed.artist || '',
      played: new Set([this.songKey(seed.title, seed.artist)]),
      pending: (Array.isArray(seed.candidates) ? seed.candidates : [])
        .filter((c) => !!c && !!c.title && !this.isSameSong(c, seed)),
      queries: this.buildAutoContinueQueries(seed.title, seed.artist),
      active: true,
    };

    const hook = async (): Promise<any[] | null> => {
      if (!state.active) return null;
      if (pm.getQueueGeneration() !== state.generation) {
        state.active = false;
        pm.setQueueRefillHook(undefined);
        return null;
      }

      // 每次补充都重新读配置：用户中途关掉开关应立刻停止续播
      const latest = await this.configManager.getConfig();
      if (!latest.external_search_enabled || !latest.external_search_auto_continue || latest.external_search_no_import) {
        state.active = false;
        pm.setQueueRefillHook(undefined);
        return null;
      }

      const songs = await this.fetchAutoContinueSongs(state);
      if (songs.length === 0) {
        state.active = false;
        pm.setQueueRefillHook(undefined);
        songloft.log.info('[OnlineSearcher] 自动连播没有更多可播放的网络歌曲，结束');
        return null;
      }
      songloft.log.info(`[OnlineSearcher] 自动连播补充 ${songs.length} 首: ${songs.map((s) => s.title).join(' / ')}`);
      return songs;
    };

    pm.setQueueRefillHook(hook);
    songloft.log.info(`[OnlineSearcher] 自动连播已启用: seed="${seed.title} - ${seed.artist || ''}" 候选=${state.pending.length}`);

    // 立即预取首批：种子歌曲一般还有几分钟，足够完成搜索和导入
    void pm.replenishQueue(true).catch((e) => {
      songloft.log.warn('[OnlineSearcher] 自动连播预取失败: ' + String(e));
    });
  }

  /** 取一批后续网络歌曲（最多 AUTO_CONTINUE_BATCH 首），按歌源优先级依次尝试。 */
  private async fetchAutoContinueSongs(state: AutoContinueState): Promise<any[]> {
    const songs: any[] = [];
    const queuedIds = new Set<number>();
    for (const s of state.pm.getSongs()) {
      if (s && s.id > 0) queuedIds.add(s.id);
    }

    const push = (song: any | null): void => {
      if (!song || songs.length >= AUTO_CONTINUE_BATCH) return;
      if (!(song.id > 0) || queuedIds.has(song.id)) return;
      queuedIds.add(song.id);
      state.played.add(this.songKey(song.title, song.artist));
      songs.push(song);
    };

    // 1) 原搜索响应附带的同批候选（provider 支持时最省事，也最接近用户点的歌）
    while (state.pending.length > 0 && songs.length < AUTO_CONTINUE_BATCH) {
      const candidate = state.pending.shift()!;
      push(await this.importAutoContinueCandidate(state, candidate, queuedIds));
    }

    // 2) 按歌手/歌名派生关键词再搜。每次最多试两条，避免一次补充耗时过长。
    let attempts = 0;
    while (state.queries.length > 0 && songs.length < AUTO_CONTINUE_BATCH && attempts < AUTO_CONTINUE_SEARCH_ATTEMPTS) {
      const query = state.queries.shift()!;
      attempts++;
      const result = await this.search(query, null);
      if (!result) continue;
      const pool = [result, ...(Array.isArray(result.candidates) ? result.candidates : [])];
      for (const candidate of pool) {
        if (songs.length >= AUTO_CONTINUE_BATCH) break;
        push(await this.importAutoContinueCandidate(state, candidate, queuedIds));
      }
    }

    // 3) 外部搜索没给出新歌时，从曲库里已导入的网络歌曲兜底（不产生新的外部请求）
    if (songs.length < AUTO_CONTINUE_BATCH) {
      for (const song of await this.findLibraryRemoteSongs(state)) {
        if (songs.length >= AUTO_CONTINUE_BATCH) break;
        push(song);
      }
    }

    return songs;
  }

  /**
   * 导入一首自动连播候选并转成 PlaylistManager 可播放的完整歌曲对象。
   * 已在本链路播过或已在队列里的歌直接跳过。
   */
  private async importAutoContinueCandidate(
    state: AutoContinueState,
    candidate: OnlineSearchResult,
    queuedIds: Set<number>,
  ): Promise<any | null> {
    if (!candidate || !candidate.title) return null;
    const key = this.songKey(candidate.title, candidate.artist);
    if (state.played.has(key)) return null;

    const imported = await this.importSong(candidate);
    if (!imported) return null;
    if (queuedIds.has(imported.id)) {
      songloft.log.info(`[OnlineSearcher] 自动连播跳过队列已有歌曲: ${candidate.title}`);
      return null;
    }

    const playable = await this.buildStandaloneSong(imported, candidate);
    if (!playable) return null;

    state.played.add(key);
    if (state.indexingManager) {
      state.indexingManager.addImportedSong(
        { id: imported.id, title: candidate.title, artist: candidate.artist, album: candidate.album },
        undefined,
      );
    }
    songloft.log.info(`[OnlineSearcher] 自动连播加入: ${candidate.title} - ${candidate.artist || ''} id=${imported.id}`);
    return playable;
  }

  /** 从曲库里找同歌手/同名的其他网络歌曲，作为外部搜索无新歌时的兜底。 */
  private async findLibraryRemoteSongs(state: AutoContinueState): Promise<any[]> {
    const queries = [state.artist, state.title].filter((q) => !!q);
    const out: any[] = [];
    for (const query of queries) {
      try {
        const result = await songloft.songs.search(query);
        for (const song of result || []) {
          if (out.length >= AUTO_CONTINUE_BATCH) break;
          if (!song || song.type !== 'remote' || !song.url) continue;
          if (state.played.has(this.songKey(song.title, song.artist))) continue;
          out.push(song);
        }
      } catch (e) {
        songloft.log.warn('[OnlineSearcher] 自动连播查询曲库失败: ' + String(e));
      }
      if (out.length >= AUTO_CONTINUE_BATCH) break;
    }
    return out;
  }

  /** 派生自动连播搜索词：优先同歌手，其次相似歌曲，最后用泛化热门词兜底。 */
  private buildAutoContinueQueries(title: string, artist?: string): string[] {
    const queries: string[] = [];
    const a = (artist || '').trim();
    const t = (title || '').trim();
    if (a) {
      queries.push(a, `${a} 热门`, `${a} 歌曲`, `${a} 经典`);
    }
    if (t) {
      queries.push(`${t} 相似歌曲`);
    }
    queries.push('热门歌曲', '经典歌曲', '华语流行', '轻音乐');
    return Array.from(new Set(queries.filter((q) => !!q)));
  }

  /** 归一化歌曲键：忽略空白、括号、连接符和大小写，用于链路内去重。 */
  private songKey(title?: string, artist?: string): string {
    const norm = (v: string): string => (v || '').toLowerCase().replace(/[\s\-_/\\()（）[\]【】·.,，。!！?？'"“”‘’]/g, '');
    return `${norm(title || '')}|${norm(artist || '')}`;
  }

  private isSameSong(a: { title?: string; artist?: string }, b: { title?: string; artist?: string }): boolean {
    return this.songKey(a.title, a.artist) === this.songKey(b.title, b.artist);
  }

  /**
   * 在线搜索歌曲并推送到音箱播放，同时导入到本地数据库
   *
   * @param keyword       搜索关键词
   * @param hint         可选的歌曲提示（title/artist/duration）
   * @param accountId    平台账号ID
   * @param deviceId     设备ID
   * @param minaService  MinaService 实例（用于推送URL）
   * @returns 是否成功推送播放
   */
  async searchAndPlay(
    keyword: string,
    hint: { title: string; artist?: string; duration?: number } | null,
    accountId: string,
    deviceId: string,
    minaService: MinaService,
  ): Promise<boolean> {
    const song = await this.search(keyword, hint);
    if (!song) {
      return false;
    }
    return await this.playSearchResult(song, accountId, deviceId, minaService);
  }

  /**
   * 导入歌曲到 songloft 数据库
   * @returns 导入成功后包含歌曲 id 和 url 的对象，失败返回 null
   */
  private async importSong(song: OnlineSearchResult): Promise<{ id: number; url: string } | null> {
    // provider 字段原样映射，不解读、不补插件名
    const remoteItem: RemoteSongItem = {
      title: song.title,
      artist: song.artist || '',
      album: song.album || '',
      cover_url: song.cover_url || '',
      duration: song.duration || 0,
      url: song.url || '',                              // 直链型 provider 有；解析型为空
      plugin_entry_path: song.plugin_entry_path || '',  // 中立缺省 ''，绝不写死任何插件名
      source_data: typeof song.source_data === 'string'
        ? song.source_data
        : (song.source_data ? JSON.stringify(song.source_data) : ''),   // 对象则序列化，不窥内部
      dedup_key: song.dedup_key || '',
      lyric: song.lyric || '',
      lyric_source: song.lyric_source || '',
    };

    try {
      const pluginToken = await songloft.plugin.getToken();
      const serverHost = await getHostAPIBaseUrl();
      const fetchResp = await fetch(serverHost + '/api/v1/songs/remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pluginToken}` },
        body: JSON.stringify([remoteItem]),
      });
      const text = await fetchResp.text();
      let result: RemoteSongsResponse;
      try {
        result = JSON.parse(text) as RemoteSongsResponse;
      } catch {
        songloft.log.warn('[OnlineSearcher] Failed to parse remote songs response: ' + text);
        // 导入失败（可能是 UNIQUE 约束冲突），尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      if (!result.songs || result.songs.length === 0) {
        songloft.log.warn('[OnlineSearcher] Remote import returned no songs: ' + text);
        // 导入失败，尝试查找已存在的歌曲
        return await this.findExistingSong(song.title, song.artist);
      }

      const imported = result.songs[0];
      songloft.log.info('[OnlineSearcher] Import success: ' + song.title + ' - ' + song.artist + ', songloft id=' + imported.id);
      return { id: imported.id, url: imported.url };
    } catch (e: any) {
      songloft.log.warn('[OnlineSearcher] Remote import fetch error: ' + String(e));
      return null;
    }
  }

  /**
   * 在 Songloft 数据库中查找已存在的外部导入歌曲
   * 当 /api/v1/songs/remote 因唯一键约束冲突等无法重复导入时作为回退
   */
  private async findExistingSong(title: string, artist: string): Promise<{ id: number; url: string } | null> {
    try {
      let songLimit = 10000;
      try {
        const cfg = await this.configManager.getConfig();
        songLimit = Math.max(1000, Math.min(100000, cfg.max_song_index ?? 10000));
      } catch {}
      const allSongs = await songloft.songs.list({ limit: songLimit });
      const match = allSongs.find(s =>
        s.title === title &&
        s.artist === artist &&
        (s.type === 'remote' || s.url?.startsWith('http'))
      );
      if (match && match.id && match.url) {
        songloft.log.info('[OnlineSearcher] Found existing remote song: ' + title + ' - ' + artist + ', id=' + match.id);
        return { id: match.id, url: match.url };
      }
    } catch (e) {
      songloft.log.warn('[OnlineSearcher] Failed to search existing songs: ' + String(e));
    }
    return null;
  }
}
