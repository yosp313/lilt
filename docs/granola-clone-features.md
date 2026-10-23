# Granola Clone — Feature Specification

Research date: 2026-10-23. Sources: granola.ai (home, pricing, chat, enterprise, integrations, MCP, security), docs.granola.ai (help center + API), recipes.granola.ai.

## 1. Product thesis (the parts that define the clone)

Granola is **not** a meeting bot. It is a desktop/mobile notepad that:

1. Captures **your computer's audio + your microphone** locally, no bot joins the call.
2. Lets you type rough notes during the meeting; the AI **enhances your notes** using the transcript as supporting context, rather than dumping a summary.
3. Produces notes that are **private by default**, then shareable.
4. Adds memory around the meeting: pre-meeting brief, live Q&A, post-meeting follow-ups, cross-meeting chat.
5. Hides complexity behind calendar sync and one-click "take notes".

Rules worth copying exactly:

- **Manual start only.** Nothing records until the user opens a note / clicks a notification.
- **Audio is never stored.** Transcribe in real time (desktop) or from a temporary cache (mobile), keep only transcript + notes + attachments.
- **No bot, no meeting-platform integration required.** Works with Zoom, Meet, Teams, Slack huddles, FaceTime, WhatsApp, in-person.
- **Web viewer shows summary only, never transcripts** for shared links.
- **Free plan limits history, not note volume** (unlimited notes, 30-day history).
- **Chat history is private to the author**, even when the note is shared.

## 2. Surfaces

| Surface | Role |
|---|---|
| macOS app | Primary capture (system audio + mic), full feature set |
| Windows app | Same as macOS, minus shared-screen snapshots |
| Web (`notes.granola.ai`) | View/edit existing notes, shared-note viewer; cannot capture |
| iOS | In-person capture, outbound phone calls via built-in dialer, Apple Watch start, Chat |
| Android | In-person capture, folder management; no Chat, no phone-call capture |
| MCP server | Notes available inside Claude, ChatGPT, Gemini, Cursor, Copilot, etc. |
| Public API + webhooks | Programmatic notes/transcripts/folders/spaces/audit/legal holds |

## 3. Capture pipeline

### 3.1 Starting capture
- Calendar notification click → opens meeting URL **and** the note, starts transcription.
- Open a calendar meeting after its start time.
- "New Note" button for ad-hoc calls.
- Open an upcoming meeting before it starts → auto-starts at scheduled start time.
- Ad-hoc call detection: mic-in-use triggers a popup ("Call detected" / "Huddle detected" / "Meeting detected", body names the app). If within 15 min after a calendar event, it is associated with that event.

### 3.2 Audio capture
- Desktop: microphone stream + system-audio stream captured separately.
- Transcript bubbles: **grey/left = system audio ("Them")**, **green/right = microphone ("Me")**.
- Captures the combined system output; cannot isolate per-app audio; music/other audio is transcribed.
- No audio/video recording persisted. No pre-recorded file upload/import.
- Requires macOS/Windows desktop; mobile cannot capture other apps' audio, only in-person and (iOS) calls placed through Granola's dialer.

### 3.3 Live meeting UX
- Green dancing bars = recording.
- Transcript panel: show/hide, stop/resume without ending meeting, copy all, copy/delete individual chunks, search transcript.
- Floating "live meeting" indicator when another app is focused: click to return, drag to reposition.
- Images stack (shared-screen snapshots) sits above the chat bar.

### 3.4 Stopping
- Manual stop button.
- Auto-stop when: call-end detected (transcript length + call app mic usage + calendar end time), 15 min of silence, machine sleep.
- Resume transcription on an ended note; re-generate notes to include new audio.
- Back-to-back calls can merge into one transcript; user must stop manually between them.

### 3.5 Speaker attribution
- Speaker tags use participant display names for **Zoom, Google Meet, Microsoft Teams** on macOS/Windows.
- Fallback labels "Me"/"Them"; AI infers names from context and users can correct them.
- Mobile does local diarization (anonymous `Speaker A/B/...`), iOS currently a single audio stream with diarization labels.
- Personal + workspace jargon dictionaries improve transcription accuracy.

### 3.6 Shared-screen snapshots (macOS 14+, Mac app only)
- Auto-captures the screen someone else shares in Zoom desktop, Google Meet in Chrome, Teams desktop/Chrome/Edge. Not Safari/Firefox, not browser Zoom, not Windows.
- Never captures the user's own shared screen. Pauses when the meeting window isn't visible.
- Snapshots attach to the note, feed note generation, and appear in an expandable Images stack; per-meeting disable.
- Requires Screen Recording permission; consent reminder shown.
- Enterprise: off until an admin enables it.

