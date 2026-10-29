import type { Note, Segment, SourceRef, Store, Template } from './types.ts';
import { DEFAULT_SETTINGS, randomId, verifyQuote } from './logic.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function segment(
  source: 'mic' | 'system',
  speaker: string,
  text: string,
  startMin: number,
  endMin: number,
): Segment {
  return {
    id: randomId(),
    source,
    speaker,
    text,
    startMs: startMin * MINUTE,
    endMs: endMin * MINUTE,
    speakerConfidence: null,
    voicePrintId: null,
  };
}

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

function bullets(
  note: Pick<Note, 'rawNotes' | 'transcript'>,
  entries: [string, string][],
) {
  return entries.map(([text, quote]) => ({
    id: randomId(),
    text,
    source: verifyQuote(note as Note, quote) as SourceRef,
  }));
}

export function createSeed(): Store {
  const acmeTranscript: Segment[] = [
    segment(
      'system',
      'Maya Chen',
      'Thanks for jumping on. I want to keep this simple: the renewal is in front of our CFO on Friday.',
      0,
      1,
    ),
    segment(
      'mic',
      'You',
      'Appreciate that. Before pricing, let’s make sure the value story is right. Usage is up forty percent since January.',
      1,
      2,
    ),
    segment(
      'system',
      'Daniel Okafor',
      'Usage is up, but seats have been flat at sixty. The CFO sees forty percent more usage and no expansion.',
      2,
      3,
    ),
    segment(
      'mic',
      'You',
      'That is fair. We could do twelve percent off renewal plus a credit toward onboarding the next team.',
      3,
      4,
    ),
    segment(
      'system',
      'Maya Chen',
      'Eighteen percent is the number they wrote down. I don’t think I can sell twelve without something else.',
      4,
      5,
    ),
    segment(
      'system',
      'Daniel Okafor',
      'What if we add a quarterly business review and a named success manager? That is worth more than six points to us.',
      5,
      6,
    ),
    segment(
      'mic',
      'You',
      'I can bundle the QBR and a named CSM. Let me send a revised quote by Thursday with both options.',
      6,
      7,
    ),
    segment(
      'system',
      'Maya Chen',
      'Thursday works. Procurement closes their review at the end of the month, so we need legal redlines moving in parallel.',
      7,
      8,
    ),
    segment(
      'mic',
      'You',
      'I’ll loop in legal today. Send me the MSA redlines and I’ll route them with the quote.',
      8,
      9,
    ),
    segment(
      'system',
      'Priya Raghavan',
      'One flag: if we discount seats now, the expansion team will expect the same rate in Q1.',
      9,
      10,
    ),
  ];
  const acmeRaw = `- Acme wants 18% off to renew; CFO is pushing hard
- Usage +40% since January, seats flat at 60
- Daniel: 12% + onboarding credit, not 18
- Bundle QBR + named CSM instead of more discount
- Procurement closes end of month; legal redlines need to move in parallel
- Send revised quote Thursday with both options
- Priya: protect Q1 expansion pricing`;

  const acme: Note = {
    id: 'note-acme',
    spaceId: 'space-team',
    folderIds: ['folder-client', 'folder-acme'],
    title: 'Acme renewal — pricing pushback',
    status: 'ended',
    createdAt: ago(53),
    updatedAt: ago(52),
    startedAt: ago(53),
    endedAt: ago(52),
    durationMs: 42 * MINUTE,
    attendees: [
      'Maya Chen',
      'Daniel Okafor',
      'Priya Raghavan',
      'Youssef Ayman',
    ],
    calendarEvent: {
      title: 'Acme renewal',
      start: ago(53),
      end: ago(52),
      meetingUrl: 'https://meet.google.com/acme-renewal',
      attendees: ['Maya Chen', 'Daniel Okafor', 'Priya Raghavan'],
      agenda: 'Renewal pricing, procurement timeline, expansion',
    },
    rawNotes: acmeRaw,
    templateId: 'template-sales',
    transcript: acmeTranscript,
    deletedAt: null,
    share: { mode: 'off', token: null },
    enhanced: null,
  };
  acme.enhanced = {
    templateId: 'template-sales',
    generatedAt: ago(52),
    model: 'Granola-class demo',
    sections: [
      {
        id: randomId(),
        heading: 'Context',
        bullets: bullets(acme, [
          [
            'Acme’s renewal is with the CFO on Friday, with procurement closing at month end.',
            'the renewal is in front of our CFO on Friday',
          ],
          [
            'Usage is up 40% while seats stayed flat at 60, which is the CFO’s core objection.',
            'Usage is up, but seats have been flat at sixty',
          ],
        ]),
      },
      {
        id: randomId(),
        heading: 'What they said',
        bullets: bullets(acme, [
          [
            'Maya anchored at 18% off and doubts she can sell 12% without more value.',
            'Eighteen percent is the number they wrote down',
          ],
          [
            'Daniel values a quarterly business review and a named success manager more than extra points.',
            'What if we add a quarterly business review and a named success manager?',
          ],
        ]),
      },
      {
        id: randomId(),
        heading: 'Risks',
        bullets: bullets(acme, [
          [
            'A seat-level discount now could reset expectations for Q1 expansion.',
            'if we discount seats now, the expansion team will expect the same rate in Q1',
          ],
          [
            'Legal redlines must move in parallel with the quote or procurement slips.',
            'we need legal redlines moving in parallel',
          ],
        ]),
      },
      {
        id: randomId(),
        heading: 'Next steps',
        bullets: bullets(acme, [
          [
            'Send a revised quote by Thursday with 12% plus onboarding credit, and a bundle with QBR and named CSM.',
            'Let me send a revised quote by Thursday with both options',
          ],
          [
            'Ask Maya for the MSA redlines today and route them to legal with the quote.',
            'Send me the MSA redlines and I’ll route them with the quote',
          ],
        ]),
      },
    ],
  };

  const oneOnOneTranscript: Segment[] = [
    segment(
      'mic',
      'You',
      'How are you feeling about the Acme renewal? You carried most of that call.',
      0,
      1,
    ),
    segment(
      'system',
      'Maya Chen',
      'Good, honestly. I was nervous about the CFO number, but the QBR bundle gives me a story.',
      1,
      2,
    ),
    segment(
      'mic',
      'You',
      'Agreed. I want you to own the revised quote and the legal thread. I’ll review before it goes out.',
      2,
      3,
    ),
    segment(
      'system',
      'Maya Chen',
      'That helps. One thing I’m stuck on is the expansion playbook. I keep rewriting it and it never feels usable.',
      3,
      4,
    ),
    segment(
      'mic',
      'You',
      'Let’s timebox it: one page, three plays, by next Wednesday. Bring it to the team review instead of polishing alone.',
      4,
      5,
    ),
    segment(
      'system',
      'Maya Chen',
      'Deal. Also, I’d like to shadow the Northwind onboarding next month. I think I’m missing the implementation side.',
      5,
      6,
    ),
  ];
  const oneOnOne: Note = {
    id: 'note-1on1',
    spaceId: 'space-personal',
    folderIds: ['folder-ones'],
    title: 'Weekly 1:1 — Maya',
    status: 'ended',
    createdAt: ago(26),
    updatedAt: ago(25),
    startedAt: ago(26),
    endedAt: ago(25),
    durationMs: 31 * MINUTE,
    attendees: ['Maya Chen', 'Youssef Ayman'],
    calendarEvent: null,
    rawNotes: `- Maya carried the Acme call well
- She owns revised quote + legal thread; I review
- Expansion playbook stuck: one page, three plays, next Wednesday
- Shadow Northwind onboarding next month
- Check in on workload after renewal closes`,
    templateId: 'template-one-on-one',
    transcript: oneOnOneTranscript,
    deletedAt: null,
    share: { mode: 'off', token: null },
    enhanced: null,
  };
  oneOnOne.enhanced = {
    templateId: 'template-one-on-one',
    generatedAt: ago(25),
    model: 'Granola-class demo',
    sections: [
      {
        id: randomId(),
        heading: 'Wins',
        bullets: bullets(oneOnOne, [
          [
            'Maya feels good about the Acme renewal and the QBR bundle gives her a story for the CFO.',
            'the QBR bundle gives me a story',
          ],
        ]),
      },
      {
        id: randomId(),
        heading: 'Friction',
        bullets: bullets(oneOnOne, [
          [
            'The expansion playbook keeps getting rewritten without becoming usable.',
            'I keep rewriting it and it never feels usable',
          ],
          [
            'Maya feels she is missing the implementation side of the business.',
            'I think I’m missing the implementation side',
          ],
        ]),
      },
      {
        id: randomId(),
        heading: 'Actions',
        bullets: bullets(oneOnOne, [
          [
            'Maya owns the revised Acme quote and the legal thread; Youssef reviews before it goes out.',
            'I want you to own the revised quote and the legal thread',
          ],
          [
            'Deliver a one-page, three-play expansion playbook by next Wednesday for team review.',
            'one page, three plays, by next Wednesday',
          ],
          [
            'Schedule Maya to shadow the Northwind onboarding next month.',
            'I’d like to shadow the Northwind onboarding next month',
          ],
        ]),
      },
    ],
  };

  const standupTranscript: Segment[] = [
    segment(
      'system',
      'Priya Raghavan',
      'Quick one from design: the empty state tested badly. People thought the page was broken.',
      0,
      1,
    ),
    segment(
      'mic',
      'You',
      'Let’s use the meeting-note sample instead of an illustration. It shows the product doing the work.',
      1,
      2,
    ),
    segment(
      'system',
      'Daniel Okafor',
      'I can ship that this afternoon. I need the copy for the two buttons.',
      2,
      3,
    ),
    segment(
      'mic',
      'You',
      'I’ll write it after this. “Start a note” and “See a sample”.',
      3,
      4,
    ),
    segment(
      'system',
      'Priya Raghavan',
      'Also, the transcript bubbles need a quieter green. The current one fights the recording dot.',
      4,
      5,
    ),
    segment(
      'mic',
      'You',
      'Agreed. Priya, can you send the token by tomorrow? Daniel, hold the empty state until it lands.',
      5,
      6,
    ),
  ];
  const standup: Note = {
    id: 'note-standup',
    spaceId: 'space-team',
    folderIds: ['folder-design'],
    title: 'Design standup',
    status: 'ended',
    createdAt: ago(4),
    updatedAt: ago(3.8),
    startedAt: ago(4),
    endedAt: ago(3.8),
    durationMs: 14 * MINUTE,
    attendees: ['Priya Raghavan', 'Daniel Okafor', 'Youssef Ayman'],
    calendarEvent: null,
    rawNotes: `- Empty state read as broken in testing
- Use a real meeting-note sample, not an illustration
- Copy: "Start a note" / "See a sample"
- Quieter green for transcript bubbles
- Priya sends token tomorrow; Daniel holds empty state`,
    templateId: null,
    transcript: standupTranscript,
    deletedAt: null,
    share: { mode: 'off', token: null },
    enhanced: null,
  };

  const oldTranscript: Segment[] = [
    segment(
      'system',
      'Daniel Okafor',
      'For Q3 I want one bet: make the first note feel effortless.',
      0,
      1,
    ),
    segment(
      'mic',
      'You',
      'Then we cut the calendar setup to one screen and measure time to first transcript.',
      1,
      2,
    ),
  ];
  const oldNote: Note = {
    id: 'note-q3',
    spaceId: 'space-team',
    folderIds: [],
    title: 'Q3 planning offsite',
    status: 'ended',
    createdAt: ago(47 * 24),
    updatedAt: ago(47 * 24 - 1),
    startedAt: ago(47 * 24),
    endedAt: ago(47 * 24 - 1),
    durationMs: 90 * MINUTE,
    attendees: ['Daniel Okafor', 'Priya Raghavan', 'Youssef Ayman'],
    calendarEvent: null,
    rawNotes:
      '- One bet for Q3: effortless first note\n- Cut calendar setup to one screen\n- Measure time to first transcript',
    templateId: null,
    transcript: oldTranscript,
    deletedAt: null,
    share: { mode: 'off', token: null },
    enhanced: {
      templateId: null,
      generatedAt: ago(47 * 24 - 2),
      model: 'Granola-class demo',
      sections: [
        {
          id: randomId(),
          heading: 'The bet',
          bullets: [
            {
              id: randomId(),
              text: 'Make the first note feel effortless.',
              source: {
                kind: 'transcript',
                quote: 'make the first note feel effortless',
                segmentId: oldTranscript[0].id,
              },
            },
            {
              id: randomId(),
              text: 'Measure time to first transcript as the Q3 north star.',
              source: {
                kind: 'raw',
                quote: 'Measure time to first transcript',
              },
            },
          ],
        },
      ],
    },
  };

  const templates: Template[] = [
    {
      id: 'template-general',
      name: 'General meeting',
      prompt:
        'Balanced notes for any meeting: what happened, what matters, what is next.',
      sections: ['Summary', 'Decisions', 'Action items'],
      builtin: true,
    },
    {
      id: 'template-sales',
      name: 'Sales call',
      prompt:
        'Capture the customer’s words, objections, risks and concrete next steps. Do not invent commitments.',
      sections: ['Context', 'What they said', 'Risks', 'Next steps'],
      builtin: true,
    },
    {
      id: 'template-one-on-one',
      name: '1:1',
      prompt:
        'A private, humane 1:1 note: wins, friction, growth and actions. Stay close to what was said.',
      sections: ['Wins', 'Friction', 'Growth', 'Actions'],
      builtin: true,
    },
    {
      id: 'template-standup',
      name: 'Standup',
      prompt:
        'Short operational note: progress, blockers, owners, today’s plan.',
      sections: ['Progress', 'Blockers', 'Owners', 'Plan'],
      builtin: true,
    },
    {
      id: 'template-interview',
      name: 'Interview',
      prompt:
        'Evidence-based interview note: signal, concerns, quotes and a recommendation.',
      sections: ['Signal', 'Concerns', 'Notable quotes', 'Recommendation'],
      builtin: true,
    },
  ];

  return {
    workspace: {
      id: 'ws-personal',
      name: 'Personal',
    },
    user: {
      id: 'user-youssef',
      name: 'Youssef Ayman',
      email: 'youssef@northwind.studio',
    },
    spaces: [
      {
        id: 'space-personal',
        kind: 'personal',
        name: 'My notes',
        icon: 'lock',
        description: 'Your private notes.',
      },
      {
        id: 'space-team',
        kind: 'team',
        name: 'Work',
        icon: 'team',
        description: 'Meetings, clients and projects.',
      },
    ],
    folders: [
      {
        id: 'folder-client',
        spaceId: 'space-team',
        parentId: null,
        name: 'Client work',
        icon: 'briefcase',
        description: 'Renewals, onboarding and customer conversations.',
      },
      {
        id: 'folder-acme',
        spaceId: 'space-team',
        parentId: 'folder-client',
        name: 'Acme',
        icon: 'circle',
        description: 'Everything about the Acme account.',
      },
      {
        id: 'folder-design',
        spaceId: 'space-team',
        parentId: null,
        name: 'Design',
        icon: 'pen',
        description: 'Crits, standups and product details.',
      },
      {
        id: 'folder-ones',
        spaceId: 'space-personal',
        parentId: null,
        name: '1:1s',
        icon: 'people',
        description: 'Private conversations with the team.',
      },
    ],
    notes: [standup, oneOnOne, acme, oldNote],
    templates,
    recipes: [
      {
        id: 'recipe-objections',
        name: 'Objections & risks',
        prompt:
          'List every objection, risk or unresolved concern raised, with who raised it and the exact wording. Then name what would defuse each one.',
        scope: 'single',
        model: 'auto',
      },
      {
        id: 'recipe-actions',
        name: 'Action items across the week',
        prompt:
          'Across these meetings, list every action item with an owner and a date. Group by owner. Flag anything with no owner.',
        scope: 'multiple',
        model: 'auto',
      },
      {
        id: 'recipe-recap',
        name: 'One-page client recap',
        prompt:
          'Write a one-page recap I can send to the client: what we agreed, what is still open, and what happens next. Plain, warm, no jargon.',
        scope: 'single',
        model: 'standard',
      },
    ],
    threads: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}
