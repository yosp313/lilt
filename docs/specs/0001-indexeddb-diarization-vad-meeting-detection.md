# 0001. IndexedDB storage with speaker diarization and meeting auto-detection

**Date**: 2026-10-25
**Status**: Proposed

## Summary

This spec migrates Lilt from a JSON file store to IndexedDB for scalable local storage, adds local speaker diarization so system audio separates into individual speakers, replaces the RMS-based voice activity detection with Silero VAD for higher accuracy, adds meeting auto-detection via calendar and window enumeration, and retains audio chunks until transcription succeeds instead of discarding immediately.

## Context

Lilt currently stores all data (notes, spaces, folders, templates, recipes, threads, settings) in a single JSON file (`store.json`) read entirely into memory on launch. This works for hundreds of notes but degrades with thousands. The renderer receives the full store via IPC and writes it back on every change.

Speech-to-text uses a simple RMS threshold (`SPEECH_FLOOR = 0.006`) to detect voice activity. This misfires on background noise and quiet speakers. Chunks are capped at 7 seconds (cloud) or 15 seconds (local) with early flush on 800ms of silence. Audio blobs are discarded immediately after transcription is sent — if transcription fails, the audio is lost.

Meeting capture is manual: the user opens a note and presses record. Calendar integration exists but only shows upcoming events; it does not detect an active meeting and offer to start notes.

Speaker identification is binary: microphone audio is "Me", system audio is "Them". Multi-person meetings on the system stream appear as a single "Them" speaker.

The consequences of not deciding: the JSON store will become a bottleneck, transcription accuracy will remain limited by poor VAD, users will lose audio on transcription failures, and the manual meeting start flow creates friction that competing products (Granola, OpenWhispr) have eliminated.

## Requirements

**User stories**:
- As a user with thousands of notes, I want the app to stay fast so I can search and open notes instantly.
- As a user in a meeting with multiple other people, I want the transcript to show who said what so I can follow the conversation.
- As a user in a noisy environment, I want the app to transcribe only when someone is speaking so I get clean transcripts without hallucinated text.
- As a user with an upcoming calendar meeting, I want the app to notice and offer to start notes so I do not forget to record.
- As a user on an unreliable network, I want my audio retained until transcription succeeds so I never lose a meeting segment.

**Acceptance criteria**:
- **AC-1**: All existing data types (notes, spaces, folders, templates, recipes, threads, settings, workspace, user) persist in IndexedDB with the same schema and relationships.
- **AC-2**: Writes are atomic — no partial state on crash. IndexedDB transactions provide this.
- **AC-3**: Migration from `store.json` runs once on first launch after upgrade, preserves all data, and leaves a backup file (`store.json.migrated-backup`).
- **AC-4**: Renderer reads and writes via the same `Api` surface (`load`, `save`) — no UI changes needed.
- **AC-5**: Main process keeps lightweight config (AI config, calendar OAuth, share server) in JSON files; only the heavy entity data moves to IndexedDB.
- **AC-6**: System audio stream ("Them") is diarized into multiple speakers (Speaker A, Speaker B, ...) using a local model (pyannote via sherpa-onnx).
- **AC-7**: Microphone stream ("Me") stays as a single speaker (the user).
- **AC-8**: Diarization runs locally on captured audio chunks before transcription, no cloud dependency.
- **AC-9**: Transcript segments carry `speaker` field with diarized labels, plus `speakerConfidence` (number) and `voicePrintId` (string, nullable) for future fingerprinting.
- **AC-10**: Voice fingerprinting across meetings is supported via speaker embeddings (deferred to follow-up).
- **AC-11**: App detects active meeting via calendar event happening now (primary) and window title enumeration (fallback for ad-hoc calls).
- **AC-12**: One-click "Start notes" from detected meeting pre-fills title, attendees, and calendar event link.
- **AC-13**: Auto-start recording when meeting detected and user has enabled "Auto-start for calendar meetings" in settings.
- **AC-14**: Meeting detection works on macOS, Windows, and Linux via Electron `desktopCapturer`.
- **AC-15**: VAD adapts to noise floor (calibrates first 2 seconds of each session).
- **AC-16**: Chunk boundaries align with speech segments — no mid-word cuts.
- **AC-17**: Maximum chunk duration capped (15s local, 7s cloud) with early flush on VAD pause of 800ms or more.
- **AC-18**: Silero VAD (ONNX via WASM) replaces RMS-based VAD, runs in AudioWorklet off the main thread.
- **AC-19**: Audio retained in memory until transcription resolves (success or permanent failure), then discarded. On app quit, pending chunks flushed to temp files; on restart, retranscribed.