## 4. Notes

### 4.1 Two-layer note model
- **Raw notes**: what the user typed during the meeting (kept, editable, highlighted).
- **Enhanced notes**: generated after the meeting from transcript + raw notes + calendar event metadata.
- Tabs/toggle between raw and enhanced; editing raw and re-enhancing takes the edits into account.
- Enhanced note edits are per-note and do not influence future notes.
- Provenance: magnifier next to a generated point reveals the transcript/raw-note source.
- Regenerate with same template (🔁) or switch template (✨) after generation.
- Templates are applied via `/` during the meeting or post-generation via the "Enhanced" dropdown.

### 4.2 Templates
- Built-in persona-based templates (sales call, 1:1, standup, interview, etc.), chosen by user type from onboarding.
- Custom templates = purpose/context + length/style + section structure (prompt + sections).
- Private by default; can be shared with the whole organization (same email domain only).
- Desktop only for create/apply; mobile notes can receive templates post-sync.
- Desktop-only in practice; mobile notes can be re-templated on desktop.

### 4.3 Note organization
- Note list with multi-select (hover checkbox, shift-click range, select all).
- Notes can belong to multiple folders.
- Drag-and-drop into folders; bulk "Add to folder".
- Deleting/restoring notes.
- Export to CSV (title, summary, transcript, metadata) for backup/migration/GDPR.
- Attachments with plan-based file-size limits.

## 5. Calendar, notifications, briefs

### 5.1 Calendar
- Google Calendar and Outlook (Microsoft) sync; sign-in with Google, Microsoft, or SSO.
- Desktop shows next 14 days; mobile shows a short list.
- Calendar changes made on desktop sync to mobile.
- Calendar event supplies title, attendees, agenda, scheduled end time, and call URL.
- Next meeting card is the primary entry point ("Coming up").

### 5.2 Notifications
- Custom in-app popups (not native OS notifications), configurable globally or **per app**.
- One minute before a calendar meeting **with 2+ attendees**: click opens call URL + note + starts transcription.
- Optional "Reposition Granola for meetings" window behavior.
- Ad-hoc call popups styled with a dashed left edge; calendar popups use a solid colored bar.

### 5.3 Pre-meeting briefs
- Generated overnight for upcoming **external** meetings only.
- Sources: previous Granola notes with the same people/company, shared workspace notes, web/LinkedIn, calendar details, optional Gmail threads.
- 2–3 glanceable bullets: open threads, context, agenda points; shown at the top of the chat panel.
- Business/Enterprise only; currently Google Calendar only; no brief if insufficient signal; thumbs-down feedback.
- Gmail connection optional, read access, disconnectable.

## 6. Post-meeting automation

### 6.1 Suggested follow-up emails
- Paid/trial + Google sign-in + Gmail connected with read **and send** scopes; same email as Granola login (no aliases).
- Trigger: **≥1 external guest and ≤10 attendees**; suppressed when Slack is the active channel, a colleague owns the follow-up, or a blocker precedes next steps.
- Draft appears ~1–2 min after notes finish; surfaced on home ("Suggested follow-up emails", 3 days) and at the top of the note.
- Editor: recipients, CC/BCC, subject, body, formatting, attachments (25 MB total), Gmail signature toggle, placeholder highlighting.
- Send from Gmail; ~10-second undo after send; drafts stored on-device only; attachments not persisted; dismiss is permanent.
- Toggle off in Settings → Preferences.

### 6.2 Chat actions (agentic, with review step)
- Draft/send email (Gmail), draft/send Slack message (channel, group DM, DM; warns on Slack Connect external recipients), find a time and create a Google Calendar event.
- Calendar: availability lookup, suggested times, conflict markers, editable title/attendees/time/description/location/video details.
- Every action produces an editable draft and requires explicit **Send** / **Create event**; nothing auto-sends.
- macOS/Windows only; Google-only for email/calendar; connections are personal and revocable.

## 7. Granola Chat

### 7.1 Scopes
- Home (all notes), single meeting (before/during/after), folder, space, People record, Company record, or a hand-picked selection of meetings.
- Next-gen behavior: scope inferred from where chat is opened; no transcript toggle.
- History available to Chat: free = 30 days; paid = full history.
- Live use: "what's been discussed so far?", "what did Jack just say?".

