import type {
  AiConfig,
  CalendarEvent,
  CalendarStatus,
  ChatMessage,
  ChatModel,
  ChatThread,
  Folder,
  ID,
  Note,
  Recipe,
  Scope,
  Section,
  Segment,
  Space,
  SpeakerSource,
  Store,
  StreamTextEvent,
  SttSource,
  Template,
} from '../shared/types.ts';
import {
  buildAttendeeMessages,
  buildChatMessages,
  buildEnhanceMessages,
  calendarEventKey,
  DIARIZATION_MODEL,
  dueReminder,
  encodeWav,
  escapeHtml,
  enhancedText,
  folderDescendants,
  folderPath,
  formatClock,
  formatDuration,
  LOCAL_STT_MODELS,
  localAnswer,
  localEnhance,
  matchSpeaker,
  mergeSegment,
  mergeSettings,
  modelLabel,
  noteSummary,
  parseAttendees,
  parseEnhancedResponse,
  relativeDate,
  retrieve,
  searchNotes,
  STREAM_STT_MODEL,
  toCsv,
  trimPcm,
  truncate,
  type SpeakerProfile,
  type SpeechWindow,
  upcomingEvents,
  visibleNotes,
} from '../shared/logic.ts';
import { createSeed } from '../shared/seed.ts';
import { Capture, LOCAL_CHUNK_MS } from '../capture.ts';
import { html, Html, mount, raw } from './html.ts';
import { brandMark, icon, type IconName } from './icons.ts';

declare global {
  interface Window {
    api: import('../shared/types.ts').Api;
  }
}

type View =
  | { name: 'home' }
  | { name: 'notes' }
  | { name: 'space'; spaceId: ID }
  | { name: 'folder'; folderId: ID }
  | { name: 'note'; noteId: ID }
  | { name: 'people' }
  | { name: 'person'; person: string }
  | { name: 'recipes' }
  | { name: 'calendar' }
  | { name: 'trash' }
  | { name: 'settings' };

type CollectionView = Extract<
  View,
  { name: 'home' | 'calendar' | 'notes' | 'space' | 'folder' | 'person' }
>;

type ConfirmAction =
  | 'delete-note'
  | 'delete-forever'
  | 'empty-trash'
  | 'bulk-delete'
  | 'reset-demo'
  | 'delete-all'
  | 'delete-template'
  | 'delete-recipe'
  | 'delete-space'
  | 'delete-folder';

type Modal =
  | { type: 'folder'; spaceId: ID; parentId: ID | null }
  | { type: 'space'; spaceId?: ID }
  | { type: 'template' }
  | { type: 'recipe' }
  | { type: 'move' }
  | { type: 'share'; noteId: ID; url?: string }
  | {
      type: 'confirm';
      title: string;
      body: string;
      label: string;
      action: ConfirmAction;
      id?: ID;
    }
  | null;

interface UI {
  db: Store;
  ai: AiConfig;
  calendar: {
    status: CalendarStatus;
    events: CalendarEvent[];
    syncing: boolean;
  };
  view: View;
  noteCollection: CollectionView;
  query: string;
  selected: Set<ID>;
  lastCheckedId: ID | null;
  chatOpen: boolean;
  chatScope: Scope | null;
  threadId: ID | null;
  chatDraft: string;
  chatBusy: boolean;
  chatModel: ChatModel;
  chatMenu: boolean;
  modal: Modal;
  toast: string | null;
  noteTab: 'enhanced' | 'raw' | 'transcript';
  transcriptQuery: string;
  generatingNoteId: ID | null;
  sttError: string;
  sttWarned: boolean;
  sttDownload: { file: string; percent: number } | null;
  focusTitle: boolean;
  focusChat: boolean;
  transcriptHidden: boolean;
  railClosed: boolean;
}

const root = document.getElementById('app');
let ui: UI;
let capture: Capture;
let recordingNoteId: ID | null = null;
let recordingBaseMs = 0;
// Voices heard in the current recording, keyed by note and start offset.
const speakerProfiles = new Map<string, SpeakerProfile[]>();
let pendingTranscriptions = 0;
let listRenderTimer: number | null = null;
let detectedMeeting: CalendarEvent | null = null;
let meetingBannerDismissed = false;

/**
 * Live streaming state per audio source. `committed` is the prefix already
 * written to the note; `fromMs`/`endMs` bound the audio it covers.
 */
interface LiveFeed {
  noteId: ID;
  baseMs: number;
  committed: string;
  tail: string;
  fromMs: number;
  endMs: number;
}

const liveFeeds = new Map<SpeakerSource, LiveFeed>();
let liveSources: SpeakerSource[] = [];
const livePushes = new Map<SpeakerSource, Promise<void>>();

interface ChunkJob {
  noteId: ID;
  baseMs: number;
  source: 'mic' | 'system';
  blob: Blob;
  startMs: number;
  endMs: number;
  speech: SpeechWindow;
  /** Temp file written when the chunk was queued, deleted once transcribed. */
  pendingPath: string | null;
}

const busySources = new Set<'mic' | 'system'>();
const queuedChunks = new Map<'mic' | 'system', ChunkJob[]>();
let toastTimer: number | null = null;
let saveTimer: number | null = null;
let saveFailed = false;

const CALENDAR_OFF: CalendarStatus = {
  connected: false,
  provider: null,
  email: '',
  name: '',
  lastSyncedAt: null,
  error: null,
};
let reminder: CalendarEvent | null = null;
const remindedEvents = new Set<string>();

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const noteById = (id: ID | undefined | null) =>
  id ? (ui.db.notes.find((note) => note.id === id) ?? null) : null;
const spaceById = (id: ID) => ui.db.spaces.find((space) => space.id === id);
const folderById = (id: ID) => ui.db.folders.find((folder) => folder.id === id);
const templateById = (id: ID | null) =>
  id ? (ui.db.templates.find((template) => template.id === id) ?? null) : null;
const currentNote = () =>
  ui.view.name === 'note' ? noteById(ui.view.noteId) : null;

function toast(message: string): void {
  ui.toast = message;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  renderToast(true);
  toastTimer = window.setTimeout(() => {
    ui.toast = null;
    renderToast();
  }, 4200);
}

function persist(immediate = false): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  const write = () => {
    window.api
      .save(ui.db)
      .then(() => {
        saveFailed = false;
      })
      .catch((error: unknown) => {
        console.error(error);
        if (!saveFailed) {
          saveFailed = true;
          toast('Changes could not be saved to disk.');
        }
      });
  };
  if (immediate) write();
  else saveTimer = window.setTimeout(write, 1000);
}

function touch(note: Note): void {
  note.updatedAt = nowIso();
}

function sameScope(a: Scope, b: Scope): boolean {
  if (a.type !== b.type) return false;
  if (a.id || b.id) return a.id === b.id;
  return a.label === b.label;
}

function scopeForView(): Scope {
  if (ui.view.name === 'note') {
    const note = noteById(ui.view.noteId);
    return {
      type: 'note',
      id: ui.view.noteId,
      label: note?.title ?? 'This meeting',
    };
  }
  if (ui.view.name === 'folder') {
    const folder = folderById(ui.view.folderId);
    return {
      type: 'folder',
      id: ui.view.folderId,
      label: folder?.name ?? 'Folder',
    };
  }
  if (ui.view.name === 'space') {
    const space = spaceById(ui.view.spaceId);
    return {
      type: 'space',
      id: ui.view.spaceId,
      label: space?.name ?? 'Space',
    };
  }
  if (ui.view.name === 'person') {
    return { type: 'person', label: ui.view.person };
  }
  return { type: 'all', label: 'All notes' };
}

function startChat(animate: boolean): void {
  const scope = scopeForView();
  if (ui.chatScope && !sameScope(ui.chatScope, scope)) ui.chatDraft = '';
  ui.chatScope = scope;
  const existing = [...ui.db.threads]
    .filter((thread) => sameScope(thread.scope, scope))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  ui.threadId = existing?.id ?? null;
  ui.chatModel = existing?.model ?? ui.chatModel;
  ui.chatMenu = false;
  setChatOpen(true, animate);
  focusChatInput();
}

function newThread(): void {
  const scope = ui.chatScope ?? scopeForView();
  const thread: ChatThread = {
    id: uid(),
    scope,
    title: 'New conversation',
    model: ui.chatModel,
    createdAt: nowIso(),
    messages: [],
  };
  ui.db.threads.push(thread);
  ui.threadId = thread.id;
  ui.chatDraft = '';
  persist();
  renderAll();
  ui.focusChat = true;
  focusChatInput();
}

function ensureThread(question: string): ChatThread {
  let thread = ui.db.threads.find((entry) => entry.id === ui.threadId);
  if (thread) return thread;
  const scope = ui.chatScope ?? scopeForView();
  thread = {
    id: uid(),
    scope,
    title: truncate(question, 60),
    model: ui.chatModel,
    createdAt: nowIso(),
    messages: [],
  };
  ui.db.threads.push(thread);
  ui.threadId = thread.id;
  return thread;
}

async function sendChat(): Promise<void> {
  const question = ui.chatDraft.trim();
  if (!question || ui.chatBusy) return;
  const scope = ui.chatScope ?? scopeForView();
  const thread = ensureThread(question);
  thread.messages.push({
    id: uid(),
    role: 'user',
    content: question,
    createdAt: nowIso(),
  });
  if (thread.title === 'New conversation')
    thread.title = truncate(question, 60);
  thread.model = ui.chatModel;
  ui.chatDraft = '';
  ui.chatBusy = true;
  persist();
  renderChat();
  focusChatInput();

  const hits = retrieve(ui.db, scope, question);
  let answer = '';
  let model = 'Local extract';
  if (ui.ai.configured) {
    try {
      const history = thread.messages
        .slice(0, -1)
        .slice(-8)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }));
      const response = await window.api.complete({
        messages: buildChatMessages(
          question,
          hits,
          history,
          scope.type === 'note',
        ),
        model: thread.model,
      });
      answer = response.text.trim();
      model =
        thread.model === 'thinking'
          ? ui.ai.thinkingModel
          : thread.model === 'standard'
            ? ui.ai.chatModel
            : `Auto · ${ui.ai.chatModel}`;
    } catch (error) {
      console.error(error);
      toast('The model is unavailable. Answered from your notes locally.');
      answer = localAnswer(question, hits);
    }
  } else {
    answer = localAnswer(question, hits);
  }
  if (!answer) answer = localAnswer(question, hits);
  thread.messages.push({
    id: uid(),
    role: 'assistant',
    content: answer,
    model,
    createdAt: nowIso(),
  });
  ui.chatBusy = false;
  persist();
  const wasTyping = document.activeElement?.id === 'chat-input';
  renderChat();
  if (wasTyping) focusChatInput();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function createCapture(): Capture {
  const capture = new Capture(
    {
      onLevel: updateMeters,
      onChunk: (source, blob, start, end, speech) => {
        if (!recordingNoteId) return;
        if (ui.ai.sttSource === 'nemotron-streaming') {
          pushLiveChunk(
            source,
            recordingNoteId,
            recordingBaseMs,
            blob,
            start,
            end,
          );
          return;
        }
        void queueChunk({
          noteId: recordingNoteId,
          baseMs: recordingBaseMs,
          source,
          blob,
          startMs: start,
          endMs: end,
          speech,
          pendingPath: null,
        });
      },
      onState: handleCaptureState,
      onNotice: (message) => toast(message),
      onAutoStop: (reason) => {
        toast(`Recording stopped automatically: ${reason}.`);
        void stopRecording();
      },
    },
    () =>
      ui.ai.sttSource === 'nemotron-streaming'
        ? 1000
        : ui.ai.sttSource === 'cloud'
          ? 7000
          : LOCAL_CHUNK_MS,
  );
  capture.setSensitivity(ui.db.settings.vadSensitivity ?? 0.5);
  return capture;
}

function updateMeters(me: number, them: number): void {
  const meBar = document.getElementById('meter-me');
  const themBar = document.getElementById('meter-them');
  if (meBar) meBar.style.transform = `scaleX(${Math.max(0.04, me)})`;
  if (themBar) themBar.style.transform = `scaleX(${Math.max(0.04, them)})`;
  const timer = document.getElementById('rec-timer');
  if (timer && capture?.isRunning) {
    timer.textContent = formatClock(recordingBaseMs + capture.elapsedMs);
  }
}

function handleCaptureState(state: 'recording' | 'paused' | 'stopped'): void {
  const note = noteById(recordingNoteId);
  if (!note) return;
  if (state === 'stopped') {
    finalizeRecording();
    return;
  }
  note.status = state;
  touch(note);
  persist();
  mount(document.getElementById('capture-shortcut'), captureShortcut());
  renderList();
  renderMain();
}

function finalizeRecording(): void {
  const note = noteById(recordingNoteId);
  recordingNoteId = null;
  // Closing the engine's input flushes its last words; the final update still
  // arrives and lands in the note because the feed remembers its note.
  void stopLiveStreams();
  if (!note) return;
  note.status = 'ended';
  note.endedAt = nowIso();
  note.durationMs = Math.max(
    note.durationMs,
    recordingBaseMs + capture.elapsedMs,
  );
  touch(note);
  persist();
  ui.sttError = '';
  renderAll();
  void completeMeeting(note);
}

async function completeMeeting(note: Note): Promise<void> {
  await waitForTranscriptions();
  const fresh = noteById(note.id);
  if (!fresh) return;
  if (!fresh.rawNotes.trim() && fresh.transcript.length === 0) return;
  if (!ui.db.settings.autoEnhance || fresh.enhanced) {
    await detectAttendees(fresh);
    return;
  }
  await enhanceNote(fresh.id);
}

/** Fill the attendee list from the transcript when nothing else supplied it. */
async function detectAttendees(note: Note): Promise<void> {
  if (!ui.ai.configured || note.attendees.length > 0) return;
  if (note.transcript.length === 0) return;
  try {
    const { text } = await window.api.complete({
      messages: buildAttendeeMessages(note),
      model: 'auto',
      json: true,
    });
    const names = parseAttendees(text);
    const fresh = noteById(note.id);
    if (!fresh || fresh.attendees.length > 0 || names.length === 0) return;
    fresh.attendees = names;
    touch(fresh);
    persist();
    if (ui.view.name === 'note' && ui.view.noteId === fresh.id) renderMain();
    toast(
      `${names.length} ${names.length === 1 ? 'person' : 'people'} found in the transcript.`,
    );
  } catch (error) {
    console.error(error);
  }
}