## Options considered

### Option 1: Full IndexedDB migration (main + renderer)

Move all data including AI config, calendar tokens, and share server state to IndexedDB. Main process accesses IndexedDB via `fake-indexeddb` or `level`.

**Pros**:
- Single source of truth, no split-brain risk
- Main process can query notes directly for share server

**Cons**:
- `fake-indexeddb` is slow for large datasets; `level` adds native dependency and rebuild complexity
- Main process would need to coordinate with renderer on DB access (IndexedDB is per-origin, not multi-process)
- Over-engineers config data that is tiny and rarely changes

### Option 2: Split store (recommended)

Renderer owns IndexedDB for heavy entity data (notes, spaces, folders, templates, recipes, threads, settings, workspace, user). Main process keeps `ai-config.json`, `calendar.json`, and share server port in JSON files. IPC `store:load`/`store:save` proxy to renderer.

**Pros**:
- Clean architectural boundary: renderer = UI + DB, main = native + IPC
- No Node IndexedDB polyfill needed
- Config files stay simple, human-readable, and portable
- Share server can request data from renderer via `webContents.executeJavaScript` when needed

**Cons**:
- Two storage systems to understand
- Share server cannot serve notes if renderer is not loaded (mitigated: share server only runs when app is open)

### Option 3: Keep JSON, add SQLite via better-sqlite3

Replace JSON with SQLite in main process. Renderer queries via IPC.

**Pros**:
- Mature, fast, supports concurrent access
- Main process can query directly for share server

**Cons**:
- Adds native dependency (`better-sqlite3` requires rebuild per Electron version)
- Schema migrations more complex than IndexedDB versioning
- Renderer still needs to receive full result sets over IPC (no lazy loading)

### Option 4: No storage change, only add diarization/VAD/meeting detection

Leave JSON store as-is.

**Pros**:
- Zero migration risk
- Faster to ship the new features

**Cons**:
- JSON store bottleneck remains
- Technical debt compounds

## Decision

**Chosen option**: Option 2: Split store — renderer owns IndexedDB for entity data, main process keeps config JSON.

**Implementation skills**: `idb` (jakearchibald/idb, npm/idb) · `@ricky0123/vad-web` (ricky0123/vad-web, npm/@ricky0123/vad-web) · `sherpa-onnx` (k2-fsa/sherpa-onnx, npm/sherpa-onnx)

## Rationale

The split store respects Electron's process model: IndexedDB is a renderer API. Forcing it into the main process requires a polyfill that adds latency and complexity. The heavy data (notes, transcripts) lives where the UI needs it — the renderer. The light config (API keys, OAuth tokens) stays in the main process where `safeStorage` encrypts it. This mirrors how OpenWhispr separates concerns.

For diarization, `sherpa-onnx` is the only maintained library that packages pyannote segmentation + embedding + VAD as prebuilt Node binaries across all three platforms. OpenWhispr validates this choice in production. The model sizes (~100MB total) are acceptable alongside whisper.cpp binaries.

For VAD, `@ricky0123/vad-web` wraps Silero VAD in a WASM AudioWorklet. It runs off the main thread, calibrates automatically, and is 1MB. The RMS fallback is trivial to keep for compatibility.

Meeting detection uses calendar as primary signal because it is deterministic (we know the meeting URL, attendees, title). Window enumeration is a heuristic fallback for unscheduled calls. Both run in the main process where `desktopCapturer` and calendar access live.

Audio retention until transcription success is a small change with large user value: no more lost segments when the network blips or the local model crashes. Temp files in `app.getPath('temp')` are bounded and cleaned on quit.

## Feature design

### Data model sketch

**IndexedDB object stores** (renderer):

| Store | Key | Indexes | Notes |
|-------|-----|---------|-------|
| `workspace` | `id` | — | Single record |
| `user` | `id` | — | Single record |
| `spaces` | `id` | `kind` | |
| `folders` | `id` | `spaceId`, `parentId` | Nested folders via `parentId` |
| `notes` | `id` | `spaceId`, `status`, `deletedAt`, `createdAt`, `folderIds` (multiEntry) | Largest store |
| `segments` | `id` | `noteId` | Transcript segments, separate store for query efficiency |
| `templates` | `id` | `builtin` | |
| `recipes` | `id` | — | |
| `threads` | `id` | `scopeType`, `scopeId` | Compound index for scope queries |
| `settings` | `id` (fixed "settings") | — | Single record |