### 7.2 Models
- **Auto** default (router picks).
- Free: Auto only. Business: standard + thinking models. Enterprise: same, but a specific frontier model (Fable 5) is off until an admin enables it (and then is excluded from ZDR, 30-day provider retention).
- Model picker in chat and in recipe advanced settings.

### 7.3 Capabilities
- Recall, cross-meeting synthesis, themes/patterns, action-item extraction, coaching, drafting documents/emails/specs/briefs.
- Rewrite notes: prompts containing "rewrite" plus optional selected text; adjust detail, fix names, reassign action owners, translate.
- File upload for extra context (desktop only; not iOS).
- Chat history private and deletable per thread.
- Recipes are invoked with `/` in the chat bar.

### 7.4 Recipes
- Saved prompt templates: Discover (Granola/community), My recipes, Workspace recipes; searchable by title and prompt text.
- Create: name, prompt, scope (**Single meetings** or **Multiple meetings** — mutually exclusive), optional model, save.
- Share: private, workspace, or anyone-with-link; link viewers can run it, save it, or remix it, without seeing the author's notes or editing the original.
- Remix creates an editable copy (also lets you change single/multi scope).
- Edit/delete own recipes; static prompts only, no variables/placeholders.
- Public recipe library at recipes.granola.ai with deep links.

## 8. Organization, sharing, collaboration

### 8.1 Spaces
- **My notes** (private) and **Team space** (workspace-visible) by default.
- Admins can create **custom spaces** (name, icon, description, members) for departments/regions/projects; deleting a space removes the container, not the notes.
- Admins own all team-space folders and can move a folder to My notes.
- Per-space toggle "Allow access with a workspace API key" (on by default for new spaces; folders inherit).

### 8.2 Folders
- Create with name, icon, description (description also focuses Chat).
- One level of subfolders; subfolders inherit space and sharing; drag to nest (owners only).
- Notes can live in many folders; auto-add future instances of a recurring meeting to the same folder.
- Folder Chat for insights across its meetings.
- **Auto-post integrations** per folder: Slack, HubSpot, Attio, Zapier, and webhooks — new notes are pushed automatically.

### 8.3 Sharing
- Access controlled by: space, explicit members (email invite), and link access.
- Link modes: **Invited people only**, **Everyone at workspace domain**, **Anyone with the link**.
- Owner vs member permissions: owners change sharing, add/remove members, remove any note, nest/delete the folder; members add their own notes, add/remove members, can leave, cannot change sharing or remove others' notes.
- Non-users can view shared folders/notes in a browser and are prompted to sign up.
- Desktop app collaborators get transcripts; web link viewers get summaries only.
- User groups let admins share spaces/folders with whole teams and keep membership in sync.
- Workspace-wide sharing settings (Enterprise admin).
- Transfer notes between workspaces; import notes from another account/email.

### 8.4 People & Companies
- Auto-built directory from calendar attendees on notes created from events.
- Enriched with avatars, job titles, company info/logo from external sources.
- Each person/company page = all related notes + Chat scoped to them.
- No manual add; skipped if not an attendee, note not created from calendar, or invite declined.

### 8.5 Search
- Search notes and transcripts; grep-style cross-meeting recall via Chat.
- Filter/browse by folder, space, person, company.
- Free plan search limited to 30-day history.

## 9. Integrations

### 9.1 Native (by Granola)
Slack (share to channel; auto-post from folder), Notion (database export), HubSpot, Attio, Affinity (CRM matching by people/company/deal), Gmail (follow-ups, briefs, send), Google Calendar, Outlook, Zapier, Linear (via Zapier), Salesforce (via Zapier), webhooks, public API, MCP.

### 9.2 Via Zapier
Asana, ClickUp, GitHub, Jira, monday.com, Trello, Google Docs, Google Drive, OneDrive, OneNote, Gainsight, Mailchimp, Pipedrive, Salesforce (opportunities/contacts/tasks) — 8,000+ apps.

### 9.3 MCP
- Granola is an MCP server consumed by Claude, ChatGPT, Gemini, Cursor, Figma, Lovable, Manus, Microsoft 365 Copilot, Replit, v0, Grok, Bolt, Tasklet, Duckbill.
- OAuth sign-in with the Granola account; queries notes/transcripts across personal notes and team space; respects permissions.
- Enterprise: **off by default**, admin-controlled; Business: available; Free: personal notes from last 30 days only.

