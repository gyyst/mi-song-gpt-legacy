# Interrupting XiaoAI answers

After receiving a conversation webhook, call the dedicated endpoint to stop the answer on the specified speaker:

`POST /api/v1/jsplugin/miot/mina/interrupt`

The endpoint requires a Bearer access token obtained by logging into Songloft. Use the webhook's `account_id` and `device_id` fields; both must be nonempty strings. Include the deployment prefix in the server address when using a subpath.

```bash
curl -X POST 'http://your-Songloft-server:58091/api/v1/jsplugin/miot/mina/interrupt' \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  -d '{"account_id":"account_id from webhook","device_id":"device_id from webhook"}'
```

The endpoint immediately sends one round of `pause → stop`. After that stop is acknowledged successfully, it waits 2000ms and sends a second round. It responds after both rounds finish, so request duration includes the two-second wait and device requests. A failed stop acknowledgment or exception in either round terminates processing and returns failure without further retries. Pause is a compatibility step; a rejected pause alone does not prevent the stop attempt.

When both rounds succeed, the response is:

```json
{"success":true,"data":{"message":"interrupt commands accepted","stop_rounds":2,"cancelled":false}}
```

`success: true` means the stop commands were acknowledged successfully; **the endpoint does not verify that the speaker is silent**. This approach follows the L05b report that interrupting the introductory announcement still allowed the story to play, while stopping again after two seconds interrupted it completely ([Issue #118](https://github.com/songloft-org/songloft-plugin-miot/issues/118)). Other models, firmware versions, or later playback stages still require hardware validation.

If a new play, resume, pause, stop, TTS, or interrupt operation for the same account and device enters the device control service during processing, it cancels commands from the old interrupt task that have not yet been sent. Queued commands and retries after token refresh are checked again immediately before sending. The host processes HTTP requests for the same plugin serially, so another HTTP control request normally waits for this endpoint to return; cancellation protects against newer operations that have already entered the service. Cancellation returns the following response; `stop_rounds` counts rounds that completed normally and were acknowledged successfully before cancellation (0 or 1):

```json
{"success":false,"error":"interrupt superseded by a newer operation","data":{"stop_rounds":1,"cancelled":true}}
```

Requests already sent cannot be recalled. Physical buttons, the XiaoAI app, and other operations outside the plugin cannot be reliably detected and may still be affected by the second stop. Volume changes, status queries, and operations on other accounts or devices do not cancel the interrupt.

An unavailable device or failed stop returns `success: false`, `error: "failed to interrupt"`, and `data.stop_rounds` with `data.cancelled: false`. Missing or invalid IDs return `success: false` with the corresponding field error.

This endpoint only controls the specified speaker. It does not propagate to a device group, modify playlist queues, or take over DLNA playback. Call it while XiaoAI is answering; active playlist automation may push music later, so this endpoint is not a playlist stop command. The existing `/mina/stop` still performs one round, and webhook delivery does not automatically interrupt answers. Scripts using the new endpoint no longer need to schedule their own second stop after two seconds.

Validation commands: `npx tsc --noEmit` and `node --experimental-strip-types --test tests/*.test.mjs` (Node 22.17 needs TypeScript type stripping for existing tests that import `.ts` files directly). Actual interruption behavior still requires testing on an L05b or another real speaker.
