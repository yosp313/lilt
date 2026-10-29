import { desktopCapturer } from 'electron';
import { isMeetingWindowTitle, pickActiveMeeting } from '@/shared/logic';
import type { CalendarEvent } from '@/shared/types';

export async function detectActiveMeeting(
  calendarEvents: CalendarEvent[],
): Promise<CalendarEvent | null> {
  const current = pickActiveMeeting(calendarEvents);
  if (current) return current;

  // Fallback: Window enumeration for ad-hoc calls. These are banners only;
  // the renderer never auto-starts recording for them.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
    });

    for (const source of sources) {
      if (isMeetingWindowTitle(source.name)) {
        const now = Date.now();
        return {
          title: source.name,
          start: new Date(now).toISOString(),
          end: new Date(now + 60 * 60_000).toISOString(),
          meetingUrl: undefined,
          attendees: [],
          agenda: `Detected via window: ${source.name}`,
        };
      }
    }
  } catch (error) {
    console.warn('Window enumeration failed:', error);
  }

  return null;
}

export function startMeetingPolling(
  getCalendarEvents: () => Promise<CalendarEvent[]>,
  onDetected: (event: CalendarEvent) => void,
  intervalMs = 30_000,
): () => void {
  let lastDetectedId: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const poll = async () => {
    try {
      // A calendar failure must not disable window-based detection.
      const events = await getCalendarEvents().catch(() => []);
      const detected = await detectActiveMeeting(events);
      if (detected) {
        // Synthetic window events have a new start on every poll.
        const eventKey =
          detected.id ??
          (detected.meetingUrl
            ? `${detected.title}@${detected.start}`
            : detected.title);
        if (eventKey !== lastDetectedId) {
          lastDetectedId = eventKey;
          onDetected(detected);
        }
      } else {
        lastDetectedId = null;
      }
    } catch (error) {
      console.error('Meeting detection poll error:', error);
    }
  };

  timer = setInterval(poll, intervalMs);
  // Initial poll
  void poll();

  return () => {
    if (timer) clearInterval(timer);
  };
}