### 9.4 Public API
- Base: `https://public-api.granola.ai/v1`, bearer `grn_...` keys.
- Key scopes: `personal`, `public`, (`workspace` for workspace keys). Enterprise admins gate which scopes members may create.
- Endpoints: List Notes (date filters, folder filters, cursor pagination), Get Note (`include=transcript`, attendees, calendar event, photos), Get Transcript (paginated; `413 TRANSCRIPT_TOO_LARGE` fallback), List Folders (hierarchy via `parent_folder_id`), List Spaces, Audit events, Legal holds (create/list/get/update/release/custodians), Webhook endpoints (create/list/update/delete).
- Only notes with a generated summary + transcript are returned.
- Rate limits: burst 25 requests / 5 s; sustained 5 req/s (300/min); `429` on excess.
- Workspace API keys: workspace-owned, non-expiring, public notes + spaces granted API access.
- Webhooks: HTTPS only, events `note.generated`, `note.edited`, `note.access_granted`; optional `folder_ids` filter; Standard Webhooks HMAC-SHA256 signature; 15 s timeout; retries with exponential backoff for 4 days; auto-disable after 4 days of failure; payload has IDs only, fetch content via API.

## 10. Trust, security, enterprise

### 10.1 Transparency
- **Automated chat message** to meeting participants when transcription starts: Google Meet (Chrome extension, admin-deployable via OU/groups), Zoom + Teams desktop (macOS/Windows), Slack huddles (macOS).
- **Granola Watermark**: a virtual camera showing a "Granola is taking notes" watermark; user selects it as their camera in the meeting app; deployable via MDM.
- **Heads Up**: automatic note/consent line added to calendar invites (Google Calendar automatic, Outlook automatic, or Calendar add-on / Outlook add-in).
- Per-user enablement on Free/Business; admin-enforceable and org-wide on Enterprise.

### 10.2 Data controls
- No third-party model training on customer data; Granola's own training opt-out per user, workspace-wide on Enterprise (off by default for Enterprise).
- Transcript retention windows and auto-deletion; transcript redaction/deletion; audio never stored.
- Admin-configurable sharing, MCP, API, and integration access.
- Legal holds preserve notes/transcripts/attachments for named custodians (API-driven, invisible to custodians).
- Audit API + audit events; usage analytics; centralized billing/user management; domain management to consolidate free accounts.
- SSO/SAML, SCIM provisioning, MDM/Intune app wrapping (iOS), org-wide "Granola is being used" notification.
- SOC 2 Type II, GDPR + DPA, HIPAA workspaces with BAA, EU AI Act alignment; encryption in transit/at rest; US AWS VPC; daily backups.

## 11. Plans and gating (clone the boundaries, not the prices)

| Capability | Free | Business | Enterprise |
|---|---|---|---|
| AI notes, bot-free capture, all apps, speaker tags, templates, recipes, multi-language | ✓ | ✓ | ✓ |
| Note history | 30 days | unlimited | unlimited |
| Chat across meetings | Auto only | Auto + model choice | Auto + model choice |
| Shared folders, Slack | ✓ | ✓ | ✓ |
| Pre-meeting briefs, follow-up emails, workspace dictionary | — | ✓ | ✓ |
| Notion/Zapier/HubSpot/Attio/Affinity, MCP, API, centralized billing | — | ✓ | ✓ |
| Salesforce + advanced integrations | — | — | ✓ |
| SSO/SCIM, HIPAA, audit API, admin MCP/API controls, workspace sharing, retention policy, analytics, MDM | — | — | ✓ |
| Audio deleted after transcription | ✓ | ✓ | ✓ |
| SOC 2, DPA | ✓ | ✓ | ✓ |

## 12. Data model (minimum)

