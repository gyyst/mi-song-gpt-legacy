# 中断小爱回答

收到对话 webhook 后，可以调用专用接口停止指定音箱的回答：

`POST /api/v1/jsplugin/miot/mina/interrupt`

接口需要 Songloft 登录得到的 Bearer access token。请求中的 `account_id`、`device_id` 使用 webhook 推送中的对应字段，必须为非空字符串。子路径部署时，服务器地址需要带部署前缀。

```bash
curl -X POST 'http://你的Songloft服务器:58091/api/v1/jsplugin/miot/mina/interrupt' \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"webhook中的account_id","device_id":"webhook中的device_id"}'
```

接口立即发送一轮 `pause → stop`，该轮停止应答成功后等待 2000ms，再发送第二轮 `pause → stop`。两轮完成后才返回，因此调用耗时包含两秒等待及设备请求时间。任何一轮 stop 应答失败或抛出异常都会终止本次处理中断并返回失败，不继续重试。pause 是兼容性前置操作，单独拒绝 pause 时仍尝试 stop。

两轮均成功时返回：

```json
{"success":true,"data":{"message":"interrupt commands accepted","stop_rounds":2,"cancelled":false}}
```

`success: true` 表示停止指令应答成功，**没有核验音箱已经静音**。方案依据 L05b 在“为你找到……”播报被打断后仍继续播放故事、隔两秒再次停止才完全中断的反馈（[Issue #118](https://github.com/songloft-org/songloft-plugin-miot/issues/118)）。不同型号、固件或更晚的播放阶段仍需实机验证。

如果处理期间，同一账号、同一设备的新播放、恢复、暂停、停止、TTS 或另一次中断操作进入设备控制服务，会取消旧中断任务尚未发送的指令。队列中的指令和 token 刷新后的重发也会在发送前再次检查。宿主串行处理同一插件的 HTTP 请求，另一 HTTP 控制请求通常需等待本接口返回后才能执行；取消保护针对已经进入服务层的新操作。取消返回如下，`stop_rounds` 表示取消前正常完成且应答成功的轮数（可能为 0 或 1）：

```json
{"success":false,"error":"interrupt superseded by a newer operation","data":{"stop_rounds":1,"cancelled":true}}
```

已经发送的请求无法撤回。实体按键、小爱 App 或其他插件外操作无法可靠识别，仍可能受第二轮停止影响。改变音量、查询状态或操作其他账号/设备不会取消本次中断。

设备不可用或停止失败时返回 `success: false`、`error: "failed to interrupt"`，并包含 `data.stop_rounds` 和 `data.cancelled: false`。缺少或无效的 ID 返回 `success: false` 和对应字段错误。

该接口只控制指定音箱，不向设备组扩散，也不修改歌单队列或接管 DLNA 播放。应在小爱回答时调用；它不是歌单停止接口，仍在运行的歌单驱动后续可能继续推送音乐。普通 `/mina/stop` 仍只执行一轮停止；webhook 推送本身不会自动中断回答。脚本改用本接口后，无需再自行安排两秒后的第二次停止。

验证命令：`npx tsc --noEmit` 和 `node --experimental-strip-types --test tests/*.test.mjs`（Node 22.17 需启用 TypeScript 类型剥离，供既有测试直接导入 `.ts` 文件）。实际中断效果需要 L05b 等真实音箱复测。
