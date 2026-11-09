# mi-song-gpt 部署与使用指南

> 基于 songloft-plugin-miot 的定制版：在音乐播放能力之上，新增**问答接管**——
> 播放类指令走本地音乐，其他问题小爱能答的不打扰、答不上来由大模型接管（可联网搜索）。
> 合并后 **migpt-next 容器不再需要**，只跑 songloft 一个服务。

## 语音指令的完整决策链

```
你说话
  ├─ ① 固定口令（切歌/音量/停止/定时/收藏…）        → 立即执行（零延迟，不花钱）
  ├─ ② 语音记忆（之前播过的说法）                    → 直接重播
  ├─ ③ 搜索口令（"播放XX" / "我想听XX"）             → 本地曲库/外部搜索 → 推流播放
  ├─ ④ AI 语义判定（qwen-flash 等小模型，低温）
  │      ├─ 播放类（歌名/歌手/歌单/翻唱…）           → 搜索并播放
  │      └─ 非播放类（qa）                            → 进入 ⑤
  └─ ⑤ 问答接管
         ├─ 等小爱原生回答（≤4s），回答有效           → 不打扰，小爱自己答
         └─ 命中兜底话术（"不知道/没听懂/没找到…"）
            或超时无回答                              → 打断小爱 → 播"正在思考，请稍等"
                                                        → 问答大模型（可联网）→ TTS 播报
                                                        → 记入对话历史（下次可追问）
```

## 一、构建产物

- 本仓库构建产物：`dist/mi-song-gpt.jsplugin.zip`（已构建好，直接用）
- 以后改了代码要重新构建：`npm install && npm run build`

## 二、安装插件（NAS 上操作）

1. 打开 songloft 网页（`http://NAS_IP:58091`）→ 插件页面
2. 无需卸载官方"智能音箱"(miot)——本插件 entryPath 为 `mi-song-gpt`，与官方 `miot` **可共存**
3. 上传 `dist/mi-song-gpt.jsplugin.zip` 安装
4. 安装后确认插件名为「mi-song-gpt」，版本 `2026.11.9.2`

