# AI Chat Testing and Acceptance

Related requirement: songloft-org/songloft-plugin-miot#119. This checklist covers internal refactoring within one plugin, preservation of AI music-command analysis, AI chat, and consolidated AI settings.

Automated tests verify deterministic program behavior. They do not establish compatibility with every speaker firmware, network condition, or model response. Model and device substitutes control failures, deadlines, and asynchronous ordering. Native speech, actual interruption, and group synchronization still require physical devices.

## Automated Coverage

Test files are in the plugin repository's `tests/` and `frontend/tests/` directories.

| Area | Scenarios | Test files |
|---|---|---|
| Configuration compatibility | Disabled defaults, independent analysis/chat switches, shared and separate connections, model overrides, concurrent partial updates, preservation of corrupt configuration, older memory format | `chat.test.mjs`, `chat_contracts.test.mjs` |
| Parameters and boundaries | Boolean/string/number types, integer bounds, empty questions, 2,000-character question limit, trigger trimming/deduplication, UTF-8 requests, missing/unknown/unmanaged devices | `chat_contracts.test.mjs` |
| Voice routing | Fixed music controls first, explicit chat bypasses analysis, active/expired followup window, fallback switch, followup during answers, recognized execution failures never become chat, exit commands, volume preserves chat, deduplication, no dispatch after shutdown | `chat.test.mjs`, `chat_scenarios.test.mjs` |
| Existing music features | Rules, AI analysis, music-command memory, song indices, search matching, automatic transitions, failure verification, speed/position, resume after stop; actual music service continues playback through the new guard wrapper | Existing `ai_analyzer`, `voice_index_matching`, `player_*`, and related tests |
| Model requests | HTTP 401/403/429/500, network failures, request/parse deadlines, invalid JSON, empty answers, exclusion of reasoning, answer length limits, credential redaction | `ai_client.test.mjs`, `ai_request.test.mjs` |
| Scheduling | Two foreground slots, serialization per device, parallel devices, serialized low-priority background work, foreground requests proceed during background work, queue limits, stale jobs send no request, late results become invalid | `ai_client.test.mjs`, `chat.test.mjs` |
| Task lifecycle | Success/failure/unknown, cancellation while queued/preparing/generating/speaking/resuming, cancellation before queuing, concurrent submission ordering, safe replacement of speech with text-only testing, configuration changes, shutdown, external control, failed failure hint, recovery after storage error, no restart of old tasks | `chat_scenarios.test.mjs` |
| Speech | Markdown/code/link handling, 200-character segments and 1,200-character total limit, startup protection, two fresh idle samples, cached samples do not count, non-idle states never imply completion, 90-second deadline, no subsequent segment after cancellation, no recovery after failed stop | `chat.test.mjs`, `chat_scenarios.test.mjs` |
| Playback ownership | Original position, paused/stopped queues never auto-start, group pause with speech only on requester, offline secondary/requester, rejection during DLNA, group controls cancel chat, recovery failure, old cleanup preserves new guards, queued URL/resume/playlist loads cannot override chat | `chat.test.mjs`, `chat_scenarios.test.mjs`, `player_failures.test.mjs`, `interrupt_answer.test.mjs` |
| Sleep timers | Shared primary, expiration, old timer cannot stop a replacement group queue, resetting uses the new queue | `chat.test.mjs` and existing sleep-timer tests |
| History/context | Account/device isolation, age/count retention, pagination/reverse order, 12,000-character budget, completed-turn filtering, reset within the same millisecond, source deletion/summary rebuild, clear ranges, late writes never revive data | `chat.test.mjs`, `chat_contracts.test.mjs`, `chat_scenarios.test.mjs` |
| Long-term memory | 100 entries/300 characters, at most five relevant references, disabled memory, extraction checkpoints, intermediate turns preserved, empty extraction is not repeated, manual edits/deletions win, coalesced work during clearing, independent summary/extraction failures | `chat.test.mjs`, `chat_contracts.test.mjs`, `chat_scenarios.test.mjs` |
| HTTP/WebSocket | Config/models/messages/status/history/reset/cancel/memory/clear endpoints, direct JSON, error objects, initial snapshot, account/device isolation, subscription cleanup after close/error/send failure | `chat_contracts.test.mjs` |
| Consolidated AI settings | Single entry, shared connection editable with analysis disabled, presets preserve credentials and switches, custom models, save before checking/testing, automatic check never writes configuration, stale responses/unmount, manual model after list failure, preserved analysis test | `frontend/tests/ai_settings.test.mjs` |
| UI asynchronous behavior | HTTP cannot overwrite newer WS state, HTTP fallback on connection failure, disconnect/open-deadline retries, duplicate closes do not duplicate retries, device switching, out-of-order refresh, edit drafts preserved, duplicate submissions blocked, retry after error, confirmation cannot delete newly selected device data, no updates after unmount | `frontend/tests/chat_races.test.mjs` |

## Running and Evaluating Tests

From the plugin directory:

```bash
npx tsc --noEmit
node --experimental-strip-types --test tests/*.test.mjs
```

From the frontend directory:

```bash
npm run typecheck
npm run build
npm test
```

To inspect individual cases in a file, run it directly, for example `node --experimental-strip-types tests/chat_scenarios.test.mjs`. Distinguish test-file counts from test-case counts. Passing requires no failed or cancelled tests; hanging or skipped cases do not count as verified.

Build and validate the plugin manifest with `songloft-plugin build`, then run `../../node_modules/.bin/songloft-plugin validate` from `dist/_build/`.

## Host and Browser Validation

Use an isolated database and test account, upload the built test plugin to an actual Songloft/QuickJS host, and point its model connection at a local mock service. Verify unauthenticated requests are rejected, text questions and historical context, extraction, slow-response cancellation, no late writes after clearing, model lists, and configuration persistence. Test accounts are written only to the isolated database. The released plugin contains no fake accounts or test initialization code.

Use a Docker headless browser to check consolidated AI settings at desktop and mobile widths. Read backend state after interactions to verify the default connection, chat switch, and preferences are saved. Check shared-connection chat still works with analysis disabled. Screenshots and overflow checks establish rendering behavior, not physical speaker speech.

## Physical-Device Checks Required

| Scenario | Acceptance criteria |
|---|---|
| Native TTS across models | Audible output, ordered long-answer segments, device state can confirm actual completion |
| Native assistant and AI takeover | Chat interrupts the original answer; cancellation/new questions do not produce delayed speech |
| Playback and position | Resume original track position; paused/stopped queues never auto-start; speed and radio follow existing player behavior |
| Groups with two or more speakers | All music pauses, only requester speaks, controls from another member cancel old recovery, offline members do not block other members |
| Actual DLNA and scheduled actions | Spoken chat rejected during casting; new casting, scheduled playback, and sleep expiration are not overridden by old chat recovery |
| Unstable networks | Cloud deadlines and device reconnection cause no duplicate pushes; unknown speech state never implies completion |
| Actual models | Music-command parsing, followup, summaries, and preference extraction meet expectations; substitutes cannot establish semantic accuracy |

Physical checks remain unverified until actually executed. This checklist does not claim 100% code coverage or zero defects in every environment.
