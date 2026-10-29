import type {
  Bullet,
  CalendarEvent,
  ChatModel,
  EnhancedNote,
  Folder,
  Note,
  RetrievalHit,
  Scope,
  Section,
  Segment,
  SharedNote,
  SourceRef,
  Settings,
  Store,
  SttSource,
  Template,
  Workspace,
} from './types.ts';

const DAY_MS = 86_400_000;
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
  'did',
  'does',
  'was',
  'were',
  'are',
  'our',
  'you',
  'your',
  'about',
  'have',
  'has',
  'had',
  'can',
  'could',
  'should',
  'would',
  'will',
  'just',
  'into',
  'over',
  'them',
  'they',
  'their',
  'there',
  'been',
  'being',
  'than',
  'then',
  'also',
  'some',
  'any',
  'all',
  'not',
]);

/** Settings a fresh install, or an older store.json, is upgraded to. */
export const DEFAULT_SETTINGS: Settings = {
  notifications: true,
  includeSystemAudio: true,
  sttLanguage: 'en',
  autoEnhance: true,
  vadSensitivity: 0.5,
  autoStartMeetingRecording: false,
  meetingDetectionEnabled: true,
};

/** Fill in settings added since this store was written. */
export function mergeSettings(stored?: Partial<Settings> | null): Settings {
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function visibleNotes(store: Store): Note[] {
  return store.notes.filter((note) => !note.deletedAt);
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function transcriptText(note: Note): string {
  return note.transcript.map((segment) => segment.text).join(' ');
}

export function enhancedText(
  note: Note | { enhanced: EnhancedNote | null },
): string {
  const enhanced = note.enhanced;
  if (!enhanced) return '';
  return enhanced.sections
    .map(
      (section) =>
        section.heading + '\n' + section.bullets.map((b) => b.text).join('\n'),
    )
    .join('\n\n');
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  return notes
    .map((note) => ({ note, score: scoreNote(note, terms) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.note);
}

function queryTerms(query: string): string[] {
  return normalize(query)
    .split(/[^a-z0-9@._-]+/)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

interface NormalizedNote {
  at: string;
  title: string;
  raw: string;
  summary: string;
  transcript: string;
}

const normalizedNotes = new WeakMap<Note, NormalizedNote>();

function normalizedNote(note: Note): NormalizedNote {
  const cached = normalizedNotes.get(note);
  if (cached && cached.at === note.updatedAt) return cached;
  const text = {
    at: note.updatedAt,
    title: normalize(note.title),
    raw: normalize(note.rawNotes),
    summary: normalize(enhancedText(note)),
    transcript: normalize(transcriptText(note)),
  };
  normalizedNotes.set(note, text);
  return text;
}

function scoreNote(note: Note, terms: string[]): number {
  const text = normalizedNote(note);
  let score = 0;
  for (const term of terms) {
    if (text.title.includes(term)) score += 6;
    if (text.raw.includes(term)) score += 3;
    if (text.summary.includes(term)) score += 2;
    if (text.transcript.includes(term)) score += 1;
  }
  return score;
}

export function scopeNotes(store: Store, scope: Scope): Note[] {
  const notes = visibleNotes(store);
  if (scope.type === 'all') return notes;
  if (scope.type === 'note') {
    return notes.filter((note) => note.id === scope.id);
  }
  if (scope.type === 'folder') {
    const folders = folderDescendants(store.folders, scope.id ?? '');
    return notes.filter((note) =>
      note.folderIds.some((folderId) => folders.has(folderId)),
    );
  }
  if (scope.type === 'space') {
    return notes.filter((note) => note.spaceId === scope.id);
  }
  if (scope.type === 'person') {
    const person = normalize(scope.label);
    return notes.filter((note) =>
      note.attendees.some((attendee) => normalize(attendee) === person),
    );
  }
  return notes;
}

export function retrieve(
  store: Store,
  scope: Scope,
  query: string,
): RetrievalHit[] {
  const terms = queryTerms(query);
  const notes = scopeNotes(store, scope);
  if (terms.length === 0) return [];
  const hits: RetrievalHit[] = [];
  for (const note of notes) {
    const score = scoreNote(note, terms);
    if (score === 0) continue;
    const snippets: string[] = [];
    for (const segment of note.transcript) {
      if (snippets.length >= 2) break;
      const text = normalize(segment.text);
      if (terms.some((term) => text.includes(term))) {
        snippets.push(`${segment.speaker}: ${truncate(segment.text, 180)}`);
      }
    }
    for (const line of note.rawNotes.split('\n')) {
      if (snippets.length >= 3) break;
      const text = normalize(line);
      if (text && terms.some((term) => text.includes(term))) {
        snippets.push(truncate(line.trim(), 180));
      }
    }
    if (snippets.length === 0) {
      snippets.push(truncate(enhancedText(note) || note.title, 180));
    }
    hits.push({
      noteId: note.id,
      title: note.title,
      createdAt: note.createdAt,
      snippets,
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 6);
}

export function localAnswer(query: string, hits: RetrievalHit[]): string {
  if (hits.length === 0) {
    return `I couldn't find anything about “${query}” in the notes in scope. Try a person, company or phrase you remember.`;
  }
  const lines = [
    `I found ${hits.length} ${hits.length === 1 ? 'note' : 'notes'} that touch on that:`,
    '',
  ];
  for (const hit of hits) {
    lines.push(hit.title);
    for (const snippet of hit.snippets) lines.push(`  “${snippet}”`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function verifyQuote(note: Note, quote: string): SourceRef {
  const clean = quote.replace(/^["“”']+|["“”']+$/g, '').trim();
  if (clean.length < 8) return { kind: 'unverified', quote: clean };
  const needle = normalize(clean);
  if (normalize(note.rawNotes).includes(needle)) {
    return { kind: 'raw', quote: clean };
  }
  for (const segment of note.transcript) {
    if (normalize(segment.text).includes(needle)) {
      return { kind: 'transcript', quote: clean, segmentId: segment.id };
    }
  }
  return { kind: 'unverified', quote: clean };
}

export function buildEnhanceMessages(
  note: Note,
  template: Template | null,
  modelLabel: string,
): { role: 'system' | 'user'; content: string }[] {
  const sections = template?.sections.length
    ? template.sections
    : ['Summary', 'Decisions', 'Action items'];
  const transcript = note.transcript
    .map(
      (segment) =>
        `[${formatClock(segment.startMs)}] ${segment.speaker}: ${segment.text}`,
    )
    .join('\n')
    .slice(-18_000);
  const system = [
    'You turn a meeting transcript plus the user’s rough notes into crisp enhanced notes.',
    'Return JSON only: {"attendees":["..."],"sections":[{"heading":"...","bullets":[{"text":"...","quote":"..."}]}]}.',
    `Use exactly these section headings: ${sections.join(' | ')}.`,
    'attendees lists the people who took part in the meeting, using the names they are called by in the transcript. Omit companies, roles, and people only mentioned in passing.',
    'Each bullet is one clear sentence. The quote must be copied verbatim from the transcript or the raw notes, 8–240 characters, and must support the bullet.',
    'Never invent facts, names, owners or dates. If the material does not support a section, return it with an empty bullets array.',
    'Prefer the user’s rough notes for emphasis and the transcript for detail.',
    `The assistant model is ${modelLabel}.`,
  ].join('\n');
  const user = [
    `Meeting: ${note.title}`,
    `Date: ${note.createdAt}`,
    note.attendees.length ? `Attendees: ${note.attendees.join(', ')}` : '',
    note.calendarEvent?.agenda ? `Agenda: ${note.calendarEvent.agenda}` : '',
    template ? `Template purpose: ${template.prompt}` : '',
    '',
    'RAW NOTES (typed by the user):',
    note.rawNotes || '(none)',
    '',
    'TRANSCRIPT:',
    transcript || '(none)',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function modelJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start)
    throw new Error('Model did not return JSON');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export function buildAttendeeMessages(note: Note): {
  role: 'system' | 'user';
  content: string;
}[] {
  const transcript = note.transcript
    .map((segment) => `${segment.speaker}: ${segment.text}`)
    .join('\n')
    .slice(-12_000);
  return [
    {
      role: 'system',
      content: [
        'You identify who took part in a meeting from its transcript.',
        'Return JSON only: {"attendees":["Full Name"]}.',
        'Use the names people are called by in the transcript. Do not include companies, job titles, or people who are only mentioned in passing.',
        'Return an empty array when no participant names are clear.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Meeting: ${note.title}`,
        note.attendees.length
          ? `Known attendees: ${note.attendees.join(', ')}`
          : '',
        '',
        'TRANSCRIPT:',
        transcript || '(none)',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export function parseEnhancedResponse(
  text: string,
  note: Note,
  templateId: string | null,
  model: string,
): EnhancedNote {
  const parsed = modelJson(text) as {
    sections?: {
      heading?: unknown;
      bullets?: (string | { text?: unknown; quote?: unknown })[];
    }[];
  };
  if (!Array.isArray(parsed.sections)) throw new Error('Missing sections');
  const sections: Section[] = [];
  for (const section of parsed.sections.slice(0, 12)) {
    if (typeof section.heading !== 'string') continue;
    const bullets: Bullet[] = [];
    for (const bullet of (section.bullets ?? []).slice(0, 20)) {
      const value = typeof bullet === 'string' ? { text: bullet } : bullet;
      const bulletText =
        typeof value.text === 'string' ? value.text.trim() : '';
      if (!bulletText) continue;
      const quote = typeof value.quote === 'string' ? value.quote : '';
      bullets.push({
        id: randomId(),
        text: bulletText,
        source: quote ? verifyQuote(note, quote) : null,
      });
    }
    if (bullets.length > 0) {
      sections.push({ id: randomId(), heading: section.heading, bullets });
    }
  }
  if (sections.length === 0) throw new Error('Model returned no bullets');
  return {
    templateId,
    generatedAt: new Date().toISOString(),
    model,
    sections,
  };
}

/** People named in the same model reply that produced the enhanced note. */
export function parseAttendees(text: string): string[] {
  let value: unknown;
  try {
    value = modelJson(text).attendees;
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const name = raw.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || name.length > 60) continue;
    if (/^(me|you|them|speaker \d+|unknown|n\/a)$/i.test(name)) continue;
    if (names.some((entry) => entry.toLowerCase() === name.toLowerCase()))
      continue;
    names.push(name);
    if (names.length >= 20) break;
  }
  return names;
}

export function localEnhance(
  note: Note,
  template: Template | null,
): EnhancedNote {
  const headings = [
    template?.sections[0] ?? 'Your notes',
    template?.sections[1] ?? 'What was discussed',
    template?.sections[2] ?? 'Possible next steps',
  ];
  const rawLines = note.rawNotes
    .split('\n')
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 1);
  const discussion = note.transcript.filter(
    (segment) => segment.text.trim().length > 24,
  );
  const actionPattern =
    /\b(will|need to|next step|follow up|action|by (mon|tues|wednes|thurs|fri)|deadline|send|schedule|assign|owner)\b/i;
  const actions = discussion.filter((segment) =>
    actionPattern.test(segment.text),
  );

  const sections: Section[] = [];
  const push = (
    heading: string,
    entries: { text: string; source: SourceRef }[],
  ) => {
    if (entries.length === 0) return;
    sections.push({
      id: randomId(),
      heading,
      bullets: entries.slice(0, 8).map((entry) => ({
        id: randomId(),
        text: entry.text,
        source: entry.source,
      })),
    });
  };
  push(
    headings[0],
    rawLines.map((line) => ({
      text: truncate(line, 240),
      source: { kind: 'raw' as const, quote: line },
    })),
  );
  push(
    headings[1],
    discussion.slice(0, 6).map((segment) => ({
      text: truncate(segment.text, 220),
      source: {
        kind: 'transcript' as const,
        quote: segment.text,
        segmentId: segment.id,
      },
    })),
  );
  push(
    headings[2],
    actions.slice(0, 5).map((segment) => ({
      text: truncate(segment.text, 220),
      source: {
        kind: 'transcript' as const,
        quote: segment.text,
        segmentId: segment.id,
      },
    })),
  );
  return {
    templateId: template?.id ?? null,
    generatedAt: new Date().toISOString(),
    model: 'Offline extract',
    sections,
  };
}

export function buildChatMessages(
  question: string,
  hits: RetrievalHit[],
  history: { role: 'user' | 'assistant'; content: string }[],
  meetingOnly: boolean,
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const context = hits
    .map(
      (hit) =>
        `NOTE: ${hit.title} (${hit.createdAt.slice(0, 10)})\n` +
        hit.snippets.map((snippet) => `- ${snippet}`).join('\n'),
    )
    .join('\n\n');
  const system = [
    'You are the memory layer of a private meeting-notes app. Answer only from the supplied notes.',
    'Be concise and concrete. Name the person, meeting and decision. If the notes do not answer it, say so plainly.',
    'Do not use outside knowledge. Never invent action owners or dates.',
    meetingOnly
      ? 'The user is asking about one meeting; stay inside it.'
      : 'The user may be asking across meetings; compare them when useful.',
    '',
    'NOTES:',
    context || '(no matching notes)',
  ].join('\n');
  return [
    { role: 'system', content: system },
    ...history.slice(-8),
    { role: 'user', content: question },
  ];
}

export function sanitizeSharedNote(
  note: Note,
  workspace: Workspace,
): SharedNote {
  const sections = (note.enhanced?.sections ?? []).map((section) => ({
    heading: section.heading,
    bullets: section.bullets.map((bullet) => bullet.text),
  }));
  return {
    title: note.title,
    createdAt: note.createdAt,
    attendees: [...note.attendees],
    workspaceName: workspace.name,
    sections,
    hasSummary: sections.some((section) => section.bullets.length > 0),
  };
}

export function sharedNoteFor(notes: Note[], token: string): Note | null {
  return (
    notes.find(
      (note) =>
        note.share.token === token &&
        note.share.mode === 'anyone' &&
        !note.deletedAt,
    ) ?? null
  );
}

/** A Whisper server on this machine (speaches, whisper.cpp, LocalAI) needs no API key. */
export function isLocalEndpoint(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

export type LocalSttSource = Exclude<SttSource, 'cloud' | 'local-server'>;

/**
 * Local Whisper runs through whisper.cpp on the CPU, so encoder size sets the
 * pace. small q5 (~190 MB) keeps up with live capture on a laptop core;
 * large-v3-turbo is more accurate but ~3× the encoder work and falls behind.
 */
export const LOCAL_STT_MODELS: Record<
  LocalSttSource,
  {
    label: string;
    file: string;
    url: string;
    sizeMb: number;
  }
> = {
  'whisper-small': {
    label: 'Whisper small',
    file: 'ggml-small-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
    sizeMb: 190,
  },
  'whisper-medium': {
    label: 'Whisper medium',
    file: 'ggml-medium-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium-q5_0.bin',
    sizeMb: 770,
  },
  'whisper-large-v3-turbo': {
    label: 'Whisper large-v3 turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sizeMb: 574,
  },
};

/**
 * whisper.cpp reads 16 kHz mono WAV, so PCM from the capture path is packed
 * into one before each run. Browser-safe: no Buffer, so the renderer and the
 * node tests can use it too.
 */
export function encodeWav(
  pcm: Float32Array,
  sampleRate = 16000,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++)
      view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

export function localSttSource(value: string): LocalSttSource | null {
  return Object.hasOwn(LOCAL_STT_MODELS, value)
    ? (value as LocalSttSource)
    : null;
}

// ---------------------------------------------------------------------------
// Voice activity
// ---------------------------------------------------------------------------

/** Scaled RMS below this is room noise, above it is speech. */
export const SPEECH_FLOOR = 0.006;

/**
 * The sensitivity slider (0–1) scales the speech floor: 0.5 keeps the default,
 * higher values lower the floor so quieter speech counts.
 */
export function speechFloorFor(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(1, sensitivity));
  return SPEECH_FLOOR * (1.5 - clamped);
}

const VAD_PAD_BEFORE_MS = 250;
const VAD_PAD_AFTER_MS = 350;

export interface VadFrame {
  /** Capture clock when the level was sampled. */
  atMs: number;
  level: number;
}

/** Speech inside a chunk, in ms from the chunk's start. */
export interface SpeechWindow {
  startMs: number;
  endMs: number;
}

/**
 * Find speech inside one recorded chunk from its sampled levels. Silence is
 * never sent to a model: Whisper invents lines over it and free tiers bill it.
 */
export function speechWindow(
  frames: VadFrame[],
  chunkStartMs: number,
  chunkEndMs: number,
  floor = SPEECH_FLOOR,
): SpeechWindow | null {
  const duration = chunkEndMs - chunkStartMs;
  if (duration <= 0) return null;
  // Throttled timers can leave a chunk unsampled; keep the audio rather than
  // guess it was silence.
  if (frames.length === 0) return { startMs: 0, endMs: duration };
  let first = -1;
  let last = -1;
  let speechFrames = 0;
  for (const frame of frames) {
    if (frame.level < floor) continue;
    if (first < 0) first = frame.atMs;
    last = frame.atMs;
    speechFrames += 1;
  }
  // One loud sample is a click; speech lasts at least two 50 ms frames.
  if (first < 0 || speechFrames < 2) return null;
  const startMs = Math.max(0, first - chunkStartMs - VAD_PAD_BEFORE_MS);
  const endMs = Math.min(duration, last - chunkStartMs + VAD_PAD_AFTER_MS);
  return endMs > startMs ? { startMs, endMs } : null;
}

/** A pause this long after speech ends a chunk, so phrases are not cut. */
export const ENDPOINT_SILENCE_MS = 800;
/** Speech shorter than this waits for more; Whisper needs a little context. */
export const MIN_SPEECH_MS = 2000;

/** True when a chunk holds enough speech and has paused long enough to flush. */
export function chunkEndedByPause(
  speechStartedAtMs: number | null,
  lastLoudAtMs: number,
  nowMs: number,
): boolean {
  if (speechStartedAtMs === null) return false;
  return (
    nowMs - lastLoudAtMs >= ENDPOINT_SILENCE_MS &&
    lastLoudAtMs - speechStartedAtMs >= MIN_SPEECH_MS
  );
}

/** Cut a decoded 16 kHz chunk down to its speech window. */
export function trimPcm(
  pcm: Float32Array,
  window: SpeechWindow,
  sampleRate = 16000,
): Float32Array {
  const start = Math.max(0, Math.floor((window.startMs / 1000) * sampleRate));
  const end = Math.min(
    pcm.length,
    Math.ceil((window.endMs / 1000) * sampleRate),
  );
  return end > start ? pcm.slice(start, end) : pcm;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Google sends an offset; Graph sends a bare UTC time. */
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value
    : `${value}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function attendeeNames(list: unknown): string[] {
  const names = asArray(list).flatMap((raw) => {
    if (typeof raw === 'string') return [raw];
    if (!raw || typeof raw !== 'object') return [];
    const person = raw as Json;
    const address = person.emailAddress as Json | undefined;
    const label = [person.displayName, address?.name].find(
      (value) => typeof value === 'string' && value.trim(),
    );
    const email = address?.address ?? person.email;
    const name =
      typeof label === 'string'
        ? label.trim()
        : typeof email === 'string'
          ? (email.split('@')[0] ?? '')
          : '';
    return name ? [name] : [];
  });
  return [...new Set(names)];
}

export function mapGoogleEvents(payload: unknown): CalendarEvent[] {
  return asArray((payload as { items?: unknown } | null)?.items)
    .flatMap((raw) => {
      const event = raw as Json;
      if (event.status === 'cancelled') return [];
      const start = isoTime((event.start as Json | undefined)?.dateTime);
      const end = isoTime((event.end as Json | undefined)?.dateTime);
      if (!start || !end) return [];
      const conference = event.conferenceData as Json | undefined;
      const video = asArray(conference?.entryPoints)
        .map((point) => point as Json)
        .find((point) => point.entryPointType === 'video')?.uri;
      const url =
        typeof event.hangoutLink === 'string'
          ? event.hangoutLink
          : typeof video === 'string'
            ? video
            : undefined;
      return [
        {
          id: typeof event.id === 'string' ? event.id : undefined,
          title:
            typeof event.summary === 'string' && event.summary
              ? event.summary
              : 'Untitled meeting',
          start,
          end,
          meetingUrl: url,
          attendees: attendeeNames(event.attendees),
          agenda:
            typeof event.description === 'string'
              ? event.description.slice(0, 2000)
              : undefined,
        },
      ];
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function mapMicrosoftEvents(payload: unknown): CalendarEvent[] {
  return asArray((payload as { value?: unknown } | null)?.value)
    .flatMap((raw) => {
      const event = raw as Json;
      if (event.isCancelled === true || event.isAllDay === true) return [];
      const start = isoTime((event.start as Json | undefined)?.dateTime);
      const end = isoTime((event.end as Json | undefined)?.dateTime);
      if (!start || !end) return [];
      const online = event.onlineMeeting as Json | undefined;
      const url =
        typeof online?.joinUrl === 'string'
          ? online.joinUrl
          : typeof event.onlineMeetingUrl === 'string'
            ? event.onlineMeetingUrl
            : undefined;
      return [
        {
          id: typeof event.id === 'string' ? event.id : undefined,
          title:
            typeof event.subject === 'string' && event.subject
              ? event.subject
              : 'Untitled meeting',
          start,
          end,
          meetingUrl: url,
          attendees: attendeeNames(event.attendees),
          agenda:
            typeof event.bodyPreview === 'string'
              ? event.bodyPreview.slice(0, 2000)
              : undefined,
        },
      ];
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function calendarEventKey(event: CalendarEvent): string {
  return event.id ?? `${event.title}@${event.start}`;
}

/** Calendar events worth showing and reminding about in the next window. */
export function upcomingEvents(
  events: CalendarEvent[],
  now = Date.now(),
  days = 14,
): CalendarEvent[] {
  const horizon = now + days * DAY_MS;
  return events
    .filter((event) => {
      const start = Date.parse(event.start);
      const end = Date.parse(event.end);
      return (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        end >= now - 5 * 60_000 &&
        start <= horizon
      );
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** The calendar meeting happening now (or within five minutes) that has a join link. */
export function pickActiveMeeting(
  events: CalendarEvent[],
  now = Date.now(),
): CalendarEvent | null {
  const fiveMinutes = 5 * 60_000;
  const current = events.filter((event) => {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now + fiveMinutes &&
      end >= now - fiveMinutes &&
      Boolean(event.meetingUrl)
    );
  });
  current.sort(
    (a, b) =>
      Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now),
  );
  return current[0] ?? null;
}

const MEETING_WINDOW_PATTERNS = [
  /\bzoom\b/i,
  /\bteams\b/i,
  /\bgoogle meet\b/i,
  /\bwebex\b/i,
  /\bgotomeeting\b/i,
  /\bgotowebinar\b/i,
  /\bbluejeans\b/i,
  /\bwhereby\b/i,
  /\bjitsi\b/i,
  /\bfacetime\b/i,
];

/** Only titles that name a known call app; a bare "meet" matches too much. */
export function isMeetingWindowTitle(title: string): boolean {
  return MEETING_WINDOW_PATTERNS.some((pattern) => pattern.test(title));
}

/** The one-minute reminder: future start, 2+ attendees, not yet announced. */ export function dueReminder(
  events: CalendarEvent[],
  now: number,
  notified: ReadonlySet<string>,
): CalendarEvent | null {
  return (
    events.find((event) => {
      const startsIn = Date.parse(event.start) - now;
      return (
        startsIn > 0 &&
        startsIn <= 60_000 &&
        event.attendees.length >= 2 &&
        !notified.has(calendarEventKey(event))
      );
    }) ?? null
  );
}

export function mergeSegment(
  segments: Segment[],
  next: Segment,
  maxGapMs = 2500,
  maxChars = 520,
): Segment[] {
  const last = segments.at(-1);
  if (
    last &&
    last.source === next.source &&
    last.speaker === next.speaker &&
    next.startMs - last.endMs <= maxGapMs &&
    last.text.length + next.text.length <= maxChars
  ) {
    const merged: Segment = {
      ...last,
      text: `${last.text.trim()} ${next.text.trim()}`.trim(),
      endMs: Math.max(last.endMs, next.endMs),
    };
    return [...segments.slice(0, -1), merged];
  }
  return [...segments, next];
}

export function noteSummary(note: Note): string {
  const enhanced = enhancedText(note).trim();
  if (enhanced) return truncate(enhanced.replace(/\s+/g, ' '), 160);
  if (note.rawNotes.trim()) {
    return truncate(note.rawNotes.replace(/\s+/g, ' '), 160);
  }
  if (note.transcript.length > 0) {
    return truncate(
      note.transcript.map((segment) => segment.text).join(' '),
      160,
    );
  }
  return 'No notes yet';
}

export function folderPath(folders: Folder[], folderId: string): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = folders.find((entry) => entry.id === folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    const parentId = current.parentId;
    current = parentId
      ? folders.find((entry) => entry.id === parentId)
      : undefined;
  }
  return names.join(' / ');
}

/** The folder itself plus every folder nested under it. */
export function folderDescendants(
  folders: Folder[],
  folderId: string,
): Set<string> {
  const ids = new Set<string>();
  const queue = [folderId];
  while (queue.length > 0) {
    const id = queue.pop();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    for (const folder of folders) {
      if (folder.parentId === id) queue.push(folder.id);
    }
  }
  return ids;
}

export function toCsv(notes: Note[]): string {
  const cell = (value: string): string => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""').replace(/\r?\n/g, '\\n')}"`;
  };
  const rows = [
    [
      'title',
      'summary',
      'transcript',
      'created_at',
      'attendees',
      'duration_minutes',
      'template',
    ],
    ...notes.map((note) => [
      note.title,
      enhancedText(note),
      transcriptText(note),
      note.createdAt,
      note.attendees.join('; '),
      String(Math.round(note.durationMs / 60_000)),
      note.templateId ?? '',
    ]),
  ];
  return rows.map((row) => row.map(cell).join(',')).join('\r\n');
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function relativeDate(iso: string, now = Date.now()): string {
  const time = new Date(iso).getTime();
  const diff = now - time;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      new Date(iso).getFullYear() === new Date(now).getFullYear()
        ? undefined
        : 'numeric',
  });
}

export function truncate(text: string, length: number): string {
  const clean = text.trim();
  return clean.length > length
    ? clean.slice(0, length - 1).trimEnd() + '…'
    : clean;
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      (
        {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        } as Record<string, string>
      )[char],
  );
}

export function randomId(): string {
  return crypto.randomUUID();
}

export function modelLabel(model: ChatModel): string {
  return model === 'auto'
    ? 'Auto'
    : model === 'thinking'
      ? 'Thinking'
      : 'Standard';
}

/**
 * True when store.json was written by a failed save after the last IndexedDB
 * commit. A startup seed or migrated file carries no marker and must lose.
 */
export function shouldImportFallback(
  fileMtimeMs: number,
  idbSavedAt: string,
  fallbackSavedAt?: unknown,
): boolean {
  if (typeof fallbackSavedAt !== 'string') return false;
  const idb = Date.parse(idbSavedAt);
  return fileMtimeMs > idb && Date.parse(fallbackSavedAt) > idb;
}
