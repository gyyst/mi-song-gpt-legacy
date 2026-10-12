# AI Chat and Internal Architecture

miot remains a single installable plugin. Music commands and AI chat have independent switches. Existing AI command analysis, song memory, search, schedules, and DLNA remain available.

## Getting Started

Configure the provider, API URL, key, and default model in **Settings → AI Settings → Default model connection**. Enable **AI command analysis** and **AI chat** separately on the same page. Chat can reuse the default connection or use independent credentials, a model override, and its own timeout. Reusing the connection does not require enabling command analysis; an empty chat model uses the default model. Existing configuration keys are preserved. Voice settings retain monitoring, rules, music-command memory, and search, with a shortcut to AI settings. Spoken chat requires conversation monitoring; disable speech to test questions on the page without pausing music.

The default Chinese prefixes are “请问” and “问一下”. A successful answer opens a 60-second follow-up window; follow-ups still require waking the speaker. Fixed music controls take priority. Music rules, song memory, and AI command analysis handle recognized music requests; playback failures do not turn them into chat. Optionally enable fallback chat for unmatched music commands. Otherwise, questions outside the window continue to use the speaker's native assistant.

“停止回答”, “退出对话”, and “结束对话” cancel the answer and close the window, optionally restoring music after a safe stop. “停止播放” keeps music stopped. New questions invalidate old tasks so late model responses cannot speak.

## Speech and Music Recovery

Chat uses complete model responses and native speaker TTS. Answers are split at sentence boundaries into segments of up to 200 characters, with at most 1,200 characters spoken. Full answers remain in history. Model reasoning content is not spoken.

Chat suspends automatic track advancement and captures the original position and playback revision. Group playback pauses all members, speaks only on the requesting device, and then restores the shared queue at its common position. Offline members generate individual warnings. Previously paused or stopped music is not automatically started. A text-only test replacing spoken chat first stops the old answer and follows that task's music-recovery setting.

TTS acknowledgement only confirms command acceptance. Each segment has a startup protection interval and requires two fresh idle samples with different timestamps to confirm completion. Unknown state or a 90-second segment deadline stops further segments and leaves music paused for manual recovery. Firmware-dependent speech status still requires real-device validation.

Web playback, pause, stop, scheduled playback, sleep-timer expiry, group changes, and DLNA takeover invalidate previous recovery tasks. Volume changes do not cancel chat. Stop active DLNA casting before starting spoken chat.

## History and Long-Term Memory

Chat data is isolated by account and device, uses independent versioned plugin-storage keys, and remains separate from song memory. Defaults retain 12 context turns, at most 500 historical turns, and 30 days of records. Reference context is limited to 12,000 characters. Follow-up windows do not survive restart; old voice inputs and speech are never replayed.

After eight additional completed turns, a background job updates a summary of up to 2,000 characters. Long-term memory automatically extracts explicit user facts and preferences by default, with at most 100 entries per device and 300 characters per entry. Text matching selects at most five relevant memories without embeddings or a vector database. Extraction failures do not block answers. Disable extraction and use, or manually add, edit, delete, and inspect sources. Automatic extraction never overwrites manually maintained entries. Each extracted turn is checkpointed, so coalesced background work keeps intermediate turns. Deleted or cleared memories are not recreated from previously processed conversations.

Cancelled and failed tasks remain available for diagnostics but are excluded from successful conversation context. Deleting a turn removes automatically extracted memories from that source and rebuilds the summary; manually maintained memories remain. Resetting a session only changes its context boundary and clears its summary. Clearing history, long-term memory, or all data are separate operations. Storage revision checks reject late writes after deletion or clearing. Corrupt data is never overwritten with defaults.

## API

All paths below are relative to `/api/v1/jsplugin/miot` and require a host JWT. Device operations require `account_id` and `device_id` for a managed device. New endpoints return direct JSON; errors use `{error, detail}`. Existing endpoint responses remain compatible.

| Method and path | Purpose |
|---|---|
| `GET/PUT /chat/config` | Read or partially update chat configuration; disabled by default |
| `GET /chat/models` | List models using the effective chat connection |
| `POST /chat/messages` | `{account_id, device_id, text, speak?}`; returns 202 `{task_id, phase}`; questions limited to 2,000 characters |
| `GET /chat/status` | Device query parameters; returns task phase, follow-up window, and latest answer |
| `GET /chat/history` | Device parameters plus `offset` and `limit`; returns history, total, and summary |
| `DELETE /chat/history/{id}` | Delete a turn and its automatic memory sources |
| `POST /chat/cancel` | Device parameters and optional `close_session`, `resume_music`; defaults to closing the session without resuming music |
| `POST /chat/reset` | Reset session context |
| `GET/POST /chat/memories` | List memories or manually add one with `content` |
| `PUT/DELETE /chat/memories/{id}` | Edit or delete a memory |
| `POST /chat/clear` | Device parameters and `range: history/memory/all` |
| `WS /chat/ws` | Device query parameters; initial snapshot plus task, answer, and data-revision updates |

The chat connection can reuse analysis credentials or remain independent. Chat, summaries, and extraction use the chat connection. Chat defaults to a 30-second timeout, configurable from 1–30 seconds; analysis retains its existing six-second default. Shared scheduling permits two foreground requests and one low-priority background request, with one foreground model request per device. Cancellation invalidates results; already-issued HTTP requests may continue until the host deadline.

## Module Boundaries and Validation

Conversation monitoring only receives and submits messages. `VoiceDispatcher` routes them; `MusicCommandService` handles music rules and AI analysis, while `VoiceEngine` remains a compatibility export. `PlaybackCoordinator` owns interaction leases, recovery, and takeover. `VoiceResumeCoordinator` manages existing native-assistant recovery per device. `SleepTimerService` unifies web, voice, and scheduled stop timers. `AIChatService`, `SpeechService`, and `ChatMemoryService` handle chat, speech, and memory respectively.

Validate in the plugin directory with `npx tsc --noEmit` and `node --experimental-strip-types --test tests/*.test.mjs`. In the frontend directory run `npm run typecheck && npm run build && npm test`. Run `songloft-plugin build`, then plugin validation in the build directory. Actual speech, interruption, and group recovery additionally require real-speaker testing.

See [AI chat testing](ai-chat-testing.md) for the coverage matrix and real-device acceptance checks.