**Segment fields (updated for diarization)**:
```
id: string (PK)
noteId: string (FK)
source: 'mic' | 'system'
speaker: string          // "Me" | "Them" | "Speaker A" | "Speaker B" ...
text: string
startMs: number
endMs: number
speakerConfidence: number | null   // 0-1, diarization confidence
voicePrintId: string | null        // speaker embedding hash for cross-meeting ID
```

**JSON files (main process, unchanged)**:
- `ai-config.json` — API keys, STT config, model selections
- `calendar.json` — OAuth tokens (encrypted via `safeStorage`)

### State transitions

**Note status** (unchanged):
`draft` → `recording` → `paused` ↔ `recording` → `ended`

**Migration state** (internal):
`json-only` → `migrating` → `indexeddb-only` (persisted in `settings.migrationDone`)

### API surface

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|----------|--------|------------|-------------|------|------------|
| `api.load()` | IPC | — | `Store` | — | `QuotaExceededError` |
| `api.save(store)` | IPC | `Store` | `{ savedAt }` | — | `QuotaExceededError` |
| `api.diarize(audioBlob, source)` | IPC | `Blob`, `'system'` | `Segment[]` | — | `ModelNotReady`, `DiarizationFailed` |
| `api.detectMeeting()` | IPC | — | `CalendarEvent \| null` | — | `CalendarNotConnected` |
| `api.onMeetingDetected(cb)` | IPC event | — | `CalendarEvent` | — | — |
| `api.transcribe(req)` | IPC | `TranscribeRequest` | `{ text }` | — | `TranscriptionFailed` |
| `api.sttDownload(source)` | IPC | `SttSource` | `AiConfig` | — | `DownloadFailed` |

### Value sourcing

| Action | Value produced / displayed | Source |
|--------|----------------------------|--------|
| `load()` | Full `Store` | IndexedDB (renderer) |
| `save()` | Confirmation timestamp | IndexedDB transaction commit |
| `diarize()` | `Segment[]` with `speaker`, `speakerConfidence`, `voicePrintId` | sherpa-onnx (main process) |
| `detectMeeting()` | `CalendarEvent` | Calendar events (main) + `desktopCapturer` window titles (main) |
| `transcribe()` | `text` | whisper.cpp server (local) or cloud API (main) |
| `sttDownload()` | Progress events, model file | HTTP download + `fs` (main) |
| Migration | IndexedDB populated | `store.json` (main, one-time) |
| VAD calibration | Noise floor threshold | First 2s of capture (renderer AudioWorklet) |
| Chunk flush decision | Chunk boundary timestamp | Silero VAD pause detection (renderer) |

### Key invariants

- A `Note` always belongs to exactly one `Space` (via `spaceId`).
- A `Note` may belong to multiple `Folders` (via `folderIds` array).
- A `Segment` always belongs to one `Note` (via `noteId`).
- `speakerConfidence` is `null` for mic-source segments (always "Me").
- `voicePrintId` is `null` until fingerprinting is implemented.
- Migration runs exactly once; `settings.migrationDone` prevents re-run.
- Audio temp files are deleted after successful transcription or on clean quit.

### Security model

- API keys never leave main process. `safeStorage` encrypt/decrypt only in main. Renderer receives only `keyStored: boolean`.
- OAuth refresh tokens encrypted at rest in `calendar.json` via `safeStorage`.
- Audio temp files written to `app.getPath('temp')` with random names, deleted after transcription or on quit.
- Local STT (whisper.cpp server) binds `127.0.0.1` only — no network exposure.
- Diarization runs in main process via `sherpa-onnx` — no network, no GPU required.
- Share server serves only sanitized enhanced notes (`sanitizeSharedNote` strips transcript and raw notes).
- No telemetry, no crash reporting, no auto-update checks (user controls updates via GitHub releases).

### Configuration required

- No new environment variables.
- New settings (stored in IndexedDB `settings` store):
  - `diarizationEnabled: boolean` (default: `true` on supported platforms)
  - `vadSensitivity: number` (0-1, default: 0.5, maps to Silero threshold)
  - `autoStartMeetingRecording: boolean` (default: `false`)
  - `meetingDetectionEnabled: boolean` (default: `true`)

## Critical test scenarios

