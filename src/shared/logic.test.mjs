import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarEventKey,
  dueReminder,
  isLocalEndpoint,
  localAnswer,
  localEnhance,
  mergeSegment,
  parseEnhancedResponse,
  retrieve,
  sanitizeSharedNote,
  searchNotes,
  segmentFromChunk,
  sharedNoteFor,
  toCsv,
  mapGoogleEvents,
  mapMicrosoftEvents,
  upcomingEvents,
  verifyQuote,
  visibleNotes,
} from './logic.ts';
import { createSeed } from './seed.ts';

const NOW = Date.now();

test('free plan hides notes older than the history window, paid keeps them', () => {
  const store = createSeed();
  const free = visibleNotes(store, NOW);
  assert.equal(free.length, 3);
  assert.ok(!free.some((note) => note.id === 'note-q3'));

  store.workspace.plan = 'business';
  const paid = visibleNotes(store, NOW);
  assert.equal(paid.length, 4);

  const deleted = paid.find((note) => note.id === 'note-q3');
  deleted.deletedAt = new Date(NOW).toISOString();
  assert.equal(visibleNotes(store, NOW).length, 3);
});

test('shared viewer payload never contains transcript, raw notes or provenance', () => {
  const store = createSeed();
  const note = store.notes.find((entry) => entry.id === 'note-acme');
  const shared = sanitizeSharedNote(note, store.workspace);
  const json = JSON.stringify(shared);

  assert.equal(shared.title, note.title);
  assert.ok(shared.hasSummary);
  assert.ok(!json.includes(note.rawNotes));
  assert.ok(!json.includes('flat at sixty'));
  assert.ok(!json.includes('Procurement closes their review'));
  assert.ok(!json.includes('segmentId'));
  assert.ok(!json.includes('"quote"'));
  assert.ok(!('transcript' in shared));
  assert.ok(!('rawNotes' in shared));
});

test('share links stay private when revoked, trashed or unknown', () => {
  const store = createSeed();
  const note = store.notes.find((entry) => entry.id === 'note-acme');
  note.share = { mode: 'anyone', token: 'tok-live' };
  assert.equal(sharedNoteFor(store.notes, 'tok-live')?.id, note.id);
  assert.equal(sharedNoteFor(store.notes, 'tok-nope'), null);

  note.deletedAt = new Date(NOW).toISOString();
  assert.equal(sharedNoteFor(store.notes, 'tok-live'), null);

  note.deletedAt = null;
  note.share.mode = 'off';
  assert.equal(sharedNoteFor(store.notes, 'tok-live'), null);

  note.share = { mode: 'workspace', token: 'tok-legacy' };
  assert.equal(sharedNoteFor(store.notes, 'tok-legacy'), null);
});

test('segment timestamps are offset by the recording base', () => {
  const segment = segmentFromChunk('mic', 'hello', 1_000, 2_000, 60_000);
  assert.equal(segment.startMs, 61_000);
  assert.equal(segment.endMs, 62_000);
  assert.equal(segment.speaker, 'Me');
  assert.equal(segmentFromChunk('system', 'hi', 0, 500, 0).speaker, 'Them');
});

test('segments merge only when same source, close and short', () => {
  const a = {
    id: 'a',
    source: 'mic',
    speaker: 'You',
    text: 'hello there',
    startMs: 0,
    endMs: 1000,
  };
  const b = {
    id: 'b',
    source: 'mic',
    speaker: 'You',
    text: 'this is a test',
    startMs: 1500,
    endMs: 3000,
  };
  const c = {
    id: 'c',
    source: 'system',
    speaker: 'Them',
    text: 'other side',
    startMs: 3500,
    endMs: 4000,
  };
  let list = mergeSegment([], a);
  list = mergeSegment(list, b);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'hello there this is a test');
  list = mergeSegment(list, c);
  assert.equal(list.length, 2);
});