> 本独立维护分支的 `plugin.json` 带有 `updateUrl`，指向 [gyyst/mi-song-gpt](https://github.com/gyyst/mi-song-gpt) main 分支：Songloft 会从本仓库检查更新，不会跟随上游。首次从上游版本切换过来需要手动上传一次本仓库的 zip，之后即可在插件页直接更新。

## 三、配置（插件设置页 →「语音」标签）

按顺序确认以下四张卡片：

| 卡片 | 配置 | 说明 |
|---|---|---|
| 对话监听 | 开启；轮询间隔 1 秒 | 设备设置里确认音箱已勾选"启用管理" |
| 语音口令 | 开启 | 固定口令与搜索口令（原功能，不变） |
| AI 口令分析 | 开启；填小模型 | **语义判定**：glm-4-flash / qwen-flash / doubao-2.1-mini 等快而便宜的模型 |
| 问答接管 | 开启；填强模型 | **问答**：火山方舟 `https://ark.cn-beijing.volces.com/api/v3` + 模型名（如 doubao-1.5-pro-32k） |

「问答接管」卡片的关键项：

- **API 地址/Key/模型**：问答用的强模型，与上面的判定模型可各配各的服务商
- **联网搜索**：开启后走火山方舟 Responses API 的 `web_search` 工具
  （需在[火山方舟控制台](https://console.volcengine.com/ark)开通「联网搜索」内容插件）
- **搜索策略**：`按需联网（推荐）` = 只在问到天气/新闻/股价等时效性话题时联网；`全部联网` = 每次问答都联网
- **思考提示**：打断小爱后先播的占位话（如"正在思考，请稍等"），留空关闭
- **等待原生回答（秒）**：先等小爱答（默认 4 秒），命中"不知道/没听懂/没找到"类回答才接管；设 0 则不等直接接管
- **历史轮数**：每台音箱保留的对话轮数（默认 10），支持"再讲细一点"这类追问
- **单段播报上限**：长回答按句切分逐段播报（默认 100 字，与音箱 TTS 限制匹配）
- **用户记忆**：开启后自动记录对话历史、提取事实与偏好（如"用户住在北京"），问答时注入上下文实现追问与个性化；同类问题问满 4 次自动生成话题画像（如"用户经常询问：A股指数行情（近30天4次）"）

配置页自带两个测试按钮（不打断音箱）：

- **AI 分析测试**（AI 口令分析卡片）：输入一句话，看判定出的动作/参数/置信度
- **问答测试**（问答接管卡片）：直接验证问答模型与联网搜索是否正常

## 四、停用 migpt-next 容器（重要！）

问答接管已完全替代 migpt-next 的功能，**两套同时跑会互相抢话**：

```bash
docker stop migpt-next        # 容器名以实际为准（docker ps 查看）
docker rm migpt-next          # 确认无误后可删除容器
```

docker-compose 用户把对应 service 注释掉后 `docker compose up -d`。

## 五、验收清单

对着音箱测试（正在播音乐时测问答场景更真实）：

| 你说 | 期望行为 |
|---|---|
| 播放周杰伦的晴天 | 本地搜歌推流（和以前一样） |
| 下一首 / 音量调到30 / 半小时后停止 | 固定口令立即执行 |
| 你叫什么名字 | 小爱原生回答（不被打断） |
| 地球为什么是圆的 | 小爱答不上 → "正在思考" → 大模型回答 |
| 今天北京天气怎么样 | 大模型联网搜索后回答（方舟需开通联网插件） |
| 刚才再说详细一点 | 带上下文追问（历史生效） |

## 六、改动清单（相对官方 songloft-plugin-miot v2026.11.9.1 / 1379528）

> 历史说明：本仓库已重建为官方仓库的 fork（共享 git 祖先）。下表的定制来自 wyrt000/mi-song-gpt v2026.10.14，并已叠加到官方 2026.11.9.1 基线；官方后续更新用 `scripts/sync-upstream.sh` 合入，不必再手工“重新套用”。

| 文件 | 改动 |
|---|---|
| `src/voicecmd/qa_fallback.ts` | **新增**：问答接管模块（兜底话术判定/等待原生回答/打断+占位/LLM+联网/历史/分段TTS）；兜底话术持续扩充（盲区/加紧学习等小爱新话术） |
| `src/chat/memory.ts` / `src/handlers/chat.ts` | **新增**：账号级用户记忆——对话历史、摘要（≥8 轮重建）、长期记忆自动提取（事实与偏好，手工编辑不覆盖）；**频繁话题画像**：保留期内同类问题问满 4 次自动聚合成一条画像记忆（LLM 命名标签，随历史衰减自动回收） |
| `frontend/src/views/settings/VoiceSettings.vue` | 记忆管理面板（对话历史分页/长期记忆增删改/10s 静默自动刷新）；对话监听 WS 超时看门狗：连接在线但 15s 无帧自动降级 4s HTTP 轮询，收到帧恢复推送 |
| `src/voicecmd/ai_analyzer.ts` | **判定 prompt 精简**：示例与冗余删除（1927 vs 上游 2730 字符，约省 1/3 输入）；prompt 含 `qa` 动作判定示例。temperature/max_tokens 保持上游语义「省略」（推理模型/代理兼容，上游测试强制） |
| `src/music/service.ts` | 上游把 `voicecmd/engine.ts` 重构成转发到本文件；QA 兜底全部移植到这里：未命中分支接入问答接管；`processMessage` 回填 `outcome/outcome_detail/outcome_meta` 并调 `notifyConversationOutcome()` 补推 WS；AI 判定为 `qa` 时走问答、`deferResume` 时交派发器恢复；口令测试对 qa 指令只做诊断；`testQA`/`isQAEnabled`；默认播放模式 order→loop 两处 |
| `src/voicecmd/engine.ts` | 上游已改为 3 行兼容转发（`MusicCommandService` 从 `music/service` 导出），本定制沿用 |
| `src/ws/conversation-stream.ts` | **新增** `notifyConversationOutcome()`：outcome 晚于消息帧到达时按 id 补推（前端 upsert 替换） |
| `src/conversation/viewmodel.ts` | 对话记录视图透传 outcome/outcome_detail/outcome_meta |
| `frontend/src/store.ts` / `VoiceSettings.vue` | 最近对话记录所有入口（WS 快照/增量、HTTP 轮询）统一降序排序 + 按 id upsert（outcome 补推帧替换原条目、不产生重复、到达顺序不影响展示） |
| `src/handlers/config.ts` | `/config` GET/POST 支持 `qa_config` |
| `src/handlers/voice_command.ts` | 新增 `POST /voice-commands/qa-test`；`said` 端点返回处理来源 outcome |
| `src/service/service.ts` | 新增 `getLatestAsk`（读云端对话记录） |
| `src/utils/ai_url.ts` | 新增 `aiResponsesUrl`（方舟 Responses 端点） |
| `src/types.ts` / `src/config/manager.ts` | 新增 `QAConfig`/`VoiceOutcome` 类型与 `qa_config` 独立存储键 |
| `frontend/src/views/settings/VoiceSettings.vue` 等 | 上游 4 面板语音设置中「commands」面板内嵌问答接管卡与问答测试；对话监听状态栏新增「AI判定/问答接管」状态 chips；最近对话记录每条标注来源徽标+耗时，并新增判定反馈/分阶段耗时 meta 行 |
| `plugin.json` | 名称保持 mi-song-gpt；entryPath 保持 `mi-song-gpt`（与官方 miot 共存，已有安装/配置可平滑切换）；版本 2026.11.9.2；`updateUrl` 指向本仓库 main；author 改为 wyrt0 / gyyst、homepage 指向本仓库；download_url 钉到本仓库 `releases/download/v2026.11.9.2/mi-song-gpt.jsplugin.zip`；保留上游 `publicPaths: ["/dlna"]`、renderEngine webview |
| `package.json` | name/description 为独立分支标识，scripts 沿用上游并新增 `typecheck` / `test` / `postbuild` 哈希同步 |
| `src/account/manager.ts` / `src/player/manager.ts` 等 | 默认播放模式由「顺序播放」改为「列表循环」：新设备默认值、`normalizePlayMode` 兜底、`playMode` 初始值，以及定时任务 / 语音口令 / 联网搜歌 / 设备列表 / 前端各处兜底统一为 `loop`（模式弹层高亮改为「非列表循环才高亮」） |
| `src/config/manager.ts` / `src/main.ts` | **新增** `migratePlayModeDefaultOnce()` 一次性迁移：把存量设备落盘的 `play_mode` 从 order 翻成 loop（`play_mode_default_migrated` 标志位，只执行一次；之后手动切回的顺序播放不会被覆盖） |
| `src/player/manager.ts` | 播完/落盘失败上报 `source=mi-song-gpt`（上游为 `miot`） |
| `.github/workflows/release.yml` | 支持推送 `v*` 标签与手动触发；构建 frontend + 插件，自动回填 `version` / `download_url` / `updateUrl` / 哈希并回写 main，供 Songloft 在线更新 |
| `src/voicecmd/online_searcher.ts` | **修复外部搜索单曲播放循环**：未配置目标歌单时不再直接 `playURL`，改为 `PlaylistManager.playWithSongs([song], 0, 'order')` 单曲临时列表，注册切歌定时器，播完即停（避免音箱重拉同一 URL）；**新增「播完自动连播」**（`external_search_auto_continue`）：开启后单曲播完自动从 provider candidates / 同歌手搜索 / 已导入网络歌曲中续播，链路状态与队列代数绑定，换队列即失效 |
| `src/player/manager.ts` | **新增临时队列补充接口**：`appendSongs()` / `setQueueRefillHook()` / `replenishQueue()`，队列低水位提前补歌、播完前等最后一次补充；`queueGeneration` 防止旧异步回调把歌追加到新队列 |

| `scripts/sync-upstream.sh` / `.github/workflows/sync-upstream.yml` / `.github/upstream-sync-state.json` | **上游自动同步**：每天拉取官方 main 并合并，跑完整校验后推送；冲突或校验失败开 issue 提醒；状态文件记录最后合入的上游提交 |
| `src/utils/ai_headers.ts` / `src/ai/responses.ts` / `src/ai/sse.ts` / `src/utils/ai_request.ts` / `src/utils/ai_thinking.ts` | 随基线合入的上游 AI 基础设施（自定义请求头、Responses API、SSE 流解析、思考内容处理），问答接管与 AI 判定复用 |

说明：DLNA 多接收器（`src/receiver/*`、`publicPaths /dlna`）、设备分组、X8S Music API 播放、音量步进、`voiceDispatcher` 派发器等为上游 2026.11 线新增能力，随基线合入，非本定制改动。上游的独立 AI 对话子系统（`src/chat/service.ts`、`src/chat/speech.ts`、`src/playback/coordinator.ts`、`src/ws/chat-stream.ts` 等）**未合入**：本分支以问答接管（`src/voicecmd/qa_fallback.ts`）作为对话入口，避免与「小爱兜底」流程重复。

### 对话记录来源徽标说明

设置页「对话监听 → 最近对话记录」每条前面的小标签表示这句话被谁处理了：

| 徽标 | 含义 |
|---|---|
| 口令 | 命中固定口令（切歌/音量/定时…），立即执行 |
| 记忆 | 语音记忆重播 |
| 搜索 | 搜索口令（"播放XX"），本地曲库/外部源搜歌推流 |
| AI播放 | AI 语义判定出的播放意图并已执行（悬浮可见动作） |
| 小爱 | 小爱原生回答有效，插件未打扰 |
| 大模型 | 小爱答不上，问答大模型接管（悬浮可见是否联网） |
| 无徽标 | 未接管（引擎/问答未启用，或 LLM 失败交还小爱） |

状态栏新增两个指示：「AI判定」显示判定模型启用状态与连通延迟（进页面自动检测）；「问答接管」显示问答模型启用状态与模型名（换模型后保存即刷新，不是固定标签）。

### 对话记录 meta 行（判定反馈与耗时）

每条记录下方还有一行灰色 meta，徽标上则直接带总耗时：

```
[大模型 · 8.1s]  今天上证指数
                 小米AI音箱 · 本设备暂不支持该功能…
                 判定 问答·高置信 → 转问答 · 语义判定 186ms · 小爱原生回答 6.2s · 大模型 1.4s · 共 8.1s
```

| 字段 | 含义 |
|---|---|
| `判定 <动作>·<高/中/低>置信 → <走向>` | 语义判定器返回的 action 与置信度；走向 = 已执行 / 未执行 / 转问答 / 交回小爱 / 未接管。**判定器启用时无论是否执行都会显示**，因此能直接看到「为什么没执行」 |
| 各阶段耗时 | 只列该条实际走过的阶段：固定口令匹配 / 口令匹配 / 记忆查询 / 语义判定 / 执行 / 小爱原生回答 / 大模型 |
| `共 X` | 从收到消息到处理完成的总耗时 |

> 两点区分：状态栏「AI判定 正常 243ms」是**连通性探测**耗时，与记录里的处理耗时无关；meta 行只对安装本版本后**新产生**的记录有效，历史记录没有该字段，整行与徽标耗时会自动隐藏。

> 注意：徽标在引擎处理完成后回填，WebSocket 实时推来的最新一条可能要等下一次列表刷新才显示徽标，属正常现象。

## 七、已知行为与排错

- **音乐命令响应会先播小爱的一句话再被打断**：这是云端轮询架构的固有延迟，与原插件一致
- **"正在思考，请稍等"后长时间无声**：检查问答模型 API 地址/Key/模型名（用"问答测试"按钮验证）
- **联网问题回答"可能不是最新"**：方舟联网插件未开通或搜索失败，自动降级为普通回答
- **小爱 answered 但被判"没找到歌曲"**：这是预期——判定为疑似播放指令但本地没这首歌时，让大模型接话而不是播报"没找到"
- **语义判定 2~5s**：prompt 已精简、max_tokens 已降到 120，剩下是模型生成速度与网络本身；线上 API 就是这个量级（J3455 上跑本地小模型不划算）
- 查看日志：songloft 插件页面下载日志，搜索 `[QA]` / `[VoiceEngine]` 关键字

## 八、回滚

本插件 entryPath 已改为 `mi-song-gpt`，回滚即**卸载 mi-song-gpt**（可保留数据），再按需安装官方 miot——两者互不影响。旧版覆盖安装期间留在 `miot` 命名空间的存储键（`qa_config` 等）不影响官方插件运行。