- Happy path: Fresh install → empty IndexedDB → create note → record → transcribe → diarize → enhanced notes. Verifies **AC-1**, **AC-6**, **AC-9**, **AC-18**.
- Upgrade path: Existing `store.json` with 500 notes → launch → migration runs → all notes accessible → `store.json.migrated-backup` exists. Verifies **AC-3**.
- Failure case: Network down during cloud transcription → audio retained in temp file → restart app → chunk retranscribed → appears in transcript. Verifies **AC-19**.
- VAD accuracy: Noisy coffee shop recording → Silero VAD suppresses background, detects speech boundaries correctly → chunks align with utterances. Verifies **AC-15**, **AC-16**, **AC-17**, **AC-18**.
- Meeting detection: Calendar event starting now with Zoom URL → banner appears → click "Start notes" → note created with title/attendees/calendarEvent → recording starts. Verifies **AC-11**, **AC-12**.
- Auth/permission: Share server request for revoked token → 404 page. Verifies existing share security.
- Quota exceeded: IndexedDB near browser limit → `QuotaExceededError` caught → toast user with export option. Verifies **AC-2** edge case.

## Build plan

**Slice 1: IndexedDB Foundation** (satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**)
1. Add `idb` dependency. Create `src/db/indexeddb.ts` with schema definition, versioned migration, `Db` class (`open`, `migrateFromJson`, `loadStore`, `saveStore`).
2. Update `preload.ts` `Api.load`/`save` to call IndexedDB methods.
3. Update `main.ts` `registerIpc()`: `store:load`/`store:save` handlers proxy to renderer via `webContents.executeJavaScript` (or keep main-process JSON for config only, renderer owns entity data).
4. On app ready: check `settings.migrationDone`; if false and `store.json` exists, run migration in main, then signal renderer to hydrate IndexedDB.
5. Test: fresh install (empty DB), upgrade install (migrated data), concurrent saves (transaction atomicity).

**Slice 2: Diarization Pipeline** (satisfies **AC-6**, **AC-7**, **AC-8**, **AC-9**, **AC-10**)
1. Add `sherpa-onnx` to `package.json` (native dependency, `electron-rebuild`/`@electron-forge/plugin-vite` handles it).
2. Create `src/diarization.ts` (main): `initDiarization(modelsDir)`, `diarizeAudio(pcm: Float32Array, sampleRate: number)` → `Promise<Segment[]>`. Downloads pyannote ONNX models on first use (like Whisper models).
3. Add IPC `diarize:process` handler in `main.ts`.
4. In `capture.ts`/`app.ts`: after system-audio chunk transcribed, if `settings.diarizationEnabled`, send PCM to diarization, replace single "Them" segment with diarized segments.
5. Update `Segment` type in `shared/types.ts` with `speakerConfidence`, `voicePrintId`.
6. Test: 30s system audio with 3 speakers → diarized segments with labels "Speaker A", "Speaker B", "Speaker C".

**Slice 3: Silero VAD Integration** (satisfies **AC-15**, **AC-16**, **AC-17**, **AC-18**)
1. Add `@ricky0123/vad-web` to renderer dependencies.
2. Create `src/vad.ts` (renderer): `createVadWorklet()` returns `AudioWorkletNode` that emits `speechstart`/`speechend` events with timestamps.
3. Replace `Capture.tickLevels()` RMS logic with VAD worklet events. Calibrate first 2s automatically.
4. Chunk flush: on `speechend` with pause ≥800ms, flush chunk early. Cap at 15s (local) / 7s (cloud).
5. Fallback: if WASM fails to load, fall back to RMS VAD, log warning, toast once.
6. Test: speech in noise, quiet speech, rapid speaker turns — verify chunk boundaries and no mid-word cuts.

**Slice 4: Meeting Auto-Detection** (satisfies **AC-11**, **AC-12**, **AC-13**, **AC-14**)
1. Create `src/meeting-detection.ts` (main): `detectActiveMeeting()` → `CalendarEvent | null`.
   - Primary: `upcomingEvents()` filtered to events starting within ±5 minutes with `meetingUrl`.
   - Fallback: `desktopCapturer.getSources({ types: ['window'] })` → match title against known patterns (Zoom, Teams, Meet, FaceTime, Webex, GoToMeeting).