test('provenance verifies quotes against raw notes and transcript only', () => {
  const note = createSeed().notes.find((entry) => entry.id === 'note-acme');
  assert.equal(
    verifyQuote(note, 'Usage is up, but seats have been flat at sixty').kind,
    'transcript',
  );
  assert.equal(verifyQuote(note, 'Usage +40% since January').kind, 'raw');
  const invented = verifyQuote(note, 'Acme agreed to a three year contract');
  assert.equal(invented.kind, 'unverified');
  assert.equal(verifyQuote(note, 'short').kind, 'unverified');
});

test('parsing model JSON keeps verified sources and flags invented quotes', () => {
  const note = createSeed().notes.find((entry) => entry.id === 'note-acme');
  const modelText =
    '```json\n' +
    JSON.stringify({
      sections: [
        {
          heading: 'Context',
          bullets: [
            {
              text: 'Procurement closes at month end.',
              quote: 'Procurement closes their review at the end of the month',
            },
            {
              text: 'A quote nobody said.',
              quote: 'We will sign a five year deal tomorrow',
            },
          ],
        },
      ],
    }) +
    '\n```';
  const enhanced = parseEnhancedResponse(
    modelText,
    note,
    'template-sales',
    'test-model',
  );
  assert.equal(enhanced.sections.length, 1);
  assert.equal(enhanced.sections[0].bullets[0].source.kind, 'transcript');
  assert.equal(enhanced.sections[0].bullets[1].source.kind, 'unverified');
  assert.throws(() => parseEnhancedResponse('not json', note, null, 'test'));
});

test('offline enhance always produces usable sections from the local note', () => {
  const note = createSeed().notes.find((entry) => entry.id === 'note-standup');
  const enhanced = localEnhance(note, null);
  assert.ok(enhanced.sections.length >= 2);
  const text = JSON.stringify(enhanced);
  assert.ok(text.includes('Empty state read as broken'));
  assert.equal(enhanced.model, 'Offline extract');
});

test('retrieval respects scope, plan and relevance', () => {
  const store = createSeed();
  const hit = retrieve(
    store,
    { type: 'all', label: 'All notes' },
    'procurement',
  );
  assert.equal(hit.length, 1);
  assert.equal(hit[0].noteId, 'note-acme');
  assert.ok(hit[0].snippets[0].length > 0);
  assert.equal(
    retrieve(store, { type: 'all', label: 'All notes' }, 'offsite').length,
    0,
  );
  assert.equal(
    retrieve(
      store,
      { type: 'folder', id: 'folder-design', label: 'Design' },
      'procurement',
    ).length,
    0,
  );
  assert.ok(localAnswer('procurement', hit).includes('Acme renewal'));
  assert.ok(localAnswer('nothing here', []).includes("couldn't find"));
});

test('search matches transcript and respects note text', () => {
  const store = createSeed();
  const notes = visibleNotes(store, NOW);
  assert.equal(searchNotes(notes, 'empty state')[0].id, 'note-standup');
  assert.equal(searchNotes(notes, 'zzzz-nope').length, 0);
  assert.equal(searchNotes(notes, '').length, 3);
});

test('csv export quotes newlines, quotes and formula cells', () => {
  const store = createSeed();
  const note = store.notes[0];
  note.title = 'A "quoted"\n title';
  const csv = toCsv([note]);
  assert.ok(csv.startsWith('"title","summary"'));
  assert.ok(csv.includes('"A ""quoted""\\n title"'));

  note.title = '=HYPERLINK("http://example.test","x")';
  assert.ok(toCsv([note]).includes(`"'=HYPERLINK`));
  note.title = '+1 (555) 0100';
  assert.ok(toCsv([note]).includes(`"'+1 (555) 0100"`));
});

test('local endpoints skip the API key, remote ones do not', () => {
  assert.ok(isLocalEndpoint('http://127.0.0.1:8000/v1'));
  assert.ok(isLocalEndpoint('http://localhost:8000/v1'));
  assert.ok(isLocalEndpoint('http://[::1]:8000/v1'));
  assert.ok(!isLocalEndpoint('https://api.openai.com/v1'));
  assert.ok(!isLocalEndpoint('http://192.168.1.20:8000/v1'));
  assert.ok(!isLocalEndpoint('not a url'));
});

