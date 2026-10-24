import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarEventKey,
  chunkEndedByPause,
  dueReminder,
  encodeWav,
  folderDescendants,
  folderPath,
  isLocalEndpoint,
  LOCAL_STT_MODELS,
  localAnswer,
  localEnhance,
  localSttSource,
  mergeSegment,
  parseAttendees,
  parseEnhancedResponse,
  retrieve,
  sanitizeSharedNote,
  searchNotes,
  segmentFromChunk,
  sharedNoteFor,
  speechWindow,
  toCsv,
  trimPcm,
  mapGoogleEvents,
  mapMicrosoftEvents,
  upcomingEvents,
  verifyQuote,
  visibleNotes,
} from './logic.ts';
import { createSeed } from './seed.ts';

const NOW = Date.now();

test('only known local Whisper models are accepted as an STT source', () => {
  assert.equal(localSttSource('cloud'), null);
  assert.equal(localSttSource('local-server'), null);
  assert.equal(localSttSource('whisper-tiny'), null);
  assert.equal(localSttSource('whisper-large-v3'), null);
  assert.equal(
    localSttSource('whisper-large-v3-turbo'),
    'whisper-large-v3-turbo',
  );
  assert.equal(localSttSource('whisper-small'), 'whisper-small');
  for (const model of Object.values(LOCAL_STT_MODELS)) {
    assert.match(model.url, /whisper/);
    assert.ok(model.file.endsWith('.bin'));
    assert.ok(model.url.endsWith(model.file));
  }
});

test('local audio is packed as 16 kHz mono 16-bit WAV', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -2]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (offset, length) =>
    String.fromCharCode(...wav.slice(offset, offset + length));
  assert.equal(wav.length, 44 + 3 * 2);
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6);
  assert.deepEqual(
    [0, 1, 2].map((i) => view.getInt16(44 + i * 2, true)),
    [0, 16384, -32767],
  );
});

test('a chunk is trimmed to the speech it contains', () => {
  const frames = [
    { atMs: 10_200, level: 0.001 },
    { atMs: 11_000, level: 0.05 },
    { atMs: 11_050, level: 0.05 },
    { atMs: 16_900, level: 0.001 },
  ];
  assert.deepEqual(speechWindow(frames, 10_000, 17_000), {
    startMs: 750,
    endMs: 1400,
  });
});

test('silence and single-sample clicks are never sent', () => {
  assert.equal(speechWindow([{ atMs: 3000, level: 0.001 }], 0, 7000), null);
  assert.equal(speechWindow([{ atMs: 3000, level: 0.9 }], 0, 7000), null);
});

test('a speech window is clamped to the chunk and an unsampled one is kept', () => {
  assert.deepEqual(
    speechWindow(
      [
        { atMs: 50, level: 0.05 },
        { atMs: 100, level: 0.05 },
        { atMs: 6990, level: 0.05 },
        { atMs: 6999, level: 0.05 },
      ],
      0,
      7000,
    ),
    { startMs: 0, endMs: 7000 },
  );
  assert.deepEqual(speechWindow([], 0, 7000), { startMs: 0, endMs: 7000 });
});

test('a chunk ends only after real speech is followed by a pause', () => {
  // Silence before the first word never closes a chunk.
  assert.equal(chunkEndedByPause(null, 0, 10_000), false);
  // A short "mm-hm" is not enough speech to cut on.
  assert.equal(chunkEndedByPause(1000, 1500, 4000), false);
  // Two seconds of speech, then 700 ms of quiet: not yet.
  assert.equal(chunkEndedByPause(1000, 3000, 3700), false);
  // Same speech, 800 ms of quiet: flush.
  assert.equal(chunkEndedByPause(1000, 3000, 3800), true);
});

test('trimming keeps the samples inside the speech window', () => {
  const pcm = new Float32Array(16).map((_, index) => index);
  assert.deepEqual(
    Array.from(trimPcm(pcm, { startMs: 0.25, endMs: 0.5 }, 16_000)),
    [4, 5, 6, 7],
  );
});

test('every note is visible; only trashed notes are hidden', () => {
  const store = createSeed();
  const visible = visibleNotes(store);
  assert.equal(visible.length, 4);
  assert.ok(visible.some((note) => note.id === 'note-q3'));

  const deleted = visible.find((note) => note.id === 'note-q3');
  deleted.deletedAt = new Date(NOW).toISOString();
  assert.equal(visibleNotes(store).length, 3);
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

test('attendees are read from the same model reply as the enhanced note', () => {
  const reply = JSON.stringify({
    attendees: ['Maya Chen', ' maya chen ', 'Me', '', 42, 'Priya Raghavan'],
    sections: [],
  });
  assert.deepEqual(parseAttendees(reply), ['Maya Chen', 'Priya Raghavan']);
  assert.deepEqual(parseAttendees('not json'), []);
});

test('offline enhance always produces usable sections from the local note', () => {
  const note = createSeed().notes.find((entry) => entry.id === 'note-standup');
  const enhanced = localEnhance(note, null);
  assert.ok(enhanced.sections.length >= 2);
  const text = JSON.stringify(enhanced);
  assert.ok(text.includes('Empty state read as broken'));
  assert.equal(enhanced.model, 'Offline extract');
});

test('retrieval respects scope and relevance', () => {
  const store = createSeed();
  const hit = retrieve(
    store,
    { type: 'all', label: 'All notes' },
    'procurement',
  );
  assert.equal(hit.length, 1);
  assert.equal(hit[0].noteId, 'note-acme');
  assert.ok(hit[0].snippets[0].length > 0);
  const offsite = retrieve(
    store,
    { type: 'all', label: 'All notes' },
    'offsite',
  );
  assert.equal(offsite.length, 1);
  assert.equal(offsite[0].noteId, 'note-q3');
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

test('folders nest arbitrarily and a parent scope includes its descendants', () => {
  const store = createSeed();
  store.folders.push({
    id: 'folder-acme-q4',
    spaceId: 'space-team',
    parentId: 'folder-acme',
    name: 'Q4',
    icon: 'folder',
    description: '',
  });
  const acme = store.notes.find((note) => note.id === 'note-acme');
  acme.folderIds = ['folder-acme-q4'];

  assert.equal(
    folderPath(store.folders, 'folder-acme-q4'),
    'Client work / Acme / Q4',
  );
  assert.deepEqual(
    [...folderDescendants(store.folders, 'folder-client')].sort(),
    ['folder-acme', 'folder-acme-q4', 'folder-client'],
  );
  assert.equal(
    retrieve(
      store,
      { type: 'folder', id: 'folder-client', label: 'Client work' },
      'procurement',
    ).length,
    1,
  );

  const client = store.folders.find((folder) => folder.id === 'folder-client');
  client.parentId = 'folder-acme';
  assert.match(folderPath(store.folders, 'folder-acme'), /Acme/);
});

test('search matches transcript and respects note text', () => {
  const store = createSeed();
  const notes = visibleNotes(store);
  assert.equal(searchNotes(notes, 'empty state')[0].id, 'note-standup');
  assert.equal(searchNotes(notes, 'zzzz-nope').length, 0);
  assert.equal(searchNotes(notes, '').length, 4);
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