2. Add IPC `meeting:detect` handler and `meeting:detected` event (polled every 30s or on calendar sync).
3. Renderer: `api.onMeetingDetected(cb)` listener, shows banner "Meeting detected: [Title] — Start notes".
4. Settings toggle: `autoStartMeetingRecording` — if enabled and meeting detected, auto-create note and start recording.
5. Test: Calendar event now → detected. Ad-hoc Zoom call (no calendar) → window title fallback → detected.

**Slice 5: Smart Chunking + Audio Retention** (satisfies **AC-15** through **AC-19**)
1. Update `Capture` chunking logic: max duration from settings, early flush on VAD pause.
2. On transcription failure (network error, model error): write blob to `temp/lilt-chunk-{timestamp}-{source}.webm`.
3. On `before-quit`: flush any pending in-memory chunks to temp files.
4. On startup: scan `temp/lilt-chunk-*.webm`, re-queue for transcription, show "N chunks pending retry" badge.
5. After successful retry: delete temp file.
6. Test: kill network during recording → chunks saved to temp → restart → retranscribed → transcript complete.

**Slice 6: Integration & Polish**
1. Settings UI: toggles for diarization, VAD sensitivity slider, auto-start meeting recording, meeting detection.
2. Migration verification test: script that creates `store.json` with 1000 notes, runs migration, validates count and integrity.
3. Performance benchmarks: IndexedDB load <100ms for 1000 notes; diarization <2s per 30s chunk on M1/Intel i7.
4. Remove `store.json` read/write code from `main.ts` (keep only `ai-config.json`, `calendar.json`).
5. Update `shared/types.ts` with new `Segment` fields and `Settings` fields.

## Consequences

**Positive**:
- IndexedDB scales to 10k+ notes with lazy loading; JSON file loads entire store into memory.
- Speaker diarization makes "Them" usable for multi-person meetings — each speaker labeled.
- Meeting auto-detection removes friction: no manual note creation for scheduled calls.
- Silero VAD far more accurate than RMS — fewer false cuts, fewer hallucinations, better transcripts.
- Audio retention prevents data loss on transcription failures (network, model crash, quota).
- Architecture stays clean: renderer owns DB, main owns native STT/diarization/IPC.

**Negative / tradeoffs**:
- `sherpa-onnx` adds ~50MB native binaries (per platform) to app size.
- IndexedDB migration is one-way — downgrade requires manual backup restore.
- Diarization runs on CPU — may slow transcription on older laptops (mitigation: queue, show progress).
- Window enumeration for meeting detection can be flaky on Linux (Wayland vs X11).
- More moving parts = more surface for bugs.

**Neutral**:
- `idb` and `@ricky0123/vad-web` are pure JS/WASM — no native rebuild.
- Main process stays single-threaded for native work (whisper-server + sherpa-onnx share CPU).
- No cloud dependencies added — fully offline capable.

## Follow-up

- [ ] Add `voicePrintId` persistence across meetings (speaker fingerprinting) — requires embedding index and matching logic.
- [ ] Team spaces / multi-user sync (needs org isolation, separate spec).
- [ ] Mobile companion (PWA or Expo) for note viewing.
- [ ] Semantic search via local embeddings (nomic-embed-text ONNX in renderer).
- [ ] MCP server for AI assistant integration (OpenWhispr pattern).

## References

**Project sources** (verifiable in this repo):
- `AGENTS.md` — project conventions, build approach
- `src/shared/types.ts` — current `Store`, `Note`, `Segment`, `Settings` types
- `src/main.ts` — IPC handlers, JSON store logic, calendar, share server
- `src/capture.ts` — VAD, chunking, capture logic, `Capture` class
- `src/local-stt.ts` — whisper.cpp server management, local transcription
- `src/ui/app.ts` — UI state, recording flow, note enhancement, calendar integration

**Practices & standards**:
- Strangler pattern for JSON → IndexedDB migration (one-way, backup preserved)
- Offline-first: all core features work without network
- Audio privacy: discard after transcription success, temp files cleaned on quit
- Boring technology: `idb` (Chrome team), Silero VAD (Snakers4), sherpa-onnx (K2-FSA) — all proven, maintained, MIT/Apache-2.0

**Links** (web verified):
- idb: https://github.com/jakearchibald/idb
- @ricky0123/vad-web: https://github.com/ricky0123/vad-web
- sherpa-onnx Node bindings: https://github.com/k2-fsa/sherpa-onnx
- Silero VAD: https://github.com/snakers4/silero-vad
- Electron safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- pyannote segmentation: https://github.com/pyannote/pyannote-segmentation