test('google events map to calendar events, skipping cancelled and all-day', () => {
  const events = mapGoogleEvents({
    items: [
      {
        id: 'g1',
        summary: 'Acme renewal',
        status: 'confirmed',
        start: { dateTime: '2026-10-24T09:00:00+03:00' },
        end: { dateTime: '2026-10-24T10:00:00+03:00' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        attendees: [
          { displayName: 'Maya Chen', email: 'maya@acme.com' },
          { email: 'daniel@acme.com' },
        ],
        description: 'Renewal pricing',
      },
      {
        id: 'g2',
        summary: 'Cancelled',
        status: 'cancelled',
        start: { dateTime: '2026-10-24T11:00:00Z' },
        end: { dateTime: '2026-10-24T12:00:00Z' },
      },
      {
        id: 'g3',
        summary: 'All day',
        start: { date: '2026-10-24' },
        end: { date: '2026-10-25' },
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'g1');
  assert.deepEqual(events[0].attendees, ['Maya Chen', 'daniel']);
  assert.equal(events[0].meetingUrl, 'https://meet.google.com/abc-defg-hij');
  assert.equal(events[0].start, '2026-10-24T06:00:00.000Z');
  assert.equal(events[0].agenda, 'Renewal pricing');
});

test('microsoft events map to calendar events with UTC-normalised times', () => {
  const events = mapMicrosoftEvents({
    value: [
      {
        id: 'm1',
        subject: 'Quarterly review',
        start: { dateTime: '2026-10-24T09:00:00.0000000' },
        end: { dateTime: '2026-10-24T10:00:00.0000000' },
        attendees: [
          { emailAddress: { name: 'Priya Raghavan', address: 'p@x.com' } },
        ],
        onlineMeeting: {
          joinUrl: 'https://teams.microsoft.com/l/meetup-join/1',
        },
        bodyPreview: 'Numbers and next steps',
      },
      {
        id: 'm2',
        subject: 'All day',
        isAllDay: true,
        start: { dateTime: '2026-10-24T00:00:00' },
        end: { dateTime: '2026-10-25T00:00:00' },
      },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(
    events[0].meetingUrl,
    'https://teams.microsoft.com/l/meetup-join/1',
  );
  assert.equal(events[0].start, '2026-10-24T09:00:00.000Z');
  assert.deepEqual(events[0].attendees, ['Priya Raghavan']);
});

test('upcoming events sort by start and drop those already over', () => {
  const now = Date.parse('2026-10-24T09:00:00Z');
  const events = upcomingEvents(
    [
      {
        title: 'Later',
        start: '2026-10-24T12:00:00Z',
        end: '2026-10-24T13:00:00Z',
        attendees: [],
      },
      {
        title: 'Over',
        start: '2026-10-24T07:00:00Z',
        end: '2026-10-24T08:00:00Z',
        attendees: [],
      },
      {
        title: 'Next',
        start: '2026-10-24T09:30:00Z',
        end: '2026-10-24T10:00:00Z',
        attendees: [],
      },
      {
        title: 'Far',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
        attendees: [],
      },
    ],
    now,
  );
  assert.deepEqual(
    events.map((event) => event.title),
    ['Next', 'Later'],
  );
});

test('a reminder fires once for a meeting starting within a minute with 2+ attendees', () => {
  const now = Date.parse('2026-10-24T09:00:00Z');
  const meeting = {
    id: 'evt-1',
    title: 'Standup',
    start: '2026-10-24T09:00:45Z',
    end: '2026-10-24T09:15:00Z',
    attendees: ['Me', 'Maya'],
  };
  const solo = { ...meeting, id: 'evt-2', title: 'Solo', attendees: ['Me'] };

  assert.equal(dueReminder([solo, meeting], now, new Set())?.id, 'evt-1');
  assert.equal(
    dueReminder([meeting], now, new Set([calendarEventKey(meeting)])),
    null,
  );
  assert.equal(dueReminder([meeting], now + 120_000, new Set()), null);
});