```
User(id, email, name, avatar, job_title, persona, language, org_domain)
Workspace(id, name, domain, plan, settings, retention_policy)
Membership(user_id, workspace_id, role: owner|admin|member)
Space(id, workspace_id, kind: personal|team|custom, name, icon, description, api_enabled)
Folder(id, space_id, parent_id, name, icon, description, created_by)
FolderMember(folder_id, user_id, role: owner|member)
Note(id, workspace_id, owner_id, title, calendar_event_id, status, language,
     raw_notes, enhanced_notes, template_id, duration, created_at, deleted_at)
TranscriptSegment(id, note_id, speaker_source: mic|system, speaker_name, diarization_label,
                  start_ms, end_ms, text, deleted)
Attachment(id, note_id, kind: image|file, url, width, height)
Person(id, workspace_id, email, name, title, company_id, avatar)
Company(id, workspace_id, name, domain, logo)
CalendarAccount(id, user_id, provider, refresh_token, sync_state)
CalendarEvent(id, external_id, title, start, end, attendees[], meeting_url, agenda)
Template(id, owner_id, scope: private|org, name, prompt, sections[])
Recipe(id, owner_id, workspace_id, name, prompt, scope: single|multiple, model, visibility)
ChatThread(id, user_id, scope_type, scope_id, title)
ChatMessage(id, thread_id, role, content, model, attachments[])
Brief(id, note_id, bullets[], sources[], feedback)
FollowUpDraft(id, note_id, user_id, to[], cc[], bcc[], subject, body, status)
IntegrationConnection(id, user_id|workspace_id, provider, scopes, tokens, config)
FolderIntegration(folder_id, provider, config)
ApiKey(id, owner_type, scopes[], prefix, hash, last_used, revoked_at)
WebhookEndpoint(id, owner_type, url, events[], scopes[], folder_ids[], secret, enabled)
AuditEvent(id, workspace_id, actor, action, target, metadata, created_at)
LegalHold(id, workspace_id, name, description, custodians[], released_at)
```

## 13. Engineering challenges to plan for

1. **Dual-stream audio capture.** Separate mic and system audio (ScreenCaptureKit / CoreAudio taps on macOS, WASAPI loopback on Windows) so "Me/Them" and speaker tags work. Handle permissions (microphone, screen recording, accessibility), device changes, and sleep.
2. **Streaming STT.** Low-latency partial transcripts, chunk finalization, diarization, word-level confidence; no audio persistence. Plan a provider abstraction (Deepgram/AssemblyAI-class) with a fallback.
3. **Note generation with provenance.** Prompt = template + profile + calendar metadata + raw notes + transcript. Return structured sections with span references so the magnifier can cite transcript/raw text. Regeneration must be cheap and idempotent.
4. **Retrieval across meetings.** Hybrid keyword + embeddings, strict permission filters (personal/public/space/folder), recency and plan gating. Chat and MCP share the same retrieval layer.
5. **Calendar sync.** Incremental sync, recurrence handling, attendee/external detection, 1-minute scheduler for notifications, call detection correlation window.
6. **Sharing correctness.** Link modes, domain checks, folder inheritance, owner/member capabilities, transcript excluded from web viewer, revocation. This is the highest-risk area for data leaks.
7. **Agentic actions.** Draft → review → confirm with idempotency, per-user OAuth, conflict detection, no silent sends, audit trail.
8. **Enterprise plumbing.** SSO/SCIM, audit log, legal holds, retention jobs, admin policy resolution (workspace → user), encryption, tenant isolation.
9. **MCP + API as products.** OAuth, scope enforcement, rate limits, webhook signing/retries, cursor pagination, workspace keys.

## 14. Suggested build order

**P0 — usable clone**
1. Auth (Google/Microsoft) + workspace + calendar sync.
2. Desktop capture: mic + system audio, live transcript, start/stop/resume, manual-only.
3. Note model: raw notes, enhancement, templates, regenerate, transcript panel, note list/search.
4. Folders, spaces, note sharing, web viewer (summary only), 30-day free gate.
5. Streaming STT + LLM pipeline with provenance.

**P1 — parity that sells it**
6. Chat with scopes + model routing; recipes.
7. Pre-meeting briefs; follow-up email drafts.
8. People & Companies; Slack/Notion/Zapier/HubSpot auto-post.
9. Mobile capture (iOS/Android) + sync; Apple Watch start.
10. MCP server; API keys + notes/transcripts endpoints.

**P2 — enterprise and depth**
11. SSO/SCIM, audit API, legal holds, retention policies, admin controls, usage analytics.
12. Webhooks, workspace API keys, Sentry-style API surface (folders/spaces).
13. Speaker tags per platform, screen snapshots, watermark, automated participant notice, Heads Up.
14. Salesforce/Affinity/Attio depth, per-folder auto-post rules.

## 15. Deliberate non-goals / open questions

- Do **not** build a meeting bot or join calls — it is the core differentiator.
- Do not store audio; if a compliance feature demands it, make it explicit and separate.
- Unknown: exact prompt templates, model routing thresholds, file-size limits per plan, the "insufficient signal" heuristic for briefs/follow-ups, and the precise call-end detection heuristics. Reverse-engineer behavior from the product, not from these docs.
- Free-plan 30-day history is a product decision, not a technical constraint; keep it configurable if cloning commercially.
- Pricing/programs (student, startup, nonprofit, referral, affiliate) are out of scope for a functional clone.
