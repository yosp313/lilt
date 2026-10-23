import type {
  Bullet,
  CalendarEvent,
  ChatModel,
  EnhancedNote,
  Folder,
  Note,
  Plan,
  RetrievalHit,
  Scope,
  Section,
  Segment,
  SharedNote,
  SourceRef,
  SpeakerSource,
  Store,
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

export function historyCutoff(plan: Plan, now: number, days = 30): number {
  return plan === 'free' ? now - days * DAY_MS : 0;
}

export function isHistoryVisible(
  note: Note,
  plan: Plan,
  now: number,
  days = 30,
): boolean {
  return new Date(note.createdAt).getTime() >= historyCutoff(plan, now, days);
}

export function visibleNotes(store: Store, now = Date.now()): Note[] {
  return store.notes.filter(
    (note) =>
      !note.deletedAt &&
      isHistoryVisible(
        note,
        store.workspace.plan,
        now,
        store.settings.historyDays,
      ),
  );
}

export function hiddenByHistory(store: Store, now = Date.now()): number {
  return store.notes.filter(
    (note) =>
      !note.deletedAt &&
      !isHistoryVisible(
        note,
        store.workspace.plan,
        now,
        store.settings.historyDays,
      ),
  ).length;
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

export function scopeNotes(
  store: Store,
  scope: Scope,
  now = Date.now(),
): Note[] {
  const notes = visibleNotes(store, now);
  if (scope.type === 'all') return notes;
  if (scope.type === 'note') {
    return notes.filter((note) => note.id === scope.id);
  }
  if (scope.type === 'folder') {
    return notes.filter((note) => note.folderIds.includes(scope.id ?? ''));
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
  now = Date.now(),
): RetrievalHit[] {
  const terms = queryTerms(query);
  const notes = scopeNotes(store, scope, now);
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
    'Return JSON only: {"sections":[{"heading":"...","bullets":[{"text":"...","quote":"..."}]}]}.',
    `Use exactly these section headings: ${sections.join(' | ')}.`,
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

export function parseEnhancedResponse(
  text: string,
  note: Note,
  templateId: string | null,
  model: string,
): EnhancedNote {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start)
    throw new Error('Model did not return JSON');
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
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

/** The one-minute reminder: future start, 2+ attendees, not yet announced. */
export function dueReminder(
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

export function segmentFromChunk(
  source: SpeakerSource,
  text: string,
  startMs: number,
  endMs: number,
  baseMs: number,
): Segment {
  return {
    id: randomId(),
    source,
    speaker: source === 'mic' ? 'Me' : 'Them',
    text,
    startMs: baseMs + startMs,
    endMs: baseMs + endMs,
  };
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
  const folder = folders.find((entry) => entry.id === folderId);
  if (!folder) return '';
  if (!folder.parentId) return folder.name;
  const parent = folders.find((entry) => entry.id === folder.parentId);
  return parent ? `${parent.name} / ${folder.name}` : folder.name;
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
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
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