async function waitForTranscriptions(limitMs = 20_000): Promise<void> {
  const started = performance.now();
  while (pendingTranscriptions > 0 && performance.now() - started < limitMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
}

async function startRecording(note: Note): Promise<void> {
  if (recordingNoteId && recordingNoteId !== note.id) {
    toast('Stop the current recording before starting another note.');
    return;
  }
  if (capture.isRunning) return;
  recordingBaseMs = note.status === 'ended' ? note.durationMs : 0;
  recordingNoteId = note.id;
  // A new session gets fresh labels; old voices must not leak into it.
  speakerProfiles.clear();
  note.status = 'recording';
  note.startedAt = note.startedAt ?? nowIso();
  note.endedAt = null;
  ui.sttError = '';
  ui.sttWarned = false;
  ui.noteTab = 'raw';
  touch(note);
  persist();
  renderAll();
  try {
    await capture.start(ui.db.settings.includeSystemAudio);
    await startLiveStreams();
  } catch (error) {
    recordingNoteId = null;
    note.status = note.durationMs > 0 ? 'ended' : 'draft';
    persist();
    renderAll();
    toast(
      error instanceof Error ? error.message : 'Recording could not start.',
    );
  }
}

async function pauseRecording(): Promise<void> {
  if (capture.isRunning) capture.pause();
}

async function resumeRecording(): Promise<void> {
  if (capture.isRunning) capture.resume();
}

async function stopRecording(): Promise<void> {
  if (capture?.isRunning) await capture.stop();
}

function warnNoModel(): void {
  if (ui.sttWarned) return;
  ui.sttWarned = true;
  ui.sttError =
    'Transcription needs a speech-to-text model. Pick a cloud provider or download one in Settings → Models. Audio is not saved.';
  toast('Transcription is unavailable. You can still take notes.');
  if (ui.view.name === 'note') renderMain();
}

async function persistPendingChunk(job: ChunkJob): Promise<string | null> {
  try {
    return await window.api.audioRetention.writePending({
      noteId: job.noteId,
      source: job.source,
      arrayBuffer: await job.blob.arrayBuffer(),
      startMs: job.startMs,
      endMs: job.endMs,
      speechStartMs: job.speech.startMs,
      speechEndMs: job.speech.endMs,
      baseMs: job.baseMs,
      language: ui.db.settings.sttLanguage,
      prompt: sttPrompt(noteById(job.noteId), ui.db.settings.sttLanguage),
    });
  } catch (error) {
    console.error('Failed to write pending chunk:', error);
    return null;
  }
}

/**
 * Live transcription keeps one engine running per audio source and feeds it
 * short chunks as they are captured, so text lands while the person is still
 * talking instead of after a 15-second pause.
 */
function liveStreaming(): boolean {
  return ui.ai.sttSource === 'nemotron-streaming';
}

async function startLiveStreams(): Promise<void> {
  if (!liveStreaming()) return;
  if (!ui.ai.sttReady) {
    warnNoModel();
    return;
  }
  liveSources = [...capture.sources];
  for (const source of liveSources) {
    pendingTranscriptions += 1;
    try {
      await window.api.streamStart(source, ui.db.settings.sttLanguage);
    } catch (error) {
      pendingTranscriptions = Math.max(0, pendingTranscriptions - 1);
      liveSources = liveSources.filter((entry) => entry !== source);
      reportStreamError(ipcMessage(error, 'The live engine could not start.'));
    }
  }
}

async function stopLiveStreams(): Promise<void> {
  const sources = liveSources;
  liveSources = [];
  // A chunk captured in the last second may still be decoding; the engine has
  // to see it before its input closes or the final words are lost.
  await Promise.allSettled(livePushes.values());
  for (const source of sources) {
    if (liveSources.includes(source)) continue;
    void window.api.streamStop(source);
  }
}

function pushLiveChunk(
  source: SpeakerSource,
  noteId: ID,
  baseMs: number,
  blob: Blob,
  startMs: number,
  endMs: number,
): void {
  const feed = liveFeeds.get(source);
  if (feed && feed.noteId === noteId) feed.endMs = endMs;
  else
    liveFeeds.set(source, {
      noteId,
      baseMs,
      committed: '',
      tail: '',
      fromMs: startMs,
      endMs,
    });
  // Decode one chunk at a time: two parallel decodes could reach the engine
  // out of order and break its sense of the timeline.
  livePushes.set(
    source,
    (livePushes.get(source) ?? Promise.resolve())
      .then(async () => {
        // Untrimmed on purpose: the engine wants continuous audio, and the
        // capture layer already dropped chunks without speech.
        window.api.streamPush(source, await blobToPcm(blob));
      })
      .catch((error: unknown) =>
        console.error('Live audio push failed:', error),
      ),
  );
}

function handleStreamText(event: StreamTextEvent): void {
  if (event.final)
    pendingTranscriptions = Math.max(0, pendingTranscriptions - 1);
  if (event.error) {
    reportStreamError(event.error);
    liveFeeds.delete(event.source);
    return;
  }
  const feed = liveFeeds.get(event.source);
  if (!feed) return;
  // Committed text only grows; anything else is the engine starting over on a
  // bad hypothesis, so drop what it withdrew instead of duplicating it.
  const fresh = event.committed.startsWith(feed.committed)
    ? event.committed.slice(feed.committed.length)
    : '';
  feed.committed = event.committed;
  feed.tail = event.tentative;
  const note = noteById(feed.noteId);
  if (fresh.trim() && note && !note.deletedAt) {
    addTranscriptSegment(
      note,
      event.source,
      fresh.trim(),
      feed.fromMs,
      feed.endMs,
      feed.baseMs,
    );
    feed.fromMs = feed.endMs;
  } else {
    renderTranscript();
  }
  if (event.final) liveFeeds.delete(event.source);
}

function reportStreamError(message: string): void {
  if (ui.sttWarned) return;
  ui.sttWarned = true;
  ui.sttError = `Live transcription stopped: ${message}`;
  toast('Live transcription stopped. Your notes are still being saved.');
  if (ui.view.name === 'note') renderMain();
}

async function queueChunk(job: ChunkJob): Promise<void> {
  if (!ui.ai.sttReady) {
    warnNoModel();
    return;
  }
  pendingTranscriptions += 1;
  // The temp copy is what survives a quit or a crash before transcription.
  job.pendingPath = await persistPendingChunk(job);
  const queue = queuedChunks.get(job.source) ?? [];
  queue.push(job);
  queuedChunks.set(job.source, queue);
  if (!busySources.has(job.source)) void runChunks(job.source);
}

async function runChunks(source: 'mic' | 'system'): Promise<void> {
  busySources.add(source);
  try {
    for (;;) {
      const job = queuedChunks.get(source)?.shift();
      if (!job) break;
      try {
        await transcribeChunk(job);
      } finally {
        pendingTranscriptions = Math.max(0, pendingTranscriptions - 1);
      }
    }
  } finally {
    busySources.delete(source);
    queuedChunks.delete(source);
  }
}

async function transcribeChunk(job: ChunkJob): Promise<void> {
  try {
    const local = ui.ai.sttSource !== 'cloud';
    const prompt = sttPrompt(noteById(job.noteId), ui.db.settings.sttLanguage);
    const pcm = trimPcm(await blobToPcm(job.blob), job.speech);
    const { text } = await window.api.transcribe(
      local
        ? { pcm, language: ui.db.settings.sttLanguage, prompt }
        : {
            data: encodeWav(pcm).buffer,
            mime: 'audio/wav',
            language: ui.db.settings.sttLanguage,
            prompt,
          },
    );
    // The provider took the audio (empty text included), so nothing to retry.
    if (job.pendingPath) {
      await window.api.audioRetention.deletePending(job.pendingPath);
      job.pendingPath = null;
    }
    const note = noteById(job.noteId);
    // Chunks outlive a note that was trashed mid-flight; don't write into it.
    if (!note || note.deletedAt || !text.trim()) return;

    const speaker = await systemSpeaker(job, pcm);
    addTranscriptSegment(
      note,
      job.source,
      text.trim(),
      job.startMs + job.speech.startMs,
      job.startMs + job.speech.endMs,
      job.baseMs,
      speaker?.label,
      speaker?.score,
    );
  } catch (error) {
    console.error(error);
    // Keep a temp copy for retry when the queue-time write failed.
    if (!job.pendingPath) job.pendingPath = await persistPendingChunk(job);

    if (!ui.sttWarned) {
      ui.sttWarned = true;
      const message = error instanceof Error ? error.message : '';
      const unreachable =
        /fetch failed|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(
          message,
        );
      ui.sttError = unreachable
        ? 'Could not reach the transcription server. Check your connection, the base URL, or switch to a local model in Settings → Models. Audio saved for retry.'
        : 'Transcription failed. Check the provider key and model in Settings → Models. Audio saved for retry.';
      toast(
        unreachable
          ? 'Transcription server unreachable. Audio saved for retry on restart.'
          : 'Transcription failed. Audio saved for retry on restart.',
      );
      if (ui.view.name === 'note') renderMain();
    }
  }
}

/** Label for one system-audio chunk, or null when labeling is off/unready. */
async function systemSpeaker(
  job: ChunkJob,
  pcm: Float32Array,
): Promise<{ label: string; score: number } | null> {
  if (
    job.source !== 'system' ||
    !ui.db.settings.diarizationEnabled ||
    !ui.ai.diarizationReady
  ) {
    return null;
  }
  try {
    const embedding = await window.api.diarize(pcm);
    const key = `${job.noteId}:${job.baseMs}`;
    const profiles = speakerProfiles.get(key) ?? [];
    const match = matchSpeaker(profiles, embedding);
    speakerProfiles.set(key, profiles);
    return { label: match.profile.label, score: match.score };
  } catch (error) {
    // A missing or broken voice model must never cost a transcript.
    console.error('Speaker labeling failed:', error);
    return null;
  }
}

/** Meeting words prime Whisper's decoder so names and terms come out right.
 *  The scaffolding follows the transcript language: an English "Meeting:" in
 *  front of Arabic audio nudges the decoder toward English output. */
const PROMPT_LABELS: Record<string, [meeting: string, participants: string]> = {
  ar: ['الاجتماع', 'المشاركون'],
};

function sttPrompt(note: Note | null, language: string): string | undefined {
  if (!note) return undefined;
  const [meetingLabel, participantsLabel] = PROMPT_LABELS[language] ?? [
    'Meeting',
    'Participants',
  ];
  const title = note.title.trim();
  const parts = /^(new note|untitled)/i.test(title)
    ? []
    : [`${meetingLabel}: ${title}.`];
  const people = note.attendees
    .map((person) => person.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (people.length > 0)
    parts.push(`${participantsLabel}: ${people.join(', ')}.`);
  return parts.join(' ').slice(0, 300) || undefined;
}

/** Chromium decodes the recorder's webm/opus; Whisper wants 16 kHz mono PCM. */
async function blobToPcm(blob: Blob): Promise<Float32Array> {
  // Offline context: decodes and resamples to 16 kHz without opening an audio
  // output device (a realtime AudioContext needs one).
  const context = new OfflineAudioContext(1, 1, 16000);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  return decoded.getChannelData(0);
}

function addTranscriptSegment(
  note: Note,
  source: 'mic' | 'system',
  text: string,
  startMs: number,
  endMs: number,
  baseMs: number,
  speaker?: string,
  speakerConfidence?: number | null,
  voicePrintId?: string | null,
): void {
  const segment: Segment = {
    id: crypto.randomUUID(),
    source,
    speaker: speaker ?? (source === 'mic' ? 'Me' : 'Them'),
    text,
    startMs: baseMs + startMs,
    endMs: baseMs + endMs,
    speakerConfidence: speakerConfidence ?? null,
    voicePrintId: voicePrintId ?? null,
  };
  const sorted = [...note.transcript, segment].sort(
    (a, b) => a.startMs - b.startMs,
  );
  let merged: Segment[] = [];
  for (const entry of sorted) {
    merged = mergeSegment(merged, entry, 1200, 380);
  }
  note.transcript = merged;
  touch(note);
  persist();
  if (ui.view.name === 'note' && ui.view.noteId === note.id) {
    renderTranscript();
    updateTranscriptCount();
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** Electron prefixes IPC failures; keep the sentence the user needs. */
function ipcMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function refreshCalendar(): Promise<void> {
  if (!ui.calendar.status.connected || ui.calendar.syncing) return;
  ui.calendar.syncing = true;
  const syncButton = document.querySelector<HTMLButtonElement>(
    '[data-act="calendar-sync"]',
  );
  const hadSyncFocus = syncButton && document.activeElement === syncButton;
  if (syncButton) {
    syncButton.disabled = true;
    syncButton.textContent = 'Syncing…';
  }
  try {
    ui.calendar.events = await window.api.calendarEvents();
    ui.calendar.status = {
      ...ui.calendar.status,
      lastSyncedAt: nowIso(),
      error: null,
    };
  } catch (error) {
    ui.calendar.status = {
      ...ui.calendar.status,
      error: ipcMessage(error, 'Calendar sync failed.'),
    };
  } finally {
    ui.calendar.syncing = false;
    if (ui.view.name === 'home' || ui.view.name === 'calendar') {
      renderMain();
    } else if (ui.view.name === 'settings') {
      mount(document.getElementById('calendar-settings'), calendarSettings());
    }
    if (
      hadSyncFocus &&
      (document.activeElement === document.body ||
        document.activeElement === syncButton)
    ) {
      document
        .querySelector<HTMLButtonElement>('[data-act="calendar-sync"]')
        ?.focus({ preventScroll: true });
    }
    checkReminder();
  }
}

async function connectCalendarFromForm(
  provider: 'google' | 'microsoft',
  clientId: string,
  clientSecret: string,
): Promise<void> {
  if (!clientId) {
    toast('Add the OAuth client ID first.');
    return;
  }
  toast('Finish sign-in in your browser…');
  try {
    const status = await window.api.calendarConnect({
      provider,
      clientId,
      clientSecret,
    });
    ui.calendar.status = status;
    if (status.email) {
      ui.db.user.email = status.email;
      if (status.name) ui.db.user.name = status.name;
    }
    persist();
    await refreshCalendar();
    renderAll();
    toast('Calendar connected. Lilt can now read the next two weeks.');
  } catch (error) {
    toast(ipcMessage(error, 'Calendar sign-in failed.'));
  }
}

async function disconnectCalendar(): Promise<void> {
  try {
    ui.calendar.status = await window.api.calendarDisconnect();
    ui.calendar.events = [];
    reminder = null;
    renderAll();
    toast('Calendar disconnected. Notes and transcripts are unaffected.');
  } catch {
    toast('Could not disconnect the calendar.');
  }
}

function checkReminder(): void {
  if (!ui.db.settings.notifications || !ui.calendar.status.connected) return;
  if (reminder) {
    const ends = Date.parse(reminder.start) + 10 * 60_000;
    if (Date.now() > ends) dismissReminder();
    return;
  }
  const due = dueReminder(ui.calendar.events, Date.now(), remindedEvents);
  if (!due) return;
  remindedEvents.add(calendarEventKey(due));
  reminder = due;
  renderReminder();
}

function dismissReminder(): void {
  reminder = null;
  renderReminder();
}

function renderReminder(): void {
  mount(document.getElementById('reminder-root'), reminderView(true));
}

function reminderView(animate = false): Html {
  if (!reminder) return html``;
  return html`<div
    class="reminder-card"
    data-motion="${animate}"
    role="status"
    aria-live="polite"
  >
    <div class="reminder-head">
      ${icon('calendar', 13)} <span>Meeting in a minute</span>
    </div>
    <strong class="reminder-title">${reminder.title}</strong>
    <span class="reminder-meta"
      >${eventTime(reminder)}${reminder.attendees.length ? ` · ${reminder.attendees.length} people` : ''}</span
    >
    <div class="reminder-actions">
      <button
        class="primary-btn small"
        data-act="start-event"
        data-key="${calendarEventKey(reminder)}"
      >
        ${icon('mic', 12)} Join & take notes
      </button>
      <button class="text-btn" data-act="dismiss-reminder">Dismiss</button>
    </div>
  </div>`;
}

function renderMeetingBanner(): void {
  mount(
    document.getElementById('meeting-banner-root'),
    meetingBannerView(true),
  );
}

function meetingBannerView(animate = false): Html {
  if (!detectedMeeting || meetingBannerDismissed) return html``;
  const isCalendarEvent = Boolean(detectedMeeting.meetingUrl);
  return html`<div
    class="meeting-banner"
    data-motion="${animate}"
    role="status"
    aria-live="polite"
  >
    <div class="meeting-banner-head">
      ${icon('calendar', 13)}
      <span
        >${isCalendarEvent ? 'Calendar meeting detected' : 'Call detected'}</span
      >
      <button
        class="icon-btn"
        data-act="dismiss-meeting-banner"
        title="Dismiss"
      >
        ${icon('x', 14)}
      </button>
    </div>
    <strong class="meeting-banner-title">${detectedMeeting.title}</strong>
    ${detectedMeeting.meetingUrl ? html`<span class="meeting-banner-meta">${icon('external', 12)} ${detectedMeeting.meetingUrl}</span>` : ''}
    ${detectedMeeting.attendees.length ? html`<span class="meeting-banner-meta">${icon('people', 12)} ${detectedMeeting.attendees.slice(0, 3).join(', ')}${detectedMeeting.attendees.length > 3 ? ` +${detectedMeeting.attendees.length - 3}` : ''}</span>` : ''}
    <div class="meeting-banner-actions">
      <button class="primary-btn small" data-act="start-meeting-notes">
        ${icon('mic', 12)} Start notes
      </button>
      <button class="text-btn" data-act="dismiss-meeting-banner">
        Dismiss
      </button>
    </div>
  </div>`;
}

function dismissMeetingBanner(): void {
  meetingBannerDismissed = true;
  detectedMeeting = null;
  renderMeetingBanner();
}

let handledMeetingKey: string | null = null;

function handleMeetingDetected(event: CalendarEvent): void {
  if (
    !ui.db.settings.meetingDetectionEnabled &&
    !ui.db.settings.autoStartMeetingRecording
  ) {
    return;
  }
  const key = event.id ?? `${event.title}@${event.start}`;
  if (key === handledMeetingKey) return;
  handledMeetingKey = key;

  if (
    ui.db.settings.autoStartMeetingRecording &&
    (event.id || event.meetingUrl)
  ) {
    const existing = eventNote(event);
    if (!capture.isRunning && (!existing || existing.status === 'draft')) {
      const note = existing ?? createNoteFromEvent(event);
      openNote(note.id);
      void startRecording(note);
    }
    return;
  }

  detectedMeeting = event;
  meetingBannerDismissed = false;
  renderMeetingBanner();
}

async function startMeetingNotesFromBanner(): Promise<void> {
  if (!detectedMeeting) return;
  const note =
    eventNote(detectedMeeting) ?? createNoteFromEvent(detectedMeeting);
  openNote(note.id);
  if (!capture.isRunning) await startRecording(note);
  if (detectedMeeting.meetingUrl)
    window.open(detectedMeeting.meetingUrl, '_blank');
  dismissMeetingBanner();
}

const eventByKey = (key: string | undefined) =>
  key
    ? (ui.calendar.events.find((event) => calendarEventKey(event) === key) ??
      null)
    : null;

function eventNote(event: CalendarEvent): Note | null {
  return (
    ui.db.notes.find(
      (note) =>
        note.calendarEvent !== null &&
        !note.deletedAt &&
        ((event.id && note.calendarEvent.id === event.id) ||
          (note.calendarEvent.title === event.title &&
            note.calendarEvent.start === event.start)),
    ) ?? null
  );
}

function createNoteFromEvent(event: CalendarEvent): Note {
  const note: Note = {
    id: uid(),
    spaceId: 'space-personal',
    folderIds: [],
    title: event.title,
    status: 'draft',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    attendees: [...event.attendees],
    calendarEvent: event,
    rawNotes: '',
    enhanced: null,
    templateId: null,
    transcript: [],
    deletedAt: null,
    share: { mode: 'off', token: null },
  };
  ui.db.notes.unshift(note);
  persist();
  return note;
}

function openEvent(event: CalendarEvent): void {
  const note = eventNote(event) ?? createNoteFromEvent(event);
  openNote(note.id);
  if (!capture.isRunning) void startRecording(note);
  if (event.meetingUrl) window.open(event.meetingUrl, '_blank');
  dismissReminder();
}

function eventTime(event: CalendarEvent): string {
  return new Date(event.start).toLocaleTimeString('en', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function eventDayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return date.toLocaleDateString('en', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function startsInLabel(event: CalendarEvent): string {
  const diff = Date.parse(event.start) - Date.now();
  if (diff <= 60_000) return 'Starting now';
  if (diff < 3_600_000) return `In ${Math.round(diff / 60_000)} min`;
  if (diff < 86_400_000) return `In ${Math.round(diff / 3_600_000)} h`;
  return eventDayLabel(event.start);
}

function eventRow(event: CalendarEvent): Html {
  const note = eventNote(event);
  return html`<div class="event-row">
    <div class="event-time">
      <strong>${eventTime(event)}</strong>
      <span
        >${formatDuration(Date.parse(event.end) - Date.parse(event.start))}</span
      >
    </div>
    <div class="event-body">
      <strong>${event.title}</strong>
      <span class="event-meta">
        ${event.attendees.length ? event.attendees.slice(0, 4).join(', ') : 'No attendees yet'}
        ${event.attendees.length > 4 ? ` +${event.attendees.length - 4}` : ''}
      </span>
      ${event.agenda ? html`<span class="event-agenda">${truncate(event.agenda, 150)}</span>` : ''}
    </div>
    <div class="event-actions">
      ${note ? html`<button class="text-btn" data-act="open-note" data-id="${note.id}">Open note</button>` : ''}
      <button
        class="ghost-btn small"
        data-act="start-event"
        data-key="${calendarEventKey(event)}"
      >
        ${icon('mic', 13)} ${event.meetingUrl ? 'Record and join' : 'Record'}
      </button>
      ${event.meetingUrl ? html`<button class="ghost-btn small" data-act="join-link" data-key="${calendarEventKey(event)}">${icon('external', 12)} Join</button>` : ''}
    </div>
  </div>`;
}

function calendarView(): Html {
  const status = ui.calendar.status;
  const events = upcomingEvents(ui.calendar.events);
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = eventDayLabel(event.start);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return html`<div class="page calendar-page">
    <header class="page-head page-head-actions">
      <div>
        <h1>Calendar</h1>
        ${status.connected ? html`<p class="lede">Next 14 days</p>` : ''}
      </div>
      ${
        status.connected
          ? html`<div class="page-actions">
              <button
                class="ghost-btn"
                data-act="calendar-sync"
                ${ui.calendar.syncing ? raw('disabled') : ''}
              >
                ${icon('refresh', 13)}
                ${ui.calendar.syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>`
          : html`<div class="page-actions">
              <button
                class="primary-btn"
                data-act="nav"
                data-view="settings"
                data-section="calendar"
              >
                ${icon('calendar', 13)} Connect a calendar
              </button>
            </div>`
      }
    </header>
    ${status.error ? html`<p class="calendar-error">${status.error}</p>` : ''}
    ${
      !status.connected
        ? html`<div class="blank-state">
            <h2>No calendar connected</h2>
            <p>Connect Google Calendar or Outlook to see upcoming meetings.</p>
          </div>`
        : events.length === 0
          ? html`<div class="blank-state">
              <h2>No meetings in the next 14 days</h2>
            </div>`
          : html`<div class="calendar-list">
              ${[...groups].map(
                ([day, list]) =>
                  html`<section class="calendar-day">
                    <h2>${day}</h2>
                    ${list.map((event) => eventRow(event))}
                  </section>`,
              )}
            </div>`
    }
  </div>`;
}

// ---------------------------------------------------------------------------
// Notes, enhancement, sharing
// ---------------------------------------------------------------------------

function addNote(): void {
  const spaceId =
    ui.view.name === 'space'
      ? ui.view.spaceId
      : ui.view.name === 'folder'
        ? (folderById(ui.view.folderId)?.spaceId ?? 'space-personal')
        : ui.view.name === 'note'
          ? (noteById(ui.view.noteId)?.spaceId ?? 'space-personal')
          : 'space-personal';
  const folderIds = ui.view.name === 'folder' ? [ui.view.folderId] : [];
  const note: Note = {
    id: uid(),
    spaceId,
    folderIds,
    title: 'New note',
    status: 'draft',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    attendees: [],
    calendarEvent: null,
    rawNotes: '',
    enhanced: null,
    templateId: null,
    transcript: [],
    deletedAt: null,
    share: { mode: 'off', token: null },
  };
  ui.db.notes.unshift(note);
  ui.selected.clear();
  ui.noteCollection = collectionForView();
  ui.query = '';
  ui.view = { name: 'note', noteId: note.id };
  ui.noteTab = 'raw';
  ui.focusTitle = true;
  persist();
  renderAll();
}

async function enhanceNote(
  noteId: ID,
  templateId?: string | null,
): Promise<void> {
  if (ui.generatingNoteId) {
    toast('A summary is already being created.');
    return;
  }
  const note = noteById(noteId);
  if (!note) return;
  if (!note.rawNotes.trim() && note.transcript.length === 0) {
    toast('Add a few raw notes or record the meeting first.');
    return;
  }
  const template =
    templateId === undefined
      ? templateById(note.templateId)
      : templateById(templateId || null);
  ui.generatingNoteId = noteId;
  if (currentNote()?.id === noteId) {
    ui.noteTab = 'enhanced';
    renderMain();
    document.getElementById('tab-enhanced')?.focus({ preventScroll: true });
  }

  let enhanced;
  let fellBack = false;
  let rawText = '';
  if (ui.ai.configured) {
    try {
      const { text } = await window.api.complete({
        messages: buildEnhanceMessages(note, template, ui.ai.chatModel),
        model: 'auto',
        json: true,
      });
      rawText = text;
      enhanced = parseEnhancedResponse(
        text,
        note,
        template?.id ?? null,
        ui.ai.chatModel,
      );
    } catch (error) {
      console.error(error);
      enhanced = localEnhance(note, template);
      fellBack = true;
    }
  } else {
    enhanced = localEnhance(note, template);
    fellBack = true;
  }

  const fresh = noteById(noteId);
  ui.generatingNoteId = null;
  if (!fresh) {
    renderMain();
    return;
  }
  const detected = rawText ? parseAttendees(rawText) : [];
  if (fresh.attendees.length === 0 && detected.length > 0) {
    fresh.attendees = detected;
    toast(
      `${detected.length} ${detected.length === 1 ? 'person' : 'people'} found in the transcript.`,
    );
  }
  fresh.enhanced = enhanced;
  fresh.templateId = template?.id ?? null;
  touch(fresh);
  persist();
  if (currentNote()?.id === noteId) {
    if (ui.noteTab === 'enhanced') {
      const focusSummary = document.activeElement?.id === 'tab-enhanced';
      renderMain();
      if (focusSummary)
        document.getElementById('tab-enhanced')?.focus({ preventScroll: true });
    } else {
      const button = document.querySelector<HTMLButtonElement>(
        '.note-toolbar [data-act="enhance"]',
      );
      if (button) {
        button.disabled = false;
        mount(button, html`${icon('pen', 13)} Regenerate summary`);
      }
    }
  }
  if (fellBack) {
    toast(
      ui.ai.configured
        ? 'The model did not answer; enhanced notes were built offline.'
        : 'Summary created on this device.',
    );
  }
}

function shareNote(note: Note): void {
  ui.modal = { type: 'share', noteId: note.id };
  renderModal();
}

async function saveShareForm(form: HTMLFormElement): Promise<void> {
  if (ui.modal?.type !== 'share') return;
  const note = noteById(ui.modal.noteId);
  if (!note) return;
  const data = new FormData(form);
  const mode = String(data.get('mode') ?? 'off') as 'off' | 'anyone';
  note.share.mode = mode === 'anyone' ? 'anyone' : 'off';
  note.share.token =
    note.share.mode === 'off' ? null : (note.share.token ?? uid());
  touch(note);
  persist();
  let url: string | undefined;
  if (note.share.token) {
    url = await window.api.shareUrl(note.share.token).catch(() => undefined);
  }
  ui.modal = { type: 'share', noteId: note.id, url };
  renderModal();
  toast(
    note.share.mode === 'off'
      ? 'Preview turned off. The old link is revoked.'
      : 'Local preview link is ready.',
  );
}

function copyText(text: string, message = 'Copied'): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast(message))
    .catch(() => toast('Could not copy to the clipboard.'));
}

function exportNotes(notes: Note[]): void {
  if (notes.length === 0) {
    toast('There are no notes to export.');
    return;
  }
  const blob = new Blob([toCsv(notes)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `lilt-notes-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast(
    `Exported ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} as CSV.`,
  );
}

function deleteNote(note: Note): void {
  note.deletedAt = nowIso();
  note.share = { mode: 'off', token: null };
  touch(note);
  ui.selected.delete(note.id);
  persist();
  if (ui.view.name === 'note' && ui.view.noteId === note.id) {
    ui.view = ui.noteCollection;
  }
  renderAll();
  toast('Note moved to trash.');
}

function restoreNote(note: Note): void {
  note.deletedAt = null;
  touch(note);
  persist();
  renderAll();
  toast('Note restored.');
}

function removeForever(notes: Note[]): void {
  const ids = new Set(notes.map((note) => note.id));
  ui.db.notes = ui.db.notes.filter((note) => !ids.has(note.id));
  ui.selected.clear();
  persist();
  renderAll();
  toast(
    `Deleted ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} permanently.`,
  );
}

function moveSelected(): void {
  if (ui.selected.size === 0) return;
  ui.modal = { type: 'move' };
  renderModal();
}

function applyMove(folderIds: string[]): void {
  for (const note of ui.db.notes) {
    if (!ui.selected.has(note.id)) continue;
    for (const folderId of folderIds) {
      if (!note.folderIds.includes(folderId)) note.folderIds.push(folderId);
    }
    touch(note);
  }
  ui.selected.clear();
  ui.modal = null;
  persist();
  renderAll();
  toast(
    folderIds.length
      ? `Added ${folderIds.length === 1 ? 'folder' : `${folderIds.length} folders`} to selection.`
      : 'No folders selected.',
  );
}

function saveSpace(form: HTMLFormElement): void {
  if (ui.modal?.type !== 'space') return;
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  if (!name) {
    toast('Give the space a name.');
    return;
  }
  const description = String(data.get('description') ?? '').trim();
  const existing = ui.modal.spaceId ? spaceById(ui.modal.spaceId) : null;
  ui.modal = null;
  if (existing) {
    existing.name = name;
    existing.description = description;
    persist();
    renderAll();
    toast('Space updated.');
    return;
  }
  const space: Space = {
    id: uid(),
    kind: 'custom',
    name,
    description,
    icon: 'briefcase',
  };
  ui.db.spaces.push(space);
  persist();
  ui.view = { name: 'space', spaceId: space.id };
  renderAll();
  toast('Space created.');
}

function deleteFolder(id: ID): void {
  const folder = folderById(id);
  if (!folder) return;
  const ids = folderDescendants(ui.db.folders, id);
  for (const note of ui.db.notes) {
    if (!note.folderIds.some((entry) => ids.has(entry))) continue;
    note.folderIds = note.folderIds.filter((entry) => !ids.has(entry));
    touch(note);
  }
  ui.db.folders = ui.db.folders.filter((entry) => !ids.has(entry.id));
  if (ui.view.name === 'folder' && ids.has(ui.view.folderId)) {
    const parent = folder.parentId ? folderById(folder.parentId) : null;
    ui.view = parent
      ? { name: 'folder', folderId: parent.id }
      : { name: 'space', spaceId: folder.spaceId };
  }
  persist();
  renderAll();
  toast('Folder deleted.');
}

function deleteSpace(id: ID): void {
  const space = spaceById(id);
  if (!space || space.kind === 'personal') return;
  const fallback = ui.db.spaces.find((entry) => entry.kind === 'personal');
  const folders = new Set(
    ui.db.folders
      .filter((folder) => folder.spaceId === id)
      .map((folder) => folder.id),
  );
  for (const note of ui.db.notes) {
    const moved = note.spaceId === id;
    if (moved && fallback) note.spaceId = fallback.id;
    const stripped = note.folderIds.some((folderId) => folders.has(folderId));
    if (stripped)
      note.folderIds = note.folderIds.filter(
        (folderId) => !folders.has(folderId),
      );
    if (moved || stripped) touch(note);
  }
  ui.db.folders = ui.db.folders.filter((folder) => folder.spaceId !== id);
  ui.db.spaces = ui.db.spaces.filter((entry) => entry.id !== id);
  if (
    (ui.view.name === 'space' && ui.view.spaceId === id) ||
    (ui.view.name === 'folder' && folders.has(ui.view.folderId))
  ) {
    ui.view = { name: 'notes' };
  }
  persist();
  renderAll();
  toast('Space deleted.');
}

function createFolder(form: HTMLFormElement): void {
  if (ui.modal?.type !== 'folder') return;
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  if (!name) {
    toast('Give the folder a name.');
    return;
  }
  const parentField = data.get('parentId');
  const folder: Folder = {
    id: uid(),
    spaceId: ui.modal.spaceId,
    parentId:
      parentField === null
        ? ui.modal.parentId
        : String(parentField).trim() || null,
    name,
    icon: 'folder',
    description: String(data.get('description') ?? '').trim(),
  };
  ui.db.folders.push(folder);
  ui.modal = null;
  persist();
  ui.view = { name: 'folder', folderId: folder.id };
  renderAll();
  toast('Folder created.');
}

function saveTemplate(form: HTMLFormElement): void {
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  const prompt = String(data.get('prompt') ?? '').trim();
  const sections = String(data.get('sections') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!name || sections.length === 0) {
    toast('A template needs a name and at least one section.');
    return;
  }
  const template: Template = {
    id: uid(),
    name,
    prompt,
    sections,
    builtin: false,
  };
  ui.db.templates.push(template);
  ui.modal = null;
  persist();
  renderAll();
  toast('Template saved.');
}

function saveRecipe(form: HTMLFormElement): void {
  const data = new FormData(form);
  const name = String(data.get('name') ?? '').trim();
  const prompt = String(data.get('prompt') ?? '').trim();
  if (!name || !prompt) {
    toast('A recipe needs a name and a prompt.');
    return;
  }
  const recipe: Recipe = {
    id: uid(),
    name,
    prompt,
    scope:
      String(data.get('scope') ?? 'single') === 'multiple'
        ? 'multiple'
        : 'single',
    model: String(data.get('model') ?? 'auto') as Recipe['model'],
  };
  ui.db.recipes.push(recipe);
  ui.modal = null;
  persist();
  renderAll();
  toast('Recipe saved.');
}

function runRecipe(recipe: Recipe, animate: boolean): void {
  const scope = ui.chatScope ?? scopeForView();
  if (recipe.scope === 'single' && scope.type !== 'note') {
    toast('Open a note to run this recipe.');
    return;
  }
  ui.chatScope = scope;
  ui.chatDraft = recipe.prompt;
  ui.chatMenu = false;
  setChatOpen(true, animate);
  focusChatInput();
}

async function saveSettings(
  form: HTMLFormElement,
  quiet = false,
): Promise<void> {
  const data = new FormData(form);
  ui.db.settings.includeSystemAudio = data.get('includeSystemAudio') === 'on';
  ui.db.settings.autoEnhance = data.get('autoEnhance') === 'on';
  ui.db.settings.notifications = data.get('notifications') === 'on';
  ui.db.settings.meetingDetectionEnabled =
    data.get('meetingDetectionEnabled') === 'on';
  ui.db.settings.autoStartMeetingRecording =
    data.get('autoStartMeetingRecording') === 'on';
  ui.db.settings.diarizationEnabled = data.get('diarizationEnabled') === 'on';
  ui.db.settings.vadSensitivity = Number(data.get('vadSensitivity') ?? 0.5);
  if (capture) capture.setSensitivity(ui.db.settings.vadSensitivity);
  ui.db.settings.sttLanguage = String(data.get('sttLanguage') ?? 'en');
  ui.db.user.name =
    String(data.get('userName') ?? ui.db.user.name).trim() || ui.db.user.name;
  persist();
  window.api
    .setMeetingDetectionEnabled(ui.db.settings.meetingDetectionEnabled)
    .catch(() => {});
  try {
    const apiKey = String(data.get('apiKey') ?? '').trim();
    ui.ai = await window.api.setAiConfig({
      baseUrl: String(data.get('baseUrl') ?? ''),
      sttServerUrl: String(data.get('sttServerUrl') ?? ''),
      chatModel: String(data.get('chatModel') ?? ''),
      thinkingModel: String(data.get('thinkingModel') ?? ''),
      sttModel: String(data.get('sttModel') ?? ''),
      sttLanguage: ui.db.settings.sttLanguage,
      sttSource: String(data.get('sttSource') ?? ui.ai.sttSource) as SttSource,
      ...(apiKey ? { apiKey } : {}),
    });
    if (!quiet) toast('Settings saved.');
  } catch (error) {
    console.error(error);
    toast('Settings saved locally, but the AI configuration failed.');
  }
  renderAll();
}

// ---------------------------------------------------------------------------
// Note view
// ---------------------------------------------------------------------------

function noteView(note: Note): Html {
  const live = note.status === 'recording' || note.status === 'paused';
  const space = spaceById(note.spaceId);
  const folder = note.folderIds[0] ? folderById(note.folderIds[0]) : null;
  const collection = ui.noteCollection;
  const showSpace =
    space && !(collection.name === 'space' && collection.spaceId === space.id);
  const showFolder =
    folder &&
    !(collection.name === 'folder' && collection.folderId === folder.id);
  return html`<div class="note-page">
    <header class="note-top">
      <nav class="crumbs" aria-label="Note location">
        <button class="list-back" data-act="back-to-notes">
          ${icon('arrowLeft', 15)} <span>${collectionMeta().title}</span>
        </button>
        ${showSpace || showFolder ? html`<span class="crumb-divider" aria-hidden="true"></span>` : ''}
        ${
          showSpace
            ? html`<button
                data-act="nav"
                data-view="space"
                data-id="${space.id}"
              >
                ${space.name}
              </button>`
            : ''
        }
        ${
          showFolder
            ? html`${showSpace ? html`<span aria-hidden="true">/</span>` : ''}<button
                  data-act="nav"
                  data-view="folder"
                  data-id="${folder.id}"
                >
                  ${folderPath(ui.db.folders, folder.id)}
                </button>`
            : ''
        }
      </nav>
      <div class="note-actions">
        <button
          class="ghost-btn small"
          data-act="share-open-modal"
          data-id="${note.id}"
        >
          ${icon('share', 13)} Share
        </button>
        <button
          class="tiny-btn danger"
          data-act="delete-note"
          data-id="${note.id}"
          title="Move to trash"
        >
          ${icon('trash', 14)}
        </button>
      </div>
    </header>
    <div class="note-scroll">
      <div class="note-heading">
        <input
          class="note-title"
          value="${note.title}"
          dir="auto"
          data-input="title"
          data-id="${note.id}"
          aria-label="Note title"
          title="${note.title}"
          spellcheck="false"
        />
        <div class="note-meta">
          <span
            >${new Date(note.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</span
          >
          ${note.durationMs > 0 ? html`<span class="dot-sep">·</span><span>${formatDuration(note.durationMs)}</span>` : ''}
          ${note.share.mode !== 'off' ? html`<span class="shared-chip">${icon('globe', 11)} Local preview</span>` : ''}
        </div>
        <label class="note-people">
          ${icon('people', 15)}
          <input
            class="attendees-input"
            value="${note.attendees.join(', ')}"
            data-change="attendees"
            data-id="${note.id}"
            dir="auto"
            placeholder="Add attendees"
            aria-label="Attendees"
          />
        </label>
      </div>
      ${live ? recorderBar(note) : startCard(note)}
      ${live ? liveBody(note) : noteTabs(note)}
    </div>
  </div>`;
}

function recorderBar(note: Note): Html {
  const paused = note.status === 'paused';
  const starting = !capture.isRunning;
  return html`<div class="recorder-bar">
    <span class="rec-dot ${paused ? 'paused' : ''}"></span>
    <span class="rec-timer" id="rec-timer"
      >${formatClock(recordingBaseMs + capture.elapsedMs)}</span
    >
    <span class="rec-state"
      >${starting ? 'Starting…' : paused ? 'Paused' : 'Recording'}</span
    >
    ${
      starting
        ? ''
        : html`<div class="levels">
            <span class="level-label">Mic</span>
            <span class="level-track"><i id="meter-me"></i></span>
            ${
              capture.sources.includes('system')
                ? html`
                    <span class="level-label">System</span>
                    <span class="level-track"><i id="meter-them"></i></span>
                  `
                : ''
            }
          </div>`
    }
    <div class="spacer"></div>
    <button
      class="round-btn"
      data-act="${paused ? 'resume-recording' : 'pause-recording'}"
      title="${paused ? 'Resume' : 'Pause'}"
      ${starting ? raw('disabled') : ''}
    >
      ${icon(paused ? 'play' : 'pause', 13)}
    </button>
    <button
      class="stop-btn"
      data-act="stop-recording"
      data-id="${note.id}"
      ${starting ? raw('disabled') : ''}
    >
      ${icon('stop', 12)} Stop recording
    </button>
  </div>`;
}

function startCard(note: Note): Html {
  const fresh = note.status === 'draft';
  return html`<div class="start-card">
    <div class="start-copy">
      <h2>${fresh ? 'Recording' : 'Recording stopped'}</h2>
    </div>
    <div class="start-actions">
      <label class="switch-row">
        <input
          type="checkbox"
          data-change="include-system"
          ${ui.db.settings.includeSystemAudio ? raw('checked') : ''}
        />
        <span>System audio</span>
      </label>
      <button
        class="record-btn"
        data-act="start-recording"
        data-id="${note.id}"
      >
        ${icon('mic', 14)} ${fresh ? 'Start recording' : 'Continue recording'}
      </button>
    </div>
  </div>`;
}

function liveBody(note: Note): Html {
  return html`<div class="live-grid">
    <div class="panel live-notes">
      <div class="panel-head">
        <span>Notes</span>
      </div>
      <textarea
        class="live-raw"
        data-input="raw"
        data-id="${note.id}"
        placeholder="Write meeting notes…"
        aria-label="Meeting notes"
        spellcheck="false"
      >
${note.rawNotes}</textarea>
    </div>
    <div class="panel live-transcript">
      <div class="panel-head">
        <span
          >Transcript
          <span class="inline-count" id="transcript-count"
            >${note.transcript.length}</span
          ></span
        >
        <div class="panel-actions">
          <button
            class="tiny-btn"
            data-act="copy-transcript"
            title="Copy transcript"
          >
            ${icon('copy', 12)}
          </button>
          <button
            class="tiny-btn"
            data-act="toggle-transcript"
            title="${ui.transcriptHidden ? 'Show' : 'Hide'} transcript"
          >
            ${icon('eye', 12)}
          </button>
        </div>
      </div>
      ${
        ui.transcriptHidden
          ? html`<div class="transcript-hidden">
              ${icon('eye', 18)}
              <p>Transcript hidden. Audio is still being processed.</p>
            </div>`
          : html`${ui.sttError ? html`<div class="inline-warning">${icon('zap', 13)}<span>${ui.sttError}</span></div>` : ''}
              <div class="transcript-scroll" id="transcript-scroll">
                ${
                  note.transcript.length === 0
                    ? html`<div class="transcript-empty">
                        ${icon('wave', 20)}
                        <p>
                          ${ui.ai.sttReady ? (ui.ai.sttSource === 'nemotron-streaming' ? 'Listening. Words appear while you speak.' : ui.ai.sttSource === 'cloud' ? 'Listening. The first lines appear after a few seconds.' : 'Listening. Text appears a few seconds after you pause.') : 'Capturing levels. Choose a speech-to-text model in Settings to see words here.'}
                        </p>
                      </div>`
                    : transcriptList(note, true)
                }
              </div>`
      }
    </div>
  </div>`;
}

function noteTabs(note: Note): Html {
  const tab = ui.noteTab;
  return html`<div class="note-toolbar">
      <div class="tabs" role="tablist" aria-label="Note views">
        <button
          class="tab ${tab === 'enhanced' ? 'active' : ''}"
          data-act="set-tab"
          data-tab="enhanced"
          id="tab-enhanced"
          role="tab"
          aria-controls="note-panel"
          tabindex="${tab === 'enhanced' ? '0' : '-1'}"
          aria-selected="${tab === 'enhanced'}"
        >
          Summary
        </button>
        <button
          class="tab ${tab === 'raw' ? 'active' : ''}"
          data-act="set-tab"
          data-tab="raw"
          id="tab-raw"
          role="tab"
          aria-controls="note-panel"
          tabindex="${tab === 'raw' ? '0' : '-1'}"
          aria-selected="${tab === 'raw'}"
        >
          Notes
        </button>
        <button
          class="tab ${tab === 'transcript' ? 'active' : ''}"
          data-act="set-tab"
          data-tab="transcript"
          id="tab-transcript"
          role="tab"
          aria-controls="note-panel"
          tabindex="${tab === 'transcript' ? '0' : '-1'}"
          aria-selected="${tab === 'transcript'}"
        >
          Transcript
          <span class="inline-count" id="transcript-tab-count"
            >${note.transcript.length}</span
          >
        </button>
      </div>
      <div class="toolbar-actions">
        <select
          class="template-select"
          id="template-select"
          data-change="template"
          data-id="${note.id}"
          aria-label="Note template"
        >
          <option value="">Default structure</option>
          ${ui.db.templates.map(
            (template) =>
              html`<option
                value="${template.id}"
                ${note.templateId === template.id ? raw('selected') : ''}
              >
                ${template.name}
              </option>`,
          )}
        </select>
        <button
          class="enhance-btn"
          data-act="enhance"
          data-id="${note.id}"
          ${ui.generatingNoteId === note.id ? raw('disabled') : ''}
        >
          ${icon('pen', 13)}
          ${note.enhanced ? 'Regenerate summary' : 'Create summary'}
        </button>
      </div>
    </div>
    <section
      id="note-panel"
      role="tabpanel"
      tabindex="0"
      aria-labelledby="tab-${tab}"
    >
      ${
        tab === 'enhanced'
          ? enhancedPanel(note)
          : tab === 'raw'
            ? rawPanel(note)
            : transcriptPanel(note)
      }
    </section>`;
}

function enhancedPanel(note: Note): Html {
  if (ui.generatingNoteId === note.id) {
    return html`<p class="enhanced loading" role="status">
      Creating summary…
    </p>`;
  }
  if (!note.enhanced) {
    return html`<div class="empty-enhanced">
      <h2>No summary yet</h2>
      <p>Create a summary from your notes or transcript.</p>
    </div>`;
  }
  const template = templateById(note.enhanced.templateId);
  return html`<div class="enhanced">
    <div class="enhanced-meta">
      <span
        >${template ? `${template.name} · ` : ''}Generated
        ${relativeDate(note.enhanced.generatedAt)} ·
        ${note.enhanced.model}</span
      >
      <button class="text-btn" data-act="copy-summary" data-id="${note.id}">
        ${icon('copy', 12)} Copy summary
      </button>
    </div>
    ${
      note.share.mode !== 'off'
        ? html`<div class="shared-notice">
            ${icon('globe', 13)} The preview includes this summary only.
          </div>`
        : ''
    }
    ${note.enhanced.sections.map((section) => enhancedSection(note, section))}
  </div>`;
}

function enhancedSection(note: Note, section: Section): Html {
  return html`<section class="enh-section">
    <h2>
      <span
        contenteditable="plaintext-only"
        data-heading-id="${section.id}"
        data-section-id="${section.id}"
        data-note-id="${note.id}"
        spellcheck="false"
        dir="auto"
        >${section.heading}</span
      >
    </h2>
    <ul>
      ${section.bullets.map(
        (bullet) =>
          html`<li>
            <span class="bullet-dot"></span>
            <span
              class="bullet-text"
              contenteditable="plaintext-only"
              data-bullet-id="${bullet.id}"
              data-section-id="${section.id}"
              data-note-id="${note.id}"
              spellcheck="false"
              dir="auto"
              >${bullet.text}</span
            >
            ${
              bullet.source
                ? html`<details
                    class="source ${bullet.source.kind === 'unverified' ? 'unverified' : ''}"
                  >
                    <summary title="See the source">
                      ${icon('search', 11)}
                    </summary>
                    <div class="source-pop">
                      <span class="source-kind"
                        >${bullet.source.kind === 'transcript' ? 'From the transcript' : bullet.source.kind === 'raw' ? 'From your raw notes' : 'Could not verify this quote'}</span
                      >
                      <p>"${bullet.source.quote}"</p>
                    </div>
                  </details>`
                : ''
            }
          </li>`,
      )}
    </ul>
  </section>`;
}

function rawPanel(note: Note): Html {
  return html`<div class="raw-panel">
    <textarea
      class="raw-input"
      data-input="raw"
      data-id="${note.id}"
      placeholder="Write meeting notes…"
      aria-label="Meeting notes"
      spellcheck="false"
    >
${note.rawNotes}</textarea>
    <div class="raw-foot">
      <span id="raw-count"
        >${note.rawNotes.trim() ? `${note.rawNotes.trim().split(/\s+/).length} words` : ''}</span
      >
    </div>
  </div>`;
}

function transcriptPanel(note: Note): Html {
  return html`<div class="transcript-panel">
    ${
      note.transcript.length
        ? html`<div class="transcript-tools">
            <label class="mini-search">
              ${icon('search', 12)}
              <input
                type="search"
                value="${ui.transcriptQuery}"
                data-input="transcript-search"
                placeholder="Search transcript"
                aria-label="Search transcript"
              />
            </label>
            <button
              class="text-btn"
              data-act="copy-transcript"
              data-id="${note.id}"
            >
              ${icon('copy', 12)} Copy transcript
            </button>
          </div>`
        : ''
    }
    ${
      note.transcript.length === 0
        ? html`<div class="transcript-empty large">
            ${icon('wave', 24)}
            <p>Record with speech-to-text enabled to add a transcript.</p>
          </div>`
        : html`<div class="transcript-scroll static" id="transcript-scroll">
            ${transcriptList(note, false)}
          </div>`
    }
  </div>`;
}

function transcriptList(note: Note, live: boolean): Html {
  const query = live ? '' : ui.transcriptQuery.trim().toLowerCase();
  const segments = query
    ? note.transcript.filter((segment) =>
        segment.text.toLowerCase().includes(query),
      )
    : note.transcript;
  if (segments.length === 0 && query) {
    return html`<div class="transcript-empty">
      ${icon('search', 18)}
      <p>No lines match "${ui.transcriptQuery}".</p>
    </div>`;
  }
  const hues = new Map<string, number>();
  for (const { source, speaker } of note.transcript) {
    if (source === 'mic' || hues.has(speaker)) continue;
    // A golden-angle step keeps neighboring speakers' hues apart.
    hues.set(speaker, (252 + hues.size * 137.508) % 360);
  }
  return html`${segments.map(
    (segment) =>
      html`<div
        class="seg ${segment.source === 'mic' ? 'me' : 'them'}"
        style="--seg-hue: ${hues.get(segment.speaker) ?? 0}"
      >
        <div class="seg-meta">
          <span class="seg-speaker">${segment.speaker}</span>
          <span>${formatClock(segment.startMs)}</span>
          <span class="seg-actions">
            <button
              class="tiny-btn"
              data-act="copy-segment"
              data-id="${segment.id}"
              title="Copy line"
            >
              ${icon('copy', 10)}
            </button>
            <button
              class="tiny-btn danger"
              data-act="delete-segment"
              data-id="${segment.id}"
              title="Delete line"
            >
              ${icon('x', 10)}
            </button>
          </span>
        </div>
        <div class="seg-text" dir="auto">${segment.text}</div>
      </div>`,
  )}${
    live
      ? html`<div
          class="seg-listening ${note.status === 'paused' ? 'paused' : ''}"
        >
          <span class="listening-dot"></span>
          <span dir="auto"
            >${
              note.status === 'paused' ? 'Paused' : liveTail() || 'Listening…'
            }</span
          >
        </div>`
      : ''
  }`;
}

/** The still-revisable end of the live text, when the engine reports one. */
function liveTail(): string {
  if (!liveStreaming()) return '';
  return [...liveFeeds.values()]
    .map((feed) => feed.tail)
    .join(' ')
    .trim();
}

function renderTranscript(): void {
  const note = currentNote();
  const container = document.getElementById('transcript-scroll');
  if (!note || !container) return;
  const atBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  mount(
    container,
    transcriptList(
      note,
      note.status === 'recording' || note.status === 'paused',
    ),
  );
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function updateTranscriptCount(): void {
  const note = currentNote();
  if (!note) return;
  for (const id of ['transcript-count', 'transcript-tab-count']) {
    const node = document.getElementById(id);
    if (node) node.textContent = String(note.transcript.length);
  }
}

function renderAll(): void {
  document.documentElement.dataset.appearance = ui.db.settings.appearance;
  const main = document.getElementById('main');
  const keepSettingsScroll =
    ui.view.name === 'settings' && main?.dataset.view === 'settings';
  const scrollTop = keepSettingsScroll ? main.scrollTop : 0;
  mount(
    root,
    html`<div class="app ${ui.railClosed ? 'rail-closed' : ''}">
        ${topBar()}
        <div class="workspace">
          ${railView()}
          <main
            class="main"
            id="main"
            tabindex="-1"
            data-view="${ui.view.name}"
          >
            ${mainView()}
          </main>
          <div id="chat-root" ${ui.chatOpen ? '' : raw('hidden inert')}>
            ${ui.chatOpen ? chatPane() : ''}
          </div>
        </div>
      </div>
      <div id="modal-root">${modalView()}</div>
      <div id="reminder-root">${reminderView()}</div>
      <div id="meeting-banner-root">${meetingBannerView()}</div>
      <div id="toast-root">${toastView()}</div>`,
  );
  if (keepSettingsScroll)
    document.getElementById('main')?.scrollTo(0, scrollTop);
  const dialog =
    document.querySelector<HTMLDialogElement>('#modal-root dialog');
  if (dialog) {
    dialog.showModal();
    renderToast();
  }
  afterRender();
  ui.focusTitle = false;
  ui.focusChat = false;
}

function toggleRail(): void {
  ui.railClosed = !ui.railClosed;
  document
    .querySelector('.app')
    ?.classList.toggle('rail-closed', ui.railClosed);
  const button = document.querySelector('.rail-toggle');
  if (!button) return;
  button.setAttribute('aria-expanded', String(!ui.railClosed));
  button.setAttribute(
    'aria-label',
    ui.railClosed ? 'Expand sidebar' : 'Collapse sidebar',
  );
}

function renderList(): void {
  const pane = document.getElementById('list-pane');
  if (!pane) return;
  const focused = document.activeElement;
  const previous =
    focused instanceof HTMLElement && pane.contains(focused) ? focused : null;
  const scrollTop = pane.querySelector('.note-list')?.scrollTop ?? 0;
  mount(pane, listPane());
  pane.querySelector('.note-list')?.scrollTo(0, scrollTop);
  if (previous) {
    const controls = pane.querySelectorAll<HTMLElement>(
      '[data-act], [data-change]',
    );
    const next = Array.from(controls).find(
      ({ dataset }) =>
        dataset.act === previous.dataset.act &&
        dataset.change === previous.dataset.change &&
        dataset.id === previous.dataset.id,
    );
    (next ?? pane.querySelector<HTMLElement>('[data-act="select-all"]'))?.focus(
      { preventScroll: true },
    );
  }
}
function renderListSoon(): void {
  if (listRenderTimer !== null) window.clearTimeout(listRenderTimer);
  listRenderTimer = window.setTimeout(() => {
    listRenderTimer = null;
    renderList();
  }, 150);
}

function renderMain(): void {
  mount(document.getElementById('main'), mainView());
  afterRender();
}

function renderChat(): void {
  if (!ui.chatOpen) return;
  mount(document.getElementById('chat-root'), chatPane());
  scrollChat();
}

function renderModal(animateClose = false): void {
  const container = document.getElementById('modal-root');
  const closing = ui.modal ? null : container?.querySelector('dialog[open]');
  if (closing instanceof HTMLDialogElement) {
    closing.toggleAttribute('data-closing', animateClose);
    closing.close();
    if (animateClose) {
      // Keep the dialog visible during its exit after native focus restoration.
      closing.inert = true;
      closing.querySelector('.dialog-feedback')?.replaceChildren();
      renderToast();
      return;
    }
  }
  mount(container, modalView());
  container?.querySelector('dialog')?.showModal();
  renderToast();
}

function setChatOpen(open: boolean, animate: boolean): void {
  ui.chatOpen = open;
  const pane = document.getElementById('chat-root');
  if (pane) {
    pane.toggleAttribute('data-motion', animate);
    pane.inert = !open;
    pane.hidden = !open;
    if (open) renderChat();
  }
  document
    .querySelector('.ask-trigger')
    ?.setAttribute('aria-expanded', String(open));
}

function closeChat(animate = false): void {
  ui.chatMenu = false;
  setChatOpen(false, animate);
  document.querySelector<HTMLButtonElement>('.ask-trigger')?.focus();
}

function renderToast(animate = false): void {
  const dialog = document.querySelector<HTMLDialogElement>(
    '#modal-root dialog[open]',
  );
  const rootToast = document.getElementById('toast-root');
  const container = dialog
    ? dialog.querySelector('.dialog-feedback')
    : rootToast;
  if (dialog) rootToast?.replaceChildren();
  const current = container?.querySelector('.toast');
  if (current && ui.toast) current.textContent = ui.toast;
  else mount(container, toastView(animate));
}

function afterRender(): void {
  if (ui.focusTitle) {
    const field = document.querySelector<HTMLInputElement>('.note-title');
    if (field) {
      field.focus();
      field.select();
    }
  }
  if (ui.focusChat) focusChatInput();
  scrollChat();
  if (currentNote()?.status === 'recording') scrollTranscript();
}

function focusChatInput(): void {
  const field = document.querySelector<HTMLTextAreaElement>('#chat-input');
  if (field) {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
}

function scrollChat(): void {
  const log = document.getElementById('chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function scrollTranscript(): void {
  const log = document.getElementById('transcript-scroll');
  if (log) log.scrollTop = log.scrollHeight;
}

const shortcutKey = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function captureShortcut(): Html {
  const note = noteById(recordingNoteId);
  if (!note || (note.status !== 'recording' && note.status !== 'paused'))
    return html``;
  const paused = note.status === 'paused';
  return html`<button
    class="capture-shortcut ${paused ? 'paused' : ''}"
    data-act="open-note"
    data-id="${note.id}"
    title="Open recording"
  >
    <span class="rec-dot ${paused ? 'paused' : ''}"></span>
    ${!capture.isRunning ? 'Starting recording' : paused ? 'Recording paused' : 'Recording'}
  </button>`;
}

function topBar(): Html {
  return html`<header class="topbar">
    <button
      class="rail-toggle tiny-btn"
      data-act="toggle-rail"
      aria-label="${ui.railClosed ? 'Expand sidebar' : 'Collapse sidebar'}"
      aria-expanded="${String(!ui.railClosed)}"
      aria-controls="sidebar"
    >
      ${icon('panel', 18)}
    </button>
    <button
      class="brand"
      data-act="nav"
      data-view="home"
      aria-label="Lilt home"
    >
      ${brandMark(30)} <span>Lilt</span>
    </button>
    <label class="top-search">
      ${icon('search', 17)}
      <input
        type="search"
        placeholder="Search notes"
        value="${ui.query}"
        data-input="search"
        aria-label="Search notes"
      />
      <kbd aria-hidden="true">${shortcutKey}K</kbd>
    </label>
    <div class="top-actions">
      <div id="capture-shortcut" aria-live="polite">${captureShortcut()}</div>
      <button
        class="ghost-btn ask-trigger"
        data-act="open-chat"
        title="Ask Lilt"
        aria-label="Ask Lilt"
        aria-expanded="${String(ui.chatOpen)}"
        aria-controls="chat-root"
      >
        ${icon('chat', 16)} <span>Ask Lilt</span>
      </button>
      <button
        class="primary-btn"
        data-act="new-note"
        title="New note (${shortcutKey}N)"
      >
        ${icon('plus', 17)} New note
      </button>
    </div>
  </header>`;
}

function railView(): Html {
  const personal = ui.db.spaces.find((space) => space.kind === 'personal');
  const team = ui.db.spaces.find((space) => space.kind === 'team');
  const custom = ui.db.spaces.filter(
    (space) => space.kind !== 'personal' && space.kind !== 'team',
  );
  return html`<aside
    class="rail"
    id="sidebar"
    aria-label="Workspace navigation"
  >
    <nav class="rail-nav" aria-label="Main">
      ${navButton('home', 'Meeting desk', 'home')}
      ${navButton('notes', 'All notes', 'notes')}
      ${navButton('calendar', 'Calendar', 'calendar')}
      ${navButton('people', 'People', 'people')}
      ${navButton('recipes', 'Recipes', 'recipe')}
    </nav>
    <div class="rail-scroll">
      <div class="spaces-head">
        <h2>Spaces</h2>
        <button
          class="tiny-btn"
          data-act="new-space"
          title="New space"
          aria-label="New space"
        >
          ${icon('plus', 14)}
        </button>
      </div>
      ${personal ? spaceBlock(personal) : ''} ${team ? spaceBlock(team) : ''}
      ${custom.map((space) => spaceBlock(space))}
    </div>
    <div class="rail-foot">
      ${navButton('trash', 'Trash', 'trash', ui.db.notes.filter((note) => note.deletedAt).length || undefined)}
      ${navButton('settings', 'Settings', 'settings')}
      <div class="user-row">
        ${avatar(ui.db.user.name, 30)}
        <div class="user-copy">
          <strong>${ui.db.user.name}</strong>
        </div>
      </div>
    </div>
  </aside>`;
}

function navButton(
  view: string,
  label: string,
  iconName: IconName,
  count?: number,
): Html {
  const active =
    ui.view.name === view ||
    (ui.view.name === 'note' && ui.noteCollection.name === view) ||
    (view === 'people' &&
      (ui.view.name === 'person' ||
        (ui.view.name === 'note' && ui.noteCollection.name === 'person')));
  return html`<button
    class="rail-nav-item ${active ? 'active' : ''}"
    data-act="nav"
    data-view="${view}"
    title="${label}"
    aria-current="${active ? 'page' : 'false'}"
  >
    ${icon(iconName, 15)} <span>${label}</span>
    ${count ? html`<span class="nav-count">${count}</span>` : ''}
  </button>`;
}

function spaceBlock(space: Space): Html {
  const folders = ui.db.folders.filter(
    (folder) => folder.spaceId === space.id && !folder.parentId,
  );
  const view = ui.view.name === 'note' ? ui.noteCollection : ui.view;
  const activeSpace = view.name === 'space' && view.spaceId === space.id;
  return html`<div class="space-block">
    <div class="space-head">
      <button
        class="space-name ${activeSpace ? 'active' : ''}"
        data-act="nav"
        data-view="space"
        data-id="${space.id}"
      >
        ${icon(space.kind === 'personal' ? 'lock' : space.kind === 'team' ? 'people' : 'briefcase', 13)}
        <span>${space.name}</span>
      </button>
      <button
        class="tiny-btn"
        data-act="edit-space"
        data-id="${space.id}"
        title="Edit ${space.name}"
        aria-label="Edit ${space.name}"
      >
        ${icon('pen', 12)}
      </button>
      <button
        class="tiny-btn"
        data-act="new-folder"
        data-space="${space.id}"
        title="New folder in ${space.name}"
        aria-label="New folder in ${space.name}"
      >
        ${icon('plus', 12)}
      </button>
    </div>
    <div class="folder-tree">
      ${folders.map((folder) => folderBranch(folder))}
    </div>
  </div>`;
}

function folderBranch(
  folder: Folder,
  depth = 0,
  seen = new Set<string>(),
): Html {
  if (seen.has(folder.id)) return html``;
  seen.add(folder.id);
  const children = ui.db.folders.filter(
    (child) => child.parentId === folder.id,
  );
  const view = ui.view.name === 'note' ? ui.noteCollection : ui.view;
  const active = view.name === 'folder' && view.folderId === folder.id;
  const nested = folderDescendants(ui.db.folders, folder.id);
  const noteCount = visibleNotes(ui.db).filter((note) =>
    note.folderIds.some((id) => nested.has(id)),
  ).length;
  return html`<div class="folder-branch">
    <div class="folder-line">
      <button
        class="folder-row ${depth ? 'sub' : ''} ${active ? 'active' : ''}"
        style="padding-left:${15 + depth * 13}px"
        data-act="nav"
        data-view="folder"
        data-id="${folder.id}"
        title="${folder.description || folderPath(ui.db.folders, folder.id)}"
      >
        ${icon(folderIcon(folder.icon), 13)}
        <span>${folder.name}</span>
        ${noteCount ? html`<span class="folder-count">${noteCount}</span>` : ''}
      </button>
      <button
        class="tiny-btn folder-delete"
        data-act="delete-folder"
        data-id="${folder.id}"
        title="Delete ${folder.name}"
        aria-label="Delete ${folder.name}"
      >
        ${icon('trash', 12)}
      </button>
    </div>
    ${children.map((child) => folderBranch(child, depth + 1, seen))}
  </div>`;
}

function folderIcon(value: string): IconName {
  const allowed: IconName[] = [
    'briefcase',
    'pen',
    'circle',
    'people',
    'folder',
  ];
  return allowed.includes(value as IconName) ? (value as IconName) : 'folder';
}

function avatar(name: string, size = 32): Html {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  const hue =
    [...name].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return html`<span
    class="avatar"
    style="--avatar-hue:${hue};width:${size}px;height:${size}px;font-size:${Math.max(10, Math.round(size * 0.34))}px"
    aria-hidden="true"
    >${initials || '?'}</span
  >`;
}

// ---------------------------------------------------------------------------
// List pane
// ---------------------------------------------------------------------------

function collectionForView(): CollectionView {
  const view = ui.view;
  if (view.name === 'note') return ui.noteCollection;
  if (
    view.name === 'home' ||
    view.name === 'calendar' ||
    view.name === 'space' ||
    view.name === 'folder' ||
    view.name === 'person'
  )
    return view;
  return { name: 'notes' };
}

function listNotes(): Note[] {
  const view = ui.view.name === 'trash' ? ui.view : collectionForView();
  let notes =
    view.name === 'trash'
      ? ui.db.notes.filter((note) => note.deletedAt)
      : visibleNotes(ui.db);
  if (view.name === 'space') {
    notes = notes.filter((note) => note.spaceId === view.spaceId);
  } else if (view.name === 'folder') {
    const nested = folderDescendants(ui.db.folders, view.folderId);
    notes = notes.filter((note) => note.folderIds.some((id) => nested.has(id)));
  } else if (view.name === 'person') {
    notes = notes.filter((note) =>
      note.attendees.some(
        (attendee) => attendee.toLowerCase() === view.person.toLowerCase(),
      ),
    );
  }
  if (ui.query.trim()) return searchNotes(notes, ui.query);
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function listPane(): Html {
  const notes = listNotes();
  const canSelect = ui.view.name !== 'trash' && notes.length > 0;
  const allSelected =
    notes.length > 0 && notes.every((note) => ui.selected.has(note.id));
  return html`<header class="list-head">
      <div class="list-title" role="status">
        ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}
      </div>
      ${
        canSelect
          ? html`<button
              class="ghost-btn small ${allSelected ? 'on' : ''}"
              data-act="select-all"
              aria-pressed="${allSelected}"
              title="${allSelected ? 'Clear selection' : 'Select all'}"
              aria-label="${allSelected ? 'Clear selection' : 'Select all'}"
            >
              ${icon('check', 14)}
              ${allSelected ? 'Clear selection' : 'Select all'}
            </button>`
          : ''
      }
    </header>
    ${ui.selected.size > 0 ? bulkBar() : ''}
    ${
      ui.query.trim()
        ? html`<div class="list-filter">
            ${icon('search', 12)} <span>Results for "${ui.query}"</span>
            <button class="link-btn" data-act="clear-search">Clear</button>
          </div>`
        : ''
    }
    <div class="note-list">
      ${
        notes.length === 0
          ? html`<div class="list-empty">
              <p>
                ${ui.query.trim() ? 'No notes match that search.' : ui.view.name === 'trash' ? 'Trash is empty.' : 'No notes here.'}
              </p>
              ${
                !ui.query.trim() && ui.view.name !== 'trash'
                  ? html`<button class="text-btn" data-act="new-note">
                      New note ${icon('arrowRight', 12)}
                    </button>`
                  : ''
              }
            </div>`
          : notes.map((note) => noteRow(note))
      }
    </div>`;
}

function noteRow(note: Note): Html {
  const active = ui.view.name === 'note' && ui.view.noteId === note.id;
  const checked = ui.selected.has(note.id);
  const folder = note.folderIds[0] ? folderById(note.folderIds[0]) : null;
  if (ui.view.name === 'trash') {
    return html`<article class="note-row trash-row">
      <div class="row-main">
        <div class="row-title">${note.title}</div>
        <div class="row-snippet">${noteSummary(note)}</div>
        <div class="row-meta">
          <span>Deleted ${relativeDate(note.deletedAt ?? note.updatedAt)}</span>
        </div>
      </div>
      <div class="trash-actions">
        <button
          class="tiny-btn"
          data-act="restore-note"
          data-id="${note.id}"
          title="Restore"
        >
          ${icon('refresh', 13)}
        </button>
        <button
          class="tiny-btn danger"
          data-act="delete-forever"
          data-id="${note.id}"
          title="Delete forever"
        >
          ${icon('trash', 14)}
        </button>
      </div>
    </article>`;
  }
  return html`<article
    class="note-row ${active ? 'active' : ''} ${checked ? 'checked' : ''}"
  >
    <label class="row-check" title="Select note">
      <input
        type="checkbox"
        data-change="check"
        data-id="${note.id}"
        aria-label="Select ${note.title}"
        ${checked ? raw('checked') : ''}
      />
    </label>
    <button
      class="row-main row-open"
      data-act="open-note"
      data-id="${note.id}"
      aria-current="${active ? 'page' : 'false'}"
    >
      <span class="row-copy">
        <span class="row-top">
          <span class="row-title">${note.title}</span>
          ${
            note.status === 'recording'
              ? html` <span class="rec-mini">Recording</span> `
              : ''
          }
        </span>
        <span class="row-snippet">${noteSummary(note)}</span>
      </span>
      <span class="row-meta">
        <span>${relativeDate(note.createdAt)}</span>
        ${
          note.durationMs > 0
            ? html`<span class="dot-sep">·</span
                ><span>${formatDuration(note.durationMs)}</span>`
            : ''
        }
        ${
          folder
            ? html`<span class="folder-tag" title="${folder.name}"
                >${icon('folder', 12)}<span>${folder.name}</span></span
              >`
            : ''
        }
      </span>
    </button>
  </article>`;
}

function bulkBar(): Html {
  return html`<div class="bulk-bar">
    <strong>${ui.selected.size}</strong> selected
    <div class="bulk-actions">
      <button class="tiny-btn" data-act="bulk-move" title="Add to folder">
        ${icon('folder', 14)}
      </button>
      <button class="tiny-btn" data-act="bulk-export" title="Export CSV">
        ${icon('download', 14)}
      </button>
      <button class="tiny-btn danger" data-act="bulk-delete" title="Delete">
        ${icon('trash', 14)}
      </button>
      <button
        class="tiny-btn"
        data-act="clear-selection"
        title="Clear selection"
      >
        ${icon('x', 14)}
      </button>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Main dispatcher and overview pages
// ---------------------------------------------------------------------------

function mainView(): Html {
  if (ui.view.name === 'home') return homeView();
  if (ui.view.name === 'settings') return settingsView();
  if (ui.view.name === 'calendar') return calendarView();
  if (ui.view.name === 'people') return peopleView();
  if (ui.view.name === 'person') return personView(ui.view.person);
  if (ui.view.name === 'recipes') return recipesView();
  if (ui.view.name === 'trash') return trashView();
  if (ui.view.name === 'note') {
    const note = noteById(ui.view.noteId);
    if (note) return noteView(note);
    return collectionOverview();
  }
  return collectionOverview();
}

interface CollectionMeta {
  title: string;
  description: string;
  spaceId: ID | null;
  folderId: ID | null;
}

function collectionMeta(): CollectionMeta {
  const view = collectionForView();
  if (view.name === 'space') {
    const space = spaceById(view.spaceId);
    return {
      title: space?.name ?? 'Space',
      description: space?.description ?? '',
      spaceId: space?.id ?? null,
      folderId: null,
    };
  }
  if (view.name === 'folder') {
    const folder = folderById(view.folderId);
    return {
      title: folder?.name ?? 'Folder',
      description: folder?.description ?? '',
      spaceId: folder?.spaceId ?? null,
      folderId: folder?.id ?? null,
    };
  }
  if (view.name === 'person') {
    return {
      title: view.person,
      description: '',
      spaceId: null,
      folderId: null,
    };
  }
  return {
    title:
      view.name === 'home'
        ? 'Meeting desk'
        : view.name === 'calendar'
          ? 'Calendar'
          : 'All notes',
    description: '',
    spaceId: null,
    folderId: null,
  };
}

function collectionOverview(): Html {
  const meta = collectionMeta();
  return html`<div class="page collection-page">
    <header class="page-head page-head-actions">
      <div>
        <h1>${meta.title}</h1>
        ${meta.description ? html`<p class="lede">${meta.description}</p>` : ''}
      </div>
      <div class="page-actions">
        ${
          meta.folderId
            ? html`<button
                class="ghost-btn"
                data-act="new-folder"
                data-space="${meta.spaceId}"
                data-parent="${meta.folderId}"
              >
                ${icon('folder', 15)} New subfolder
              </button>`
            : ''
        }
        ${
          ui.view.name !== 'notes'
            ? html`<button class="ghost-btn" data-act="open-chat">
                ${icon('chat', 15)} Ask
                ${ui.view.name === 'folder' ? 'about this folder' : 'about this space'}
              </button>`
            : ''
        }
      </div>
    </header>
    <section class="collection-list" id="list-pane" aria-label="Notes">
      ${listPane()}
    </section>
  </div>`;
}

function homeView(): Html {
  const notes = visibleNotes(ui.db).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const upcoming = upcomingEvents(ui.calendar.events);
  const next = ui.calendar.status.connected ? (upcoming[0] ?? null) : null;
  const recent = notes.slice(0, 5);
  return html`<div class="page home">
    <header class="page-head home-head">
      <h1>Meeting desk</h1>
      <div class="home-date">
        ${new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </header>

    <div class="home-grid">
      <div class="home-primary">
        <section class="home-section">
          <div class="section-head">
            <h2>Recent notes</h2>
            <button class="text-btn" data-act="nav" data-view="notes">
              All notes ${icon('arrowRight', 14)}
            </button>
          </div>
          ${
            recent.length
              ? html`<div class="latest-list">
                  ${recent.map(
                    (note) =>
                      html`<button
                        class="latest-row"
                        data-act="open-note"
                        data-id="${note.id}"
                      >
                        <span class="latest-icon">${icon('notes', 17)}</span>
                        <span class="latest-copy">
                          <span class="latest-title">${note.title}</span>
                          <span class="latest-snippet"
                            >${noteSummary(note)}</span
                          >
                        </span>
                        <span class="latest-date"
                          >${relativeDate(note.createdAt)}</span
                        >
                        ${icon('arrowRight', 15)}
                      </button>`,
                  )}
                </div>`
              : html`<div class="blank-state home-blank">
                  ${icon('notes', 24)}
                  <h2>No notes yet</h2>
                  <p>Create a note to write or record a meeting.</p>
                  <button class="primary-btn" data-act="new-note">
                    ${icon('plus', 15)} New note
                  </button>
                </div>`
          }
        </section>
      </div>

      <div class="home-secondary">
        <section class="home-box">
          <div class="section-head">
            <h2>Up next</h2>
          </div>
          ${
            next
              ? html`<div class="coming-copy">
                    <span class="coming-when"
                      >${startsInLabel(next)} · ${eventTime(next)}</span
                    >
                    <strong>${next.title}</strong>
                    <span
                      >${next.attendees.length ? next.attendees.slice(0, 3).join(', ') : 'No attendees'}${next.attendees.length > 3 ? ` +${next.attendees.length - 3}` : ''}</span
                    >
                  </div>
                  <div class="coming-actions">
                    <button
                      class="primary-btn small"
                      data-act="start-event"
                      data-key="${calendarEventKey(next)}"
                    >
                      ${icon('mic', 13)}
                      ${next.meetingUrl ? 'Record and join' : 'Record'}
                    </button>
                    ${next.meetingUrl ? html`<button class="ghost-btn small" data-act="join-link" data-key="${calendarEventKey(next)}">${icon('external', 13)} Join</button>` : ''}
                  </div>`
              : ui.calendar.status.connected
                ? html`<p>No upcoming meetings.</p>
                    <button
                      class="text-btn"
                      data-act="nav"
                      data-view="calendar"
                    >
                      Open calendar ${icon('arrowRight', 14)}
                    </button>`
                : html`<p>
                      Connect Google Calendar or Outlook to see upcoming
                      meetings.
                    </p>
                    <button
                      class="text-btn"
                      data-act="nav"
                      data-view="settings"
                      data-section="calendar"
                    >
                      Connect calendar ${icon('arrowRight', 14)}
                    </button>`
          }
        </section>
      </div>
    </div>
  </div>`;
}

function peopleList(): { name: string; count: number; last: string }[] {
  const map = new Map<string, { name: string; count: number; last: string }>();
  const self = ui.db.user.name.toLowerCase();
  for (const note of visibleNotes(ui.db)) {
    for (const attendee of note.attendees) {
      if (attendee.toLowerCase() === self) continue;
      const existing = map.get(attendee.toLowerCase());
      if (existing) {
        existing.count += 1;
        if (note.createdAt > existing.last) existing.last = note.createdAt;
      } else {
        map.set(attendee.toLowerCase(), {
          name: attendee,
          count: 1,
          last: note.createdAt,
        });
      }
    }
  }
  return [...map.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

function peopleView(): Html {
  const people = peopleList();
  return html`<div class="page">
    <header class="page-head">
      <h1>People</h1>
    </header>
    ${
      people.length === 0
        ? html`<div class="blank-state">
            ${icon('people', 26)}
            <h2>No attendees yet</h2>
            <p>Add attendees to a note to find it here by name.</p>
          </div>`
        : html`<div class="people-grid">
            ${people.map(
              (person) =>
                html`<button
                  class="person-card"
                  data-act="open-person"
                  data-person="${person.name}"
                >
                  ${avatar(person.name, 42)}
                  <span class="person-copy">
                    <strong>${person.name}</strong>
                    <span
                      >${person.count} ${person.count === 1 ? 'note' : 'notes'}
                      · last ${relativeDate(person.last)}</span
                    >
                  </span>
                  ${icon('arrowRight', 14)}
                </button>`,
            )}
          </div>`
    }
  </div>`;
}

function personView(person: string): Html {
  return html`<div class="page collection-page">
    <header class="page-head page-head-actions">
      <div class="person-heading">
        ${avatar(person, 54)}
        <div>
          <button class="text-btn" data-act="nav" data-view="people">
            ${icon('arrowLeft', 14)} All people
          </button>
          <h1>${person}</h1>
        </div>
      </div>
      <div class="page-actions">
        <button class="ghost-btn" data-act="open-chat">
          ${icon('chat', 15)} Ask about this person
        </button>
      </div>
    </header>
    <section
      class="collection-list"
      id="list-pane"
      aria-label="Notes with ${person}"
    >
      ${listPane()}
    </section>
  </div>`;
}

function recipesView(): Html {
  return html`<div class="page">
    <header class="page-head page-head-actions">
      <div>
        <h1>Recipes</h1>
        <p class="lede">Type <kbd>/</kbd> in chat to reuse a prompt.</p>
      </div>
      <button class="primary-btn" data-act="new-recipe">
        ${icon('plus', 14)} New recipe
      </button>
    </header>
    <div class="recipe-grid">
      ${ui.db.recipes.map(
        (recipe) =>
          html`<article class="recipe-card">
            <div class="card-top">
              <span class="scope-badge"
                >${recipe.scope === 'single' ? 'Single meeting' : 'Multiple meetings'}</span
              >
              <span class="recipe-model">${modelLabel(recipe.model)}</span>
            </div>
            <h3>${recipe.name}</h3>
            <p>${recipe.prompt}</p>
            <div class="card-foot">
              ${
                recipe.scope === 'single'
                  ? html`<button
                      class="text-btn"
                      data-act="nav"
                      data-view="notes"
                    >
                      Choose a note ${icon('arrowRight', 13)}
                    </button>`
                  : html`<button
                      class="text-btn"
                      data-act="run-recipe"
                      data-id="${recipe.id}"
                    >
                      ${icon('play', 13)} Run recipe
                    </button>`
              }
              <div class="recipe-actions">
                <button
                  class="tiny-btn danger"
                  data-act="delete-recipe"
                  data-id="${recipe.id}"
                  title="Delete recipe"
                  aria-label="Delete ${recipe.name}"
                >
                  ${icon('trash', 12)}
                </button>
              </div>
            </div>
          </article>`,
      )}
    </div>
    ${
      ui.db.recipes.length === 0
        ? html`<div class="blank-state">
            ${icon('recipe', 24)}
            <h2>No recipes yet</h2>
            <p>Save a prompt you want to use again.</p>
          </div>`
        : ''
    }
  </div>`;
}

function trashView(): Html {
  const notes = ui.db.notes.filter((note) => note.deletedAt);
  return html`<div class="page collection-page">
    <header class="page-head page-head-actions">
      <div>
        <h1>Trash</h1>
      </div>
      ${
        notes.length > 0
          ? html`<button
              class="ghost-btn danger-outline"
              data-act="empty-trash"
            >
              ${icon('trash', 15)} Empty trash
            </button>`
          : ''
      }
    </header>
    <section class="collection-list" id="list-pane" aria-label="Deleted notes">
      ${listPane()}
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function removeAiKey(): Promise<void> {
  try {
    ui.ai = await window.api.setAiConfig({
      baseUrl: ui.ai.baseUrl,
      sttServerUrl: ui.ai.sttServerUrl,
      chatModel: ui.ai.chatModel,
      thinkingModel: ui.ai.thinkingModel,
      sttModel: ui.ai.sttModel,
      sttLanguage: ui.db.settings.sttLanguage,
      sttSource: ui.ai.sttSource,
      apiKey: '',
    });
    toast('API key removed.');
    renderAll();
  } catch {
    toast('Could not remove the key.');
  }
}

function localModelReady(source: SttSource): boolean {
  return ui.ai.localModels.some((entry) => entry.id === source && entry.ready);
}

function currentSttSource(): SttSource {
  const select =
    document.querySelector<HTMLSelectElement>('[name="sttSource"]');
  return (select?.value as SttSource) ?? ui.ai.sttSource;
}

function sttLocalStatus(): string {
  if (ui.sttDownload)
    return `Downloading ${ui.sttDownload.file} — ${ui.sttDownload.percent}%`;
  const source = currentSttSource();
  if (source === 'cloud' || source === 'local-server') return '';
  if (source === 'nemotron-streaming') {
    return localModelReady(source)
      ? `${STREAM_STT_MODEL.label} is on this computer. Words appear while you speak, in 28 languages including Arabic.`
      : `${STREAM_STT_MODEL.label} · about ${(STREAM_STT_MODEL.sizeMb / 1000).toFixed(1)} GB. Writes text while you speak instead of waiting for a pause. Download once; it stays on this device.`;
  }
  const model = LOCAL_STT_MODELS[source];
  const large = source !== 'whisper-small';
  if (localModelReady(source)) {
    return large
      ? `${model.label} is on this computer. Most accurate, but much slower than small; use a GPU server if live notes lag.`
      : `${model.label} is on this computer. Audio never leaves it.`;
  }
  return large
    ? `${model.label} · about ${(model.sizeMb / 1000).toFixed(1)} GB. Most accurate, but much slower than small on a CPU. Download once; it stays on this device.`
    : `${model.label} · about ${(model.sizeMb / 1000).toFixed(1)} GB. Fast enough for live notes on a CPU. Download once; it stays on this device.`;
}

function updateSttSettings(): void {
  const source = currentSttSource();
  const local = source !== 'cloud' && source !== 'local-server';
  const server = source === 'local-server';
  const cloud = document.getElementById('stt-cloud');
  const localBlock = document.getElementById('stt-local');
  const serverBlock = document.getElementById('stt-server');
  const serverUrl = document.getElementById('stt-server-url');
  if (cloud) cloud.style.display = source === 'cloud' ? '' : 'none';
  if (localBlock) localBlock.style.display = local ? '' : 'none';
  if (serverBlock) serverBlock.style.display = server ? '' : 'none';
  if (serverUrl) serverUrl.style.display = server ? '' : 'none';
  const status = document.getElementById('stt-local-status');
  if (status) status.textContent = sttLocalStatus();
  const button = document.querySelector<HTMLButtonElement>('#stt-download');
  const ready = localModelReady(currentSttSource());
  if (button) {
    button.disabled = ui.sttDownload !== null || ready;
    button.textContent = ui.sttDownload
      ? 'Downloading…'
      : ready
        ? 'Downloaded'
        : 'Download model';
  }
}

async function downloadSttModel(): Promise<void> {
  if (ui.sttDownload) return;
  const source = currentSttSource();
  if (source === 'cloud' || source === 'local-server') return;
  const model =
    source === 'nemotron-streaming'
      ? STREAM_STT_MODEL
      : LOCAL_STT_MODELS[source];
  ui.sttDownload = { file: model.label, percent: 0 };
  updateSttSettings();
  try {
    ui.ai = await window.api.sttDownload(source);
    toast(`${model.label} is ready.`);
  } catch (error) {
    console.error(error);
    toast(
      error instanceof Error
        ? error.message
        : 'The model could not be downloaded.',
    );
  } finally {
    ui.sttDownload = null;
    updateSttSettings();
  }
}

function diarizationStatus(): string {
  if (ui.sttDownload?.file === DIARIZATION_MODEL.label)
    return `Downloading — ${ui.sttDownload.percent}%`;
  return ui.ai.diarizationReady
    ? `${DIARIZATION_MODEL.label} model is on this computer. Audio never leaves it.`
    : `${DIARIZATION_MODEL.label} · about ${DIARIZATION_MODEL.sizeMb} MB. Download once; it stays on this device.`;
}

function updateDiarizationSettings(): void {
  const status = document.getElementById('diarize-status');
  if (status) status.textContent = diarizationStatus();
  const button = document.querySelector<HTMLButtonElement>('#diarize-download');
  if (!button) return;
  const downloading = ui.sttDownload?.file === DIARIZATION_MODEL.label;
  button.disabled = downloading || ui.ai.diarizationReady;
  button.textContent = downloading
    ? 'Downloading…'
    : ui.ai.diarizationReady
      ? 'Downloaded'
      : 'Download model';
}

async function downloadDiarizationModel(): Promise<void> {
  if (ui.sttDownload) return;
  ui.sttDownload = { file: DIARIZATION_MODEL.label, percent: 0 };
  updateDiarizationSettings();
  try {
    ui.ai = await window.api.diarizationDownload();
    toast(`${DIARIZATION_MODEL.label} model is ready.`);
  } catch (error) {
    console.error(error);
    toast(
      error instanceof Error
        ? error.message
        : 'The model could not be downloaded.',
    );
  } finally {
    ui.sttDownload = null;
    updateDiarizationSettings();
  }
}

function settingsView(): Html {
  const sections = [
    ['appearance', 'Appearance'],
    ['intelligence', 'Models'],
    ['capture', 'Capture'],
    ['calendar', 'Calendar'],
    ['templates', 'Templates'],
    ['data', 'Data'],
    ['about', 'About'],
  ];
  return html`<div class="page settings-page">
    <header class="page-head">
      <h1>Settings</h1>
    </header>

    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${sections.map(([id, label]) => html`<button data-act="settings-section" data-section="${id}">${label}${icon('arrowRight', 12)}</button>`)}
      </nav>
      <div>${settingsContent()}</div>
    </div>
  </div>`;
}

function settingsContent(): Html {
  const appearance = ui.db.settings.appearance;
  return html`<section class="settings-section">
      <div class="settings-head">
        <h2 id="settings-appearance" tabindex="-1">Appearance</h2>
      </div>
      <label class="field">
        <span>Color theme</span>
        <select data-change="appearance">
          <option
            value="system"
            ${appearance === 'system' ? raw('selected') : ''}
          >
            System
          </option>
          <option
            value="light"
            ${appearance === 'light' ? raw('selected') : ''}
          >
            Light
          </option>
          <option value="dark" ${appearance === 'dark' ? raw('selected') : ''}>
            Dark
          </option>
        </select>
      </label>
    </section>
    <form data-form="settings" class="settings-form">
      <section class="settings-section">
        <div class="settings-head">
          <h2 id="settings-intelligence" tabindex="-1">Models</h2>
          <span class="status-pill ${ui.ai.configured ? 'good' : ''}">
            <span class="status-dot"></span>
            ${ui.ai.configured ? 'Model connected' : 'Offline extract'}
          </span>
        </div>
        <p class="settings-desc">
          Chat supports OpenAI-compatible endpoints. Choose where to send audio
          for transcription, or download a model to transcribe on this computer.
        </p>
        <label class="field">
          <span>Speech-to-text</span>
          <select name="sttSource" data-change="stt-source">
            <option
              value="cloud"
              ${ui.ai.sttSource === 'cloud' ? raw('selected') : ''}
            >
              Cloud · OpenAI-compatible API
            </option>
            <option
              value="local-server"
              ${ui.ai.sttSource === 'local-server' ? raw('selected') : ''}
            >
              Local server · GPU Whisper
            </option>
            <option
              value="nemotron-streaming"
              ${ui.ai.sttSource === 'nemotron-streaming' ? raw('selected') : ''}
            >
              On this computer · ${STREAM_STT_MODEL.label} ·
              ${(STREAM_STT_MODEL.sizeMb / 1000).toFixed(1)} GB · live
            </option>
            ${Object.entries(LOCAL_STT_MODELS).map(
              ([value, model]) =>
                html`<option
                  value="${value}"
                  ${ui.ai.sttSource === value ? raw('selected') : ''}
                >
                  On this computer · ${model.label} ·
                  ${(model.sizeMb / 1000).toFixed(1)} GB
                </option>`,
            )}
          </select>
        </label>
        <div
          id="stt-local"
          class="settings-inline"
          style="${
            ui.ai.sttSource === 'cloud' || ui.ai.sttSource === 'local-server'
              ? 'display:none'
              : ''
          }"
        >
          <span class="small-note" id="stt-local-status"
            >${sttLocalStatus()}</span
          >
          <button
            type="button"
            class="ghost-btn small"
            data-act="download-stt"
            id="stt-download"
            ${localModelReady(ui.ai.sttSource) ? raw('disabled') : ''}
          >
            ${localModelReady(ui.ai.sttSource) ? 'Downloaded' : 'Download model'}
          </button>
        </div>
        <p
          class="small-note"
          id="stt-cloud"
          style="${ui.ai.sttSource === 'cloud' ? '' : 'display:none'}"
        >
          Cloud transcription posts 7-second chunks, cut down to the speech in
          each one, to the endpoint below with the speech model.
        </p>
        <p
          class="small-note"
          id="stt-server"
          style="${ui.ai.sttSource === 'local-server' ? '' : 'display:none'}"
        >
          Run a GPU build of whisper-server or an OpenAI-compatible server such
          as speaches, then point this URL at it. No key is needed.
          whisper-server loads its own model; speaches needs the speech model
          field set to its model id.
        </p>
        <label
          class="field"
          id="stt-server-url"
          style="${ui.ai.sttSource === 'local-server' ? '' : 'display:none'}"
        >
          <span>Whisper server URL</span>
          <input
            name="sttServerUrl"
            value="${ui.ai.sttServerUrl}"
            placeholder="http://127.0.0.1:8080"
            spellcheck="false"
          />
        </label>
        <div class="field-grid two">
          <label class="field">
            <span>Base URL</span>
            <input
              name="baseUrl"
              value="${ui.ai.baseUrl}"
              placeholder="https://api.openai.com/v1"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span>API key</span>
            <input
              name="apiKey"
              type="password"
              placeholder="${ui.ai.configured ? 'Saved — leave blank to keep' : 'sk-…'}"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
        </div>
        <div class="field-grid three">
          <label class="field">
            <span>Chat model</span>
            <input
              name="chatModel"
              value="${ui.ai.chatModel}"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span>Thinking model</span>
            <input
              name="thinkingModel"
              value="${ui.ai.thinkingModel}"
              spellcheck="false"
            />
          </label>
          <label class="field">
            <span>Speech model</span>
            <input
              name="sttModel"
              value="${ui.ai.sttModel}"
              spellcheck="false"
            />
          </label>
        </div>
        <div class="settings-inline">
          <span class="small-note">
            ${
              ui.ai.configured
                ? ui.ai.keyStored
                  ? 'The key is encrypted with your OS keychain and never exposed to the note UI.'
                  : 'The OS keychain is unavailable, so the key is kept only for this session.'
                : 'Without a key, enhancement and answers are built by a local extractive pass.'
            }
          </span>
          ${
            ui.ai.configured
              ? html`
                  <button
                    type="button"
                    class="text-btn danger-text"
                    data-act="remove-key"
                  >
                    Remove key
                  </button>
                `
              : ''
          }
        </div>
      </section>

      <section class="settings-section">
        <div class="settings-head">
          <h2 id="settings-capture" tabindex="-1">Capture</h2>
        </div>
        <div class="field-grid two">
          <label class="field">
            <span>Default transcript language</span>
            <select name="sttLanguage">
              ${[
                ['en', 'English'],
                ['auto', 'Detect automatically (each chunk)'],
                ['ar', 'Arabic'],
                ['es', 'Spanish'],
                ['fr', 'French'],
                ['de', 'German'],
                ['pt', 'Portuguese'],
              ].map(
                ([value, label]) =>
                  html`<option
                    value="${value}"
                    ${ui.db.settings.sttLanguage === value ? raw('selected') : ''}
                  >
                    ${label}
                  </option>`,
              )}
            </select>
          </label>
          <label class="field">
            <span>Your name</span>
            <input name="userName" value="${ui.db.user.name}" />
          </label>
        </div>
        <div class="toggle-list">
          <label class="toggle">
            <input
              type="checkbox"
              name="includeSystemAudio"
              ${ui.db.settings.includeSystemAudio ? raw('checked') : ''}
            />
            <span
              ><strong>Capture system audio by default</strong
              ><small
                >Shared system audio is transcribed as "Them". You can change
                this on every start.</small
              ></span
            >
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              name="diarizationEnabled"
              ${ui.db.settings.diarizationEnabled ? raw('checked') : ''}
            />
            <span
              ><strong>Label other speakers</strong
              ><small
                >Groups system audio into Speaker A, B, … with a local voice
                model. One label per chunk, so fast turn-taking can share
                one.</small
              ></span
            >
          </label>
          <div class="settings-inline">
            <span class="small-note" id="diarize-status"
              >${diarizationStatus()}</span
            >
            <button
              type="button"
              class="ghost-btn small"
              data-act="download-diarization"
              id="diarize-download"
              ${ui.ai.diarizationReady ? raw('disabled') : ''}
            >
              ${ui.ai.diarizationReady ? 'Downloaded' : 'Download model'}
            </button>
          </div>
          <label class="toggle">
            <input
              type="checkbox"
              name="autoEnhance"
              ${ui.db.settings.autoEnhance ? raw('checked') : ''}
            />
            <span
              ><strong>Enhance notes after each meeting</strong
              ><small
                >Runs after recording stops if there is a transcript or raw
                notes.</small
              ></span
            >
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              name="notifications"
              ${ui.db.settings.notifications ? raw('checked') : ''}
            />
            <span
              ><strong>In-app reminders</strong
              ><small
                >One minute before a synced meeting with 2+ attendees. Clicking
                joins the call and starts the note.</small
              ></span
            >
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              name="meetingDetectionEnabled"
              ${ui.db.settings.meetingDetectionEnabled ? raw('checked') : ''}
            />
            <span
              ><strong>Auto-detect meetings</strong
              ><small
                >Shows a banner when a calendar meeting starts or a call window
                (Zoom/Teams/Meet) is active.</small
              ></span
            >
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              name="autoStartMeetingRecording"
              ${ui.db.settings.autoStartMeetingRecording ? raw('checked') : ''}
            />
            <span
              ><strong>Auto-start recording for detected meetings</strong
              ><small
                >When a meeting is detected and this is on, Lilt creates a note
                and starts recording automatically.</small
              ></span
            >
          </label>
        </div>
        <label class="field">
          <span>VAD sensitivity</span>
          <input
            type="range"
            name="vadSensitivity"
            data-change="vad-sensitivity"
            min="0"
            max="1"
            step="0.05"
            value="${ui.db.settings.vadSensitivity ?? 0.5}"
          />
          <span class="range-value"
            >${Math.round((ui.db.settings.vadSensitivity ?? 0.5) * 100)}%</span
          >
          <small
            >Higher = more sensitive to quiet speech. Uses the level of each
            recording, so it applies immediately.</small
          >
        </label>
      </section>

      <div class="settings-save">
        <span class="small-note">Changes save to this device.</span>
        <button class="primary-btn" type="submit">Save settings</button>
      </div>
    </form>

    <section class="settings-section" id="calendar-settings">
      ${calendarSettings()}
    </section>

    <section class="settings-section">
      <div class="settings-head">
        <h2 id="settings-templates" tabindex="-1">Templates</h2>
        <button type="button" class="ghost-btn small" data-act="new-template">
          ${icon('plus', 13)} New template
        </button>
      </div>
      <p class="settings-desc">
        Templates decide the sections of the enhanced note. Built-ins cover
        common meetings; your own templates sit beside them in every note.
      </p>
      <div class="template-list">
        ${ui.db.templates.map(
          (template) =>
            html`<div class="template-row">
              <div>
                <strong>${template.name}</strong>
                <span>${template.sections.join(' · ')}</span>
              </div>
              <span class="template-visibility"
                >${template.builtin ? 'Built-in' : 'Yours'}</span
              >
              ${
                template.builtin
                  ? ''
                  : html`<button
                      type="button"
                      class="tiny-btn danger"
                      data-act="delete-template"
                      data-id="${template.id}"
                      title="Delete template"
                    >
                      ${icon('trash', 12)}
                    </button>`
              }
            </div>`,
        )}
      </div>
    </section>

    <section class="settings-section">
      <div class="settings-head">
        <h2 id="settings-data" tabindex="-1">Data</h2>
      </div>
      <p class="settings-desc">
        Notes, transcripts, and settings are stored on this device. Audio
        retention is configured under Capture.
      </p>
      <div class="data-actions">
        <button class="ghost-btn" data-act="export-all">
          ${icon('download', 14)} Export all notes as CSV
        </button>
        <button class="ghost-btn danger-outline" data-act="reset-demo">
          ${icon('refresh', 13)} Reset to demo data
        </button>
        <button class="ghost-btn danger-outline" data-act="delete-all">
          ${icon('trash', 14)} Delete all notes
        </button>
      </div>
    </section>

    <section class="settings-section about">
      <div class="settings-head">
        <h2 id="settings-about" tabindex="-1">About Lilt</h2>
      </div>
      <p class="settings-desc">
        Lilt records your microphone and optional system audio without adding a
        bot to the call. Shared previews include the summary only.
      </p>
      <div class="about-meta">
        <span>${brandMark(18)} Lilt 1.0</span>
      </div>
    </section>`;
}

function calendarSettings(): Html {
  return html`<div class="settings-head">
      <h2 id="settings-calendar" tabindex="-1">Calendar</h2>
      <span class="status-pill ${ui.calendar.status.connected ? 'good' : ''}">
        <span class="status-dot"></span>
        ${ui.calendar.status.connected ? (ui.calendar.status.provider === 'microsoft' ? 'Outlook' : 'Google Calendar') : 'Not connected'}
      </span>
    </div>
    <p class="settings-desc">
      Read-only, next 14 days. Connecting also sets your name and email from the
      account. The refresh token is encrypted by the OS keychain, never enters
      the note database, and can be removed at any time.
    </p>
    ${
      ui.calendar.status.connected
        ? html`<div class="calendar-account">
              <div class="calendar-account-copy">
                <strong
                  >${ui.calendar.status.name || ui.calendar.status.email || 'Calendar connected'}</strong
                >
                <span>${ui.calendar.status.email}</span>
                <span
                  >${ui.calendar.status.lastSyncedAt ? `Last sync ${relativeDate(ui.calendar.status.lastSyncedAt)}` : 'Not synced yet'}</span
                >
              </div>
              <div class="data-actions">
                <button
                  type="button"
                  class="ghost-btn"
                  data-act="calendar-sync"
                  ${ui.calendar.syncing ? raw('disabled') : ''}
                >
                  ${icon('refresh', 13)}
                  ${ui.calendar.syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <button
                  type="button"
                  class="ghost-btn danger-outline"
                  data-act="calendar-disconnect"
                >
                  ${icon('x', 14)} Disconnect
                </button>
              </div>
            </div>
            ${ui.calendar.status.error ? html`<p class="field-note calendar-error">${ui.calendar.status.error}</p>` : ''}`
        : html`<div class="calendar-connect">
            <div class="field-grid two">
              <label class="field">
                <span>Provider</span>
                <select id="cal-provider">
                  <option value="google">Google Calendar</option>
                  <option value="microsoft">Microsoft Outlook</option>
                </select>
              </label>
              <label class="field">
                <span>OAuth client ID</span>
                <input
                  id="cal-client-id"
                  placeholder="…apps.googleusercontent.com"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
            </div>
            <label class="field">
              <span>Client secret (Google only)</span>
              <input
                id="cal-client-secret"
                type="password"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <p class="field-note">
              Create a <strong>Desktop app</strong> OAuth client in Google Cloud
              Console (no redirect to register) or a Microsoft Entra app with
              public client flows and redirect
              <code>http://localhost/oauth/callback</code>. Sign-in opens in
              your browser.
            </p>
            <button
              type="button"
              class="primary-btn"
              data-act="calendar-connect"
            >
              ${icon('calendar', 13)} Connect calendar
            </button>
          </div>`
    }`;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function chatPane(): Html {
  const scope = ui.chatScope ?? scopeForView();
  const thread = ui.db.threads.find((entry) => entry.id === ui.threadId);
  const messages = thread?.messages ?? [];
  const suggestions =
    scope.type === 'note'
      ? ['What did we decide?', 'What is still open?', 'Draft a follow-up']
      : scope.type === 'person'
        ? [
            `What did I commit to ${scope.label.split(' ')[0]}?`,
            'What is still open with them?',
            'How has our work changed?',
          ]
        : [
            'What did I commit to this week?',
            'Which decisions are still open?',
          ];
  return html`<aside class="chatpane" aria-label="Ask Lilt">
    <header class="chat-head">
      <div>
        <h2 class="chat-title">Ask Lilt</h2>
        <div class="scope-chip" title="Chat is scoped to where you opened it">
          ${scope.type === 'note' ? icon('notes', 11) : scope.type === 'folder' ? icon('folder', 11) : scope.type === 'person' ? icon('people', 11) : icon('notes', 11)}
          ${scope.label}
        </div>
      </div>
      <div class="chat-head-actions">
        <button class="tiny-btn" data-act="new-thread" title="New conversation">
          ${icon('plus', 14)}
        </button>
        <button class="tiny-btn" data-act="close-chat" title="Close">
          ${icon('x', 14)}
        </button>
      </div>
    </header>
    <div class="chat-log" id="chat-log">
      ${
        messages.length === 0
          ? html`<div class="chat-empty">
              <h3>Start a conversation</h3>
              <div class="suggestions">
                ${suggestions.map(
                  (suggestion) =>
                    html`<button
                      class="suggestion"
                      data-act="chat-suggest"
                      data-text="${suggestion}"
                    >
                      ${suggestion} ${icon('arrowRight', 11)}
                    </button>`,
                )}
              </div>
            </div>`
          : messages.map((message) => chatMessage(message))
      }
      ${
        ui.chatBusy
          ? html`<div class="chat-msg assistant">
              <div class="chat-avatar">${icon('chat', 12)}</div>
              <div class="chat-bubble typing">
                <span role="status">Reading your notes…</span>
              </div>
            </div>`
          : ''
      }
    </div>
    <div class="chat-recipes" id="chat-recipes">${chatRecipeMenu()}</div>
    <div class="chat-compose">
      <textarea
        id="chat-input"
        data-input="chat"
        rows="1"
        placeholder="Ask a question or type / for recipes"
        aria-label="Message"
      >
${ui.chatDraft}</textarea>
      <div class="compose-row">
        <select
          class="model-select"
          data-change="chat-model"
          aria-label="Model"
        >
          <option
            value="auto"
            ${ui.chatModel === 'auto' ? raw('selected') : ''}
          >
            Auto
          </option>
          <option
            value="standard"
            ${ui.chatModel === 'standard' ? raw('selected') : ''}
          >
            Standard
          </option>
          <option
            value="thinking"
            ${ui.chatModel === 'thinking' ? raw('selected') : ''}
          >
            Thinking
          </option>
        </select>
        <span class="compose-hint"
          >${ui.ai.configured ? '' : 'Answers from notes on this device'}</span
        >
        <button
          class="send-btn"
          data-act="chat-send"
          ${!ui.chatDraft.trim() || ui.chatBusy ? raw('disabled') : ''}
          title="Send"
        >
          ${icon('send', 14)}
        </button>
      </div>
    </div>
  </aside>`;
}

// Models answer in light markdown; render bold and line breaks, escaped first.
function chatBody(text: string): Html {
  return raw(
    escapeHtml(text)
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\n)[-*]\s+/g, '$1• ')
      .replace(/\n/g, '<br>'),
  );
}

function chatMessage(message: ChatMessage): Html {
  if (message.role === 'user') {
    return html`<div class="chat-msg user">
      <div class="chat-bubble">${message.content}</div>
    </div>`;
  }
  return html`<div class="chat-msg assistant">
    <div class="chat-avatar">${icon('chat', 12)}</div>
    <div class="chat-bubble">
      <div class="chat-text" dir="auto">${chatBody(message.content)}</div>
    </div>
  </div>`;
}

function chatRecipeMenu(): Html {
  if (!ui.chatMenu) return html``;
  const query = ui.chatDraft.replace(/^\//, '').trim().toLowerCase();
  const recipes = ui.db.recipes.filter(
    (recipe) =>
      !query ||
      recipe.name.toLowerCase().includes(query) ||
      recipe.prompt.toLowerCase().includes(query),
  );
  return html`<div class="recipe-menu">
    <div class="recipe-menu-head">
      Recipes <span>${ui.db.recipes.length}</span>
    </div>
    ${
      recipes.length === 0
        ? html`
            <div class="recipe-menu-empty">
              No recipes match.
              <button class="link-btn" data-act="new-recipe">Create one</button>
            </div>
          `
        : recipes.map(
            (recipe) =>
              html`<button
                class="recipe-item"
                data-act="pick-recipe"
                data-id="${recipe.id}"
              >
                ${icon('recipe', 12)}
                <span>${recipe.name}</span>
                <small
                  >${recipe.scope === 'single' ? 'one meeting' : 'multiple'}</small
                >
              </button>`,
          )
    }
  </div>`;
}

function renderChatMenu(): void {
  const container = document.getElementById('chat-recipes');
  if (container) mount(container, chatRecipeMenu());
}

// ---------------------------------------------------------------------------
// Modals and toast
// ---------------------------------------------------------------------------

function modalView(): Html {
  const modal = ui.modal;
  if (!modal) return html``;
  if (modal.type === 'space') {
    const space = modal.spaceId ? spaceById(modal.spaceId) : null;
    const locked = space?.kind === 'personal';
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">${space ? 'Edit space' : 'New space'}</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="space">
          <label class="field">
            <span>Name</span>
            <input
              name="name"
              value="${space?.name ?? ''}"
              placeholder="Client work"
              autofocus
              required
            />
          </label>
          <label class="field">
            <span>Description <small>optional</small></span>
            <textarea
              name="description"
              rows="2"
              placeholder="What belongs here?"
            >
${space?.description ?? ''}</textarea>
          </label>
          <div class="modal-foot">
            ${
              space && !locked
                ? html`<button
                    type="button"
                    class="ghost-btn danger-outline push-left"
                    data-act="delete-space"
                    data-id="${space.id}"
                  >
                    ${icon('trash', 14)} Delete
                  </button>`
                : ''
            }
            <button type="button" class="ghost-btn" data-act="modal-close">
              Cancel
            </button>
            <button type="submit" class="primary-btn">
              ${space ? 'Save space' : 'Create space'}
            </button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  if (modal.type === 'folder') {
    const parents = ui.db.folders
      .filter((folder) => folder.spaceId === modal.spaceId)
      .sort((a, b) =>
        folderPath(ui.db.folders, a.id).localeCompare(
          folderPath(ui.db.folders, b.id),
        ),
      );
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">New folder</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="folder">
          <label class="field">
            <span>Name</span>
            <input name="name" placeholder="Client work" autofocus required />
          </label>
          <label class="field">
            <span>Description <small>optional</small></span>
            <textarea
              name="description"
              rows="2"
              placeholder="What belongs here? Chat uses this to focus."
            ></textarea>
          </label>
          ${
            parents.length
              ? html`<label class="field">
                  <span>Nest inside</span>
                  <select name="parentId">
                    <option value="">Top level</option>
                    ${parents.map(
                      (folder) =>
                        html`<option
                          value="${folder.id}"
                          ${modal.parentId === folder.id ? raw('selected') : ''}
                        >
                          ${folderPath(ui.db.folders, folder.id)}
                        </option>`,
                    )}
                  </select>
                </label>`
              : ''
          }
          <div class="modal-foot">
            <button type="button" class="ghost-btn" data-act="modal-close">
              Cancel
            </button>
            <button type="submit" class="primary-btn">Create folder</button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  if (modal.type === 'template') {
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">New template</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="template">
          <label class="field">
            <span>Name</span>
            <input
              name="name"
              placeholder="Customer discovery"
              autofocus
              required
            />
          </label>
          <label class="field">
            <span>Purpose</span>
            <textarea
              name="prompt"
              rows="3"
              placeholder="What should this template capture? What should it never invent?"
            ></textarea>
          </label>
          <label class="field">
            <span>Sections <small>one per line</small></span>
            <textarea
              name="sections"
              rows="4"
              placeholder="Context&#10;What they said&#10;Risks&#10;Next steps"
            ></textarea>
          </label>
          <div class="modal-foot">
            <button type="button" class="ghost-btn" data-act="modal-close">
              Cancel
            </button>
            <button type="submit" class="primary-btn">Save template</button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  if (modal.type === 'recipe') {
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">New recipe</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="recipe">
          <label class="field">
            <span>Name</span>
            <input
              name="name"
              placeholder="Objections & risks"
              autofocus
              required
            />
          </label>
          <label class="field">
            <span>Prompt</span>
            <textarea
              name="prompt"
              rows="4"
              placeholder="List every objection, with who raised it and the exact wording."
              required
            ></textarea>
          </label>
          <div class="field-grid two">
            <label class="field">
              <span>Scope</span>
              <select name="scope">
                <option value="single">Single meeting</option>
                <option value="multiple">Multiple meetings</option>
              </select>
            </label>
            <label class="field">
              <span>Model</span>
              <select name="model">
                <option value="auto">Auto</option>
                <option value="standard">Standard</option>
                <option value="thinking">Thinking</option>
              </select>
            </label>
          </div>
          <div class="modal-foot">
            <button type="button" class="ghost-btn" data-act="modal-close">
              Cancel
            </button>
            <button type="submit" class="primary-btn">Save recipe</button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  if (modal.type === 'move') {
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">Add to folder</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="move">
          <div class="folder-picker">
            ${ui.db.spaces.map((space) => {
              const folders = ui.db.folders.filter(
                (folder) => folder.spaceId === space.id,
              );
              if (folders.length === 0) return '';
              return html`<div class="picker-group">
                <span class="picker-space">${space.name}</span>
                ${folders.map(
                  (folder) =>
                    html`<label class="picker-row">
                      <input
                        type="checkbox"
                        name="folders"
                        value="${folder.id}"
                      />
                      ${icon(folderIcon(folder.icon), 13)}
                      <span>${folderPath(ui.db.folders, folder.id)}</span>
                    </label>`,
                )}
              </div>`;
            })}
          </div>
          <div class="modal-foot">
            <button type="button" class="ghost-btn" data-act="modal-close">
              Cancel
            </button>
            <button type="submit" class="primary-btn">Add to folders</button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  if (modal.type === 'share') {
    const note = noteById(modal.noteId);
    if (!note) return html``;
    return html`<dialog
      class="modal-backdrop"
      data-act="modal-backdrop"
      aria-labelledby="dialog-title"
    >
      <div class="modal wide">
        <header class="modal-head">
          <div>
            <h2 id="dialog-title">Local preview</h2>
          </div>
          <button class="tiny-btn" data-act="modal-close" title="Close">
            ${icon('x', 15)}
          </button>
        </header>
        <form data-form="share">
          <p class="modal-lede">
            The link opens on this computer and shows the summary and attendees.
            Raw notes and the transcript stay private.
          </p>
          <div class="share-options">
            ${[
              ['off', 'Off', 'Disable the preview link.'],
              [
                'anyone',
                'Preview on this device',
                'Anyone with the link on this computer can open the preview.',
              ],
            ].map(
              ([value, label, description]) =>
                html`<label
                  class="share-option ${note.share.mode === value ? 'active' : ''}"
                >
                  <input
                    type="radio"
                    name="mode"
                    value="${value}"
                    ${note.share.mode === value ? raw('checked') : ''}
                  />
                  <span
                    ><strong>${label}</strong
                    ><small>${description}</small></span
                  >
                </label>`,
            )}
          </div>
          ${
            !note.enhanced
              ? html`<div class="inline-warning">
                  ${icon('zap', 13)}<span
                    >The preview will show that the meeting has no summary
                    yet.</span
                  >
                </div>`
              : ''
          }
          ${
            modal.url
              ? html`<div class="share-url">
                  <span>${modal.url}</span>
                  <div>
                    <button
                      type="button"
                      class="ghost-btn small"
                      data-act="copy-share"
                      data-url="${modal.url}"
                    >
                      ${icon('copy', 12)} Copy
                    </button>
                    <button
                      type="button"
                      class="ghost-btn small"
                      data-act="open-share"
                      data-url="${modal.url}"
                    >
                      ${icon('external', 12)} Open viewer
                    </button>
                  </div>
                </div>`
              : ''
          }
          <div class="modal-foot">
            <button type="button" class="ghost-btn" data-act="modal-close">
              Close
            </button>
            <button type="submit" class="primary-btn">Save preview</button>
          </div>
        </form>
      </div>
      <div class="dialog-feedback"></div>
    </dialog>`;
  }
  return html`<dialog
    class="modal-backdrop"
    data-act="modal-backdrop"
    aria-labelledby="dialog-title"
  >
    <div class="modal confirm">
      <header class="modal-head">
        <div>
          <h2 id="dialog-title">${modal.title}</h2>
        </div>
        <button class="tiny-btn" data-act="modal-close" title="Close">
          ${icon('x', 15)}
        </button>
      </header>
      <p class="modal-lede">${modal.body}</p>
      <div class="modal-foot">
        <button class="ghost-btn" data-act="modal-close" autofocus>
          Cancel
        </button>
        <button
          class="danger-btn"
          data-act="confirm"
          data-id="${modal.id ?? ''}"
          data-action="${modal.action}"
        >
          ${modal.label}
        </button>
      </div>
    </div>
    <div class="dialog-feedback"></div>
  </dialog>`;
}

function toastView(animate = false): Html {
  if (!ui.toast) return html``;
  return html`<div class="toast" data-motion="${animate}" role="status">
    ${ui.toast}
  </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function navigate(view: string, id?: string): void {
  ui.selected.clear();
  ui.lastCheckedId = null;
  ui.query = '';
  if (view === 'note' && id) {
    openNote(id);
    return;
  }
  if (view === 'space' && id) ui.view = { name: 'space', spaceId: id };
  else if (view === 'folder' && id) ui.view = { name: 'folder', folderId: id };
  else if (
    view === 'home' ||
    view === 'notes' ||
    view === 'people' ||
    view === 'recipes' ||
    view === 'calendar' ||
    view === 'trash' ||
    view === 'settings'
  ) {
    ui.view = { name: view };
  }
  renderAll();
}

function openNote(id: string): void {
  const note = noteById(id);
  if (!note) {
    toast('That note no longer exists.');
    return;
  }
  ui.selected.clear();
  ui.noteCollection = collectionForView();
  ui.view = { name: 'note', noteId: id };
  ui.noteTab = note.enhanced ? 'enhanced' : 'raw';
  ui.transcriptQuery = '';
  ui.transcriptHidden = false;
  renderAll();
}

function askConfirm(
  title: string,
  body: string,
  label: string,
  action: ConfirmAction,
  id?: string,
): void {
  ui.modal = { type: 'confirm', title, body, label, action, id };
  renderModal();
}

function runConfirm(action: ConfirmAction, id?: string): void {
  if (
    (action === 'delete-all' || action === 'reset-demo') &&
    capture.isRunning
  ) {
    ui.modal = null;
    renderModal();
    toast('Stop the recording before deleting or resetting notes.');
    return;
  }
  ui.modal = null;
  renderModal();
  const note = noteById(id);
  if (action === 'delete-note' && note) {
    deleteNote(note);
    return;
  }
  if (action === 'delete-forever' && note) {
    removeForever([note]);
    return;
  }
  if (action === 'empty-trash') {
    removeForever(ui.db.notes.filter((entry) => entry.deletedAt));
    return;
  }
  if (action === 'bulk-delete') {
    const notes = ui.db.notes.filter((entry) => ui.selected.has(entry.id));
    for (const entry of notes) {
      entry.deletedAt = nowIso();
      entry.share = { mode: 'off', token: null };
      touch(entry);
    }
    ui.selected.clear();
    persist();
    renderAll();
    toast(
      `Moved ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to trash.`,
    );
    return;
  }
  if (action === 'delete-all') {
    ui.db.notes = [];
    ui.db.threads = [];
    ui.selected.clear();
    ui.chatOpen = false;
    ui.view = { name: 'home' };
    persist(true);
    renderAll();
    toast('All notes deleted from this device.');
    return;
  }
  if (action === 'reset-demo') {
    ui.db = createSeed();
    ui.selected.clear();
    ui.chatOpen = false;
    ui.chatScope = null;
    ui.threadId = null;
    ui.view = { name: 'home' };
    persist(true);
    renderAll();
    toast('Demo data restored.');
    return;
  }
  if (action === 'delete-template' && id) {
    const template = templateById(id);
    if (template?.builtin) {
      toast('Built-in templates cannot be deleted.');
      return;
    }
    ui.db.templates = ui.db.templates.filter((entry) => entry.id !== id);
    for (const entry of ui.db.notes) {
      if (entry.templateId === id) entry.templateId = null;
    }
    persist();
    renderAll();
    toast('Template deleted.');
    return;
  }
  if (action === 'delete-space' && id) {
    deleteSpace(id);
    return;
  }
  if (action === 'delete-folder' && id) {
    deleteFolder(id);
    return;
  }
  if (action === 'delete-recipe' && id) {
    ui.db.recipes = ui.db.recipes.filter((entry) => entry.id !== id);
    persist();
    renderAll();
    toast('Recipe deleted.');
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (
    target instanceof HTMLInputElement &&
    target.dataset.change === 'check' &&
    target.checked &&
    event.shiftKey &&
    ui.lastCheckedId
  ) {
    const notes = listNotes();
    const from = notes.findIndex((entry) => entry.id === ui.lastCheckedId);
    const to = notes.findIndex((entry) => entry.id === target.dataset.id);
    if (from >= 0 && to >= 0) {
      for (const entry of notes.slice(
        Math.min(from, to),
        Math.max(from, to) + 1,
      ))
        ui.selected.add(entry.id);
    }
    return;
  }
  const actionEl = target.closest<HTMLElement>('[data-act]');
  if (!actionEl) return;
  const act = actionEl.dataset.act;
  if (act === 'modal-backdrop') {
    if (target !== actionEl) return;
    ui.modal = null;
    renderModal(event.detail > 0);
    return;
  }
  const id = actionEl.dataset.id;
  const note = noteById(id);

  switch (act) {
    case 'nav':
      navigate(actionEl.dataset.view ?? 'home', actionEl.dataset.id);
      if (actionEl.dataset.section) {
        document
          .getElementById(`settings-${actionEl.dataset.section}`)
          ?.scrollIntoView();
      }
      return;
    case 'back-to-notes': {
      const previousNote = currentNote();
      ui.view = ui.noteCollection;
      ui.selected.clear();
      renderAll();
      const trigger =
        previousNote &&
        document.querySelector<HTMLButtonElement>(
          `#main [data-act="open-note"][data-id="${CSS.escape(previousNote.id)}"]`,
        );
      (trigger || document.getElementById('main'))?.focus();
      return;
    }
    case 'settings-section':
      if (actionEl.dataset.section) {
        const heading = document.getElementById(
          `settings-${actionEl.dataset.section}`,
        );
        heading?.focus();
        heading?.scrollIntoView({ block: 'start' });
      }
      return;
    case 'toggle-rail':
      toggleRail();
      return;
    case 'open-note':
      if (id) {
        openNote(id);
        if (event.detail === 0) document.getElementById('main')?.focus();
      }
      return;
    case 'start-event': {
      const event = eventByKey(actionEl.dataset.key);
      if (event) openEvent(event);
      return;
    }
    case 'join-link': {
      const event = eventByKey(actionEl.dataset.key);
      if (event?.meetingUrl) window.open(event.meetingUrl, '_blank');
      return;
    }
    case 'dismiss-reminder':
      dismissReminder();
      return;
    case 'calendar-sync':
      void refreshCalendar();
      return;
    case 'calendar-disconnect':
      void disconnectCalendar();
      return;
    case 'calendar-connect': {
      const provider =
        (document.getElementById('cal-provider') as HTMLSelectElement | null)
          ?.value === 'microsoft'
          ? 'microsoft'
          : 'google';
      const clientId =
        (
          document.getElementById('cal-client-id') as HTMLInputElement | null
        )?.value.trim() ?? '';
      const clientSecret =
        (
          document.getElementById(
            'cal-client-secret',
          ) as HTMLInputElement | null
        )?.value ?? '';
      void connectCalendarFromForm(provider, clientId, clientSecret);
      return;
    }
    case 'open-person':
      if (actionEl.dataset.person) {
        ui.selected.clear();
        ui.query = '';
        ui.view = { name: 'person', person: actionEl.dataset.person };
        renderAll();
      }
      return;
    case 'new-note':
      addNote();
      return;
    case 'open-chat':
      if (
        ui.chatOpen &&
        ui.chatScope &&
        sameScope(ui.chatScope, scopeForView())
      )
        closeChat(event.detail > 0);
      else startChat(event.detail > 0);
      return;
    case 'close-chat':
      closeChat(event.detail > 0);
      return;
    case 'new-thread':
      newThread();
      return;
    case 'chat-send':
      void sendChat();
      return;
    case 'chat-suggest':
      if (actionEl.dataset.text) {
        ui.chatDraft = actionEl.dataset.text;
        void sendChat();
      }
      return;
    case 'new-recipe':
      ui.modal = { type: 'recipe' };
      renderModal();
      return;
    case 'run-recipe': {
      const recipe = ui.db.recipes.find((entry) => entry.id === id);
      if (recipe) runRecipe(recipe, event.detail > 0);
      return;
    }
    case 'delete-recipe': {
      const recipe = ui.db.recipes.find((entry) => entry.id === id);
      if (recipe) {
        askConfirm(
          'Delete this recipe?',
          `"${recipe.name}" will be removed. This does not touch any notes.`,
          'Delete recipe',
          'delete-recipe',
          recipe.id,
        );
      }
      return;
    }
    case 'pick-recipe': {
      const recipe = ui.db.recipes.find((entry) => entry.id === id);
      if (!recipe) return;
      ui.chatDraft = recipe.prompt;
      ui.chatMenu = false;
      const field = document.getElementById(
        'chat-input',
      ) as HTMLTextAreaElement | null;
      if (field) {
        field.value = recipe.prompt;
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
      renderChatMenu();
      const send = document.querySelector<HTMLButtonElement>('.send-btn');
      if (send) send.disabled = !ui.chatDraft.trim() || ui.chatBusy;
      return;
    }
    case 'new-template':
      ui.modal = { type: 'template' };
      renderModal();
      return;
    case 'delete-template': {
      const template = templateById(id ?? null);
      if (!template) return;
      askConfirm(
        'Delete this template?',
        `"${template.name}" will be removed from the template picker. Existing notes keep their content.`,
        'Delete template',
        'delete-template',
        template.id,
      );
      return;
    }
    case 'new-folder':
      ui.modal = {
        type: 'folder',
        spaceId: actionEl.dataset.space ?? 'space-personal',
        parentId: actionEl.dataset.parent ?? null,
      };
      renderModal();
      return;
    case 'new-space':
      ui.modal = { type: 'space' };
      renderModal();
      return;
    case 'edit-space':
      if (!id) return;
      ui.modal = { type: 'space', spaceId: id };
      renderModal();
      return;
    case 'delete-folder': {
      const folder = folderById(id ?? '');
      if (!folder) return;
      const nested = folderDescendants(ui.db.folders, folder.id).size - 1;
      askConfirm(
        'Delete this folder?',
        `"${folder.name}"${nested ? ` and its ${nested} ${nested === 1 ? 'subfolder' : 'subfolders'}` : ''} will be removed. Notes stay, but they leave this folder. This cannot be undone.`,
        'Delete folder',
        'delete-folder',
        folder.id,
      );
      return;
    }
    case 'delete-space': {
      const space = spaceById(id ?? '');
      if (!space || space.kind === 'personal') return;
      const personalSpace = ui.db.spaces.find(
        (entry) => entry.kind === 'personal',
      );
      const count = ui.db.notes.filter(
        (note) => note.spaceId === space.id,
      ).length;
      askConfirm(
        'Delete this space?',
        `"${space.name}" and its folders will be removed. ${count ? `${count} ${count === 1 ? 'note moves' : 'notes move'} to ${personalSpace?.name ?? 'your personal space'}. ` : ''}This cannot be undone.`,
        'Delete space',
        'delete-space',
        space.id,
      );
      return;
    }
    case 'set-tab': {
      const tab = actionEl.dataset.tab;
      if (tab === 'enhanced' || tab === 'raw' || tab === 'transcript') {
        ui.noteTab = tab;
        renderMain();
        document.getElementById(`tab-${tab}`)?.focus({ preventScroll: true });
      }
      return;
    }
    case 'enhance': {
      const select = document.getElementById(
        'template-select',
      ) as HTMLSelectElement | null;
      if (id) void enhanceNote(id, select ? select.value : undefined);
      return;
    }
    case 'start-recording': {
      if (note && note.status !== 'recording') void startRecording(note);
      return;
    }
    case 'pause-recording':
      void pauseRecording();
      return;
    case 'resume-recording':
      void resumeRecording();
      return;
    case 'stop-recording':
      void stopRecording();
      return;
    case 'delete-note': {
      if (!note) return;
      askConfirm(
        'Move this note to trash?',
        `"${note.title}" will leave search, chat and shared links. You can restore it from Trash.`,
        'Move to trash',
        'delete-note',
        note.id,
      );
      return;
    }
    case 'restore-note': {
      if (note) restoreNote(note);
      return;
    }
    case 'delete-forever': {
      if (!note) return;
      askConfirm(
        'Delete forever?',
        `"${note.title}" and its transcript will be removed from this device. This cannot be undone.`,
        'Delete forever',
        'delete-forever',
        note.id,
      );
      return;
    }
    case 'empty-trash':
      askConfirm(
        'Empty the trash?',
        'Every note in the trash will be removed permanently. This cannot be undone.',
        'Empty trash',
        'empty-trash',
      );
      return;
    case 'select-all': {
      const notes = listNotes();
      const all =
        notes.length > 0 && notes.every((entry) => ui.selected.has(entry.id));
      ui.lastCheckedId = null;
      if (all) ui.selected.clear();
      else for (const entry of notes) ui.selected.add(entry.id);
      renderList();
      return;
    }
    case 'clear-selection':
      ui.selected.clear();
      ui.lastCheckedId = null;
      renderList();
      return;
    case 'clear-search':
      ui.query = '';
      ui.selected.clear();
      ui.lastCheckedId = null;
      renderAll();
      document
        .querySelector<HTMLInputElement>('[data-input="search"]')
        ?.focus();
      return;
    case 'bulk-move':
      moveSelected();
      return;
    case 'bulk-export':
      exportNotes(ui.db.notes.filter((entry) => ui.selected.has(entry.id)));
      return;
    case 'bulk-delete':
      askConfirm(
        'Move these notes to trash?',
        `${ui.selected.size} selected ${ui.selected.size === 1 ? 'note' : 'notes'} will leave search and chat. You can restore them from Trash.`,
        'Move to trash',
        'bulk-delete',
      );
      return;
    case 'copy-transcript': {
      const current = note ?? currentNote();
      if (!current || current.transcript.length === 0) {
        toast('There is no transcript to copy yet.');
        return;
      }
      copyText(
        current.transcript
          .map(
            (segment) =>
              `[${formatClock(segment.startMs)}] ${segment.speaker}: ${segment.text}`,
          )
          .join('\n'),
        'Transcript copied',
      );
      return;
    }
    case 'copy-segment': {
      const current = note ?? currentNote();
      const segment = current?.transcript.find((entry) => entry.id === id);
      if (segment) copyText(segment.text, 'Line copied');
      return;
    }
    case 'delete-segment': {
      const current = note ?? currentNote();
      if (!current) return;
      current.transcript = current.transcript.filter(
        (entry) => entry.id !== id,
      );
      touch(current);
      persist();
      renderTranscript();
      updateTranscriptCount();
      toast('Transcript line removed.');
      return;
    }
    case 'copy-summary': {
      if (!note) return;
      copyText(
        `${note.title}\n${new Date(note.createdAt).toLocaleDateString()}\n\n${enhancedText(note)}`,
        'Summary copied',
      );
      return;
    }
    case 'toggle-transcript':
      ui.transcriptHidden = !ui.transcriptHidden;
      renderMain();
      return;
    case 'share-open-modal': {
      const targetNote = note ?? currentNote();
      if (targetNote) shareNote(targetNote);
      return;
    }
    case 'copy-share':
      if (actionEl.dataset.url)
        copyText(actionEl.dataset.url, 'Share link copied');
      return;
    case 'open-share':
      if (actionEl.dataset.url) window.open(actionEl.dataset.url, '_blank');
      return;
    case 'modal-close':
      ui.modal = null;
      renderModal(event.detail > 0);
      return;
    case 'confirm':
      runConfirm(
        (actionEl.dataset.action ?? '') as ConfirmAction,
        actionEl.dataset.id,
      );
      return;
    case 'remove-key':
      void removeAiKey();
      return;
    case 'download-stt':
      void downloadSttModel();
      return;
    case 'download-diarization':
      void downloadDiarizationModel();
      return;
    case 'export-all': {
      const notes = ui.db.notes.filter((entry) => !entry.deletedAt);
      exportNotes(notes);
      return;
    }
    case 'reset-demo':
      askConfirm(
        'Reset to demo data?',
        'Every note, folder, template, recipe and setting on this device will be replaced by the demo workspace. This cannot be undone.',
        'Reset demo data',
        'reset-demo',
      );
      return;
    case 'delete-all':
      askConfirm(
        'Delete all notes?',
        `All ${ui.db.notes.length} notes, transcripts and chat threads will be removed from this device. Folders and settings stay. This cannot be undone.`,
        'Delete all notes',
        'delete-all',
      );
      return;
    case 'dismiss-meeting-banner':
      dismissMeetingBanner();
      return;
    case 'start-meeting-notes':
      void startMeetingNotesFromBanner();
      return;
    default:
      return;
  }
}

function onInput(event: Event): void {
  const target = event.target;
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    )
  )
    return;
  const kind = target.dataset.input;
  if (!kind) return;

  if (kind === 'search') {
    if (event instanceof InputEvent && event.isComposing) return;
    ui.query = target.value;
    ui.selected.clear();
    ui.lastCheckedId = null;
    if (ui.view.name !== 'notes') {
      const cursor = target.selectionStart;
      ui.view = { name: 'notes' };
      renderAll();
      const field = document.querySelector<HTMLInputElement>(
        '[data-input="search"]',
      );
      if (field) {
        field.focus();
        field.setSelectionRange(cursor, cursor);
      }
      return;
    }
    renderListSoon();
    return;
  }

  if (kind === 'title') {
    const note = noteById(target.dataset.id);
    if (!note) return;
    note.title = target.value;
    touch(note);
    persist();
    renderListSoon();
    return;
  }

  if (kind === 'raw') {
    const note = noteById(target.dataset.id);
    if (!note) return;
    note.rawNotes = target.value;
    touch(note);
    persist();
    const count = document.getElementById('raw-count');
    if (count) {
      const words = note.rawNotes.trim()
        ? note.rawNotes.trim().split(/\s+/).length
        : 0;
      count.textContent = words ? `${words} words` : '';
    }
    return;
  }

  if (kind === 'transcript-search') {
    ui.transcriptQuery = target.value;
    renderTranscript();
    return;
  }

  if (kind === 'chat') {
    ui.chatDraft = target.value;
    const wantsMenu = target.value.startsWith('/');
    if (wantsMenu !== ui.chatMenu) {
      ui.chatMenu = wantsMenu;
      renderChatMenu();
    } else if (wantsMenu) {
      renderChatMenu();
    }
    const send = document.querySelector<HTMLButtonElement>('.send-btn');
    if (send) send.disabled = !ui.chatDraft.trim() || ui.chatBusy;
    return;
  }
}

function onChange(event: Event): void {
  const target = event.target;
  if (
    !(
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    )
  )
    return;
  const kind = target.dataset.change;

  if (kind === 'appearance' && target instanceof HTMLSelectElement) {
    const value = target.value;
    if (value === 'system' || value === 'light' || value === 'dark') {
      ui.db.settings.appearance = value;
      document.documentElement.dataset.appearance = value;
      persist(true);
    }
    return;
  }

  const settingsForm = target.closest<HTMLFormElement>(
    'form[data-form="settings"]',
  );
  if (settingsForm) {
    if (kind === 'stt-source') updateSttSettings();
    void saveSettings(settingsForm, true);
    return;
  }

  if (kind === 'check' && target instanceof HTMLInputElement) {
    const id = target.dataset.id;
    if (!id) return;
    if (target.checked) {
      ui.selected.add(id);
      ui.lastCheckedId = id;
    } else {
      ui.selected.delete(id);
      if (ui.lastCheckedId === id) ui.lastCheckedId = null;
    }
    renderList();
    return;
  }

  if (kind === 'attendees' && target instanceof HTMLInputElement) {
    const note = noteById(target.dataset.id);
    if (!note) return;
    note.attendees = target.value
      .split(',')
      .map((person) => person.trim())
      .filter(Boolean);
    touch(note);
    persist();
    return;
  }

  if (kind === 'template' && target instanceof HTMLSelectElement) {
    const note = noteById(target.dataset.id);
    if (!note) return;
    note.templateId = target.value || null;
    touch(note);
    persist();
    if (note.enhanced)
      toast('Template changed. Regenerate to apply it to the enhanced note.');
    return;
  }

  if (kind === 'include-system' && target instanceof HTMLInputElement) {
    ui.db.settings.includeSystemAudio = target.checked;
    persist();
    return;
  }

  if (kind === 'chat-model' && target instanceof HTMLSelectElement) {
    ui.chatModel = target.value as ChatModel;
    const thread = ui.db.threads.find((entry) => entry.id === ui.threadId);
    if (thread) thread.model = ui.chatModel;
    persist();
    return;
  }

  if (
    target instanceof HTMLInputElement &&
    target.name === 'mode' &&
    target.type === 'radio'
  ) {
    document
      .querySelectorAll<HTMLElement>('.share-option')
      .forEach((option) => {
        const radio = option.querySelector<HTMLInputElement>(
          'input[type="radio"]',
        );
        option.classList.toggle('active', Boolean(radio?.checked));
      });
  }
}

function onSubmit(event: Event): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const kind = form.dataset.form;
  if (!kind) return;
  event.preventDefault();
  if (kind === 'folder') {
    createFolder(form);
    return;
  }
  if (kind === 'space') {
    saveSpace(form);
    return;
  }
  if (kind === 'template') {
    saveTemplate(form);
    return;
  }
  if (kind === 'recipe') {
    saveRecipe(form);
    return;
  }
  if (kind === 'move') {
    const data = new FormData(form);
    applyMove(data.getAll('folders').map(String));
    return;
  }
  if (kind === 'share') {
    void saveShareForm(form);
    return;
  }
  if (kind === 'settings') {
    void saveSettings(form);
  }
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target;
  if (ui.modal) {
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      ui.modal = null;
      renderModal();
    }
    return;
  }

  if (target instanceof HTMLElement && target.getAttribute('role') === 'tab') {
    const tabs = Array.from(
      target.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      ) ?? [],
    );
    const index = tabs.findIndex((tab) => tab === target);
    const direction = getComputedStyle(target).direction === 'rtl' ? -1 : 1;
    let next: HTMLButtonElement | undefined;
    if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs.at(-1);
    else if (event.key === 'ArrowRight')
      next = tabs[(index + direction + tabs.length) % tabs.length];
    else if (event.key === 'ArrowLeft')
      next = tabs[(index - direction + tabs.length) % tabs.length];
    if (next) {
      event.preventDefault();
      next.click();
      return;
    }
  }

  if (event.key === 'Escape') {
    if (
      ui.chatOpen &&
      target instanceof HTMLElement &&
      target.closest('.chatpane')
    ) {
      closeChat();
      return;
    }
    if (ui.selected.size > 0) {
      ui.selected.clear();
      ui.lastCheckedId = null;
      renderList();
    }
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    addNote();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const field = document.querySelector<HTMLInputElement>(
      '[data-input="search"]',
    );
    field?.focus();
    field?.select();
    return;
  }

  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === 'Enter' &&
    target instanceof HTMLElement &&
    target.dataset.input === 'raw'
  ) {
    event.preventDefault();
    const note = currentNote();
    if (note) void enhanceNote(note.id);
    return;
  }

  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    target instanceof HTMLTextAreaElement &&
    target.id === 'chat-input'
  ) {
    event.preventDefault();
    void sendChat();
    return;
  }

  if (
    event.key === 'Enter' &&
    target instanceof HTMLElement &&
    target.isContentEditable
  ) {
    event.preventDefault();
    target.blur();
  }
}

function onFocusOut(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (
    target.classList.contains('note-title') &&
    target instanceof HTMLInputElement
  ) {
    const note = noteById(target.dataset.id);
    if (!note) return;
    if (!target.value.trim()) {
      note.title = 'Untitled note';
      target.value = note.title;
      touch(note);
      persist();
      renderList();
    }
    return;
  }

  const editable = target.closest<HTMLElement>(
    '[data-bullet-id], [data-heading-id]',
  );
  if (!editable) return;
  const note = noteById(editable.dataset.noteId);
  if (!note?.enhanced) return;
  const section = note.enhanced.sections.find(
    (entry) => entry.id === editable.dataset.sectionId,
  );
  if (!section) return;
  const text = (editable.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (editable.dataset.bulletId) {
    const bullet = section.bullets.find(
      (entry) => entry.id === editable.dataset.bulletId,
    );
    if (!bullet) return;
    if (!text) {
      renderMain();
      return;
    }
    if (bullet.text !== text) {
      bullet.text = text;
      touch(note);
      persist();
    }
    return;
  }
  if (!text) {
    renderMain();
    return;
  }
  if (section.heading !== text) {
    section.heading = text;
    touch(note);
    persist();
  }
}

function attachEvents(): void {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('focusout', onFocusOut);
  window.addEventListener('beforeunload', () => persist(true));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function retryPendingChunks(): Promise<void> {
  if (!ui.ai.sttReady) return;

  const pendingChunks = await window.api.audioRetention.readPending();
  if (pendingChunks.length === 0) return;

  toast(
    `${pendingChunks.length} audio chunk${pendingChunks.length > 1 ? 's' : ''} pending retry…`,
  );

  let remaining = 0;
  for (const chunk of pendingChunks) {
    const note = noteById(chunk.noteId);
    // Three attempts, then give up instead of retrying on every launch.
    if (!note || chunk.attempts >= 3) {
      await window.api.audioRetention.deletePending(chunk.filePath);
      continue;
    }

    try {
      await window.api.audioRetention.incrementAttempts(chunk.filePath);

      // Read the audio file via IPC
      const arrayBuffer = await window.api.audioRetention.readChunk(
        chunk.filePath,
      );
      const blob = new Blob([arrayBuffer], { type: 'audio/webm' });

      // Decode to PCM
      const pcm = trimPcm(await blobToPcm(blob), {
        startMs: chunk.speechStartMs,
        endMs: chunk.speechEndMs,
      });

      const local = ui.ai.sttSource !== 'cloud';
      const { text } = await window.api.transcribe(
        local
          ? { pcm, language: chunk.language, prompt: chunk.prompt }
          : {
              data: encodeWav(pcm).buffer,
              mime: 'audio/wav',
              language: chunk.language,
              prompt: chunk.prompt,
            },
      );

      // Succeeded, even if the model heard silence: never retry this file.
      await window.api.audioRetention.deletePending(chunk.filePath);
      if (!text.trim()) continue;

      addTranscriptSegment(
        note,
        chunk.source,
        text.trim(),
        chunk.startMs + chunk.speechStartMs,
        chunk.startMs + chunk.speechEndMs,
        chunk.baseMs,
      );
    } catch (error) {
      remaining += 1;
      console.error('Retry failed for chunk:', chunk.filePath, error);
      // Keep for next launch.
    }
  }

  if (remaining > 0) {
    toast(
      `${remaining} audio chunk${remaining > 1 ? 's' : ''} still pending retry. Check connection and try again.`,
    );
  }
}

async function boot(): Promise<void> {
  if (root) {
    root.innerHTML =
      '<div class="boot-screen"><div class="boot-mark">Lilt</div><p>Opening your notes…</p></div>';
  }
  try {
    const [db, ai, calendarStatus] = await Promise.all([
      window.api.load(),
      window.api.aiConfig(),
      window.api.calendarStatus().catch(() => CALENDAR_OFF),
    ]);
    db.settings = mergeSettings(db.settings);
    for (const note of db.notes) {
      if (note.status === 'recording' || note.status === 'paused') {
        note.status = 'ended';
        note.endedAt = note.endedAt ?? note.updatedAt;
      }
    }
    ui = {
      db,
      ai,
      calendar: { status: calendarStatus, events: [], syncing: false },
      view: { name: 'home' },
      noteCollection: { name: 'notes' },
      query: '',
      selected: new Set(),
      lastCheckedId: null,
      chatOpen: false,
      chatScope: null,
      threadId: null,
      chatDraft: '',
      chatBusy: false,
      chatModel: 'auto',
      chatMenu: false,
      modal: null,
      toast: null,
      noteTab: 'enhanced',
      transcriptQuery: '',
      generatingNoteId: null,
      sttError: '',
      sttWarned: false,
      sttDownload: null,
      focusTitle: false,
      focusChat: false,
      transcriptHidden: false,
      railClosed: false,
    };
    capture = createCapture();
    attachEvents();
    window.api.onSttProgress((progress) => {
      if (!ui.sttDownload) return;
      ui.sttDownload = progress;
      updateSttSettings();
      updateDiarizationSettings();
    });
    window.api.onStreamText(handleStreamText);

    // Retry pending transcriptions from previous session
    void retryPendingChunks();

    renderAll();
    void refreshCalendar();
    window.setInterval(() => void refreshCalendar(), 5 * 60_000);
    window.setInterval(checkReminder, 20_000);
    window.api.onSuspend(() => {
      if (capture.isRunning) {
        toast('Recording stopped because the machine went to sleep.');
        void stopRecording();
      }
    });

    // Meeting detection listener; main only polls while the setting is on.
    window.api.onMeetingDetected(handleMeetingDetected);
    void window.api
      .setMeetingDetectionEnabled(ui.db.settings.meetingDetectionEnabled)
      .catch(() => {});
  } catch (error) {
    console.error(error);
    if (root) {
      root.innerHTML =
        '<div class="boot-screen error"><div class="boot-mark">Lilt</div><p>The notes database could not be opened. Check the log, then restart.</p></div>';
    }
  }
}

void boot();
