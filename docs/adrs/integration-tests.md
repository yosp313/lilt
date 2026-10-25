# Integration tests — what is and is not covered

Rough, on what this repo ships today and why. Pure logic tests exist in
`src/shared/logic.test.mjs`; everything else goes through Electron main, IPC, and
network, so it is surfaced here instead of inline for now. Adding a fake-fetcher
harness for each path is blocked on setting up a CI runner; this doc lists the
surfaces and the smallest test cases that would matter when one is added.

| Path | Handler | Untestable here without extra state | Smallest integration case |
|---|---|---|---|
| Calendar connect (OAuth) | `connectCalendar`, `waitForCode`, token flow | interactive browser callback | Google redirects to `127.0.0.1:port/oauth/callback`; assert `server.close()` fires and the stored record has a refresh token. |
| Calendar events | `fetchCalendarEvents`, token refresh | needs a valid cached token | Google 401 then 200; assert `calendarStatus.lastSyncedAt` updates. |
| AI complete | `complete` | API key round-trip + shape errors | `500` then empty reply then no key throws a clean message. |
| Transcribe (cloud) | `transcribe` | multipart blob + timeout | bad `data` bytes (`>24 MiB`) and an invalid `mime`. |
| STT server | `ensureServer`, `infer` | spawns whisper-server binary | missing binary → error; unknown model → 404 path; OpenAI fallback. |
| Chunk queue | `queueChunk`, `runChunks`, `transcribeChunk` | audio blob decode | one chunk fails → transcript continues, failure fires warning, one segment lost. |

Not added yet: a fake-http fetcher that runs inside the renderer and the main IPC
boundary, so `mockHttp` can drive every real error branch. Once a runner exists,
every row above is the next question to answer.
