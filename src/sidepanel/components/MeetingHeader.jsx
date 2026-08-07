import { useEffect, useState } from 'react';
import { findMeetingLink } from '../meetingLink.js';
import { formatWhen } from '../format.js';

/** Card header: title, time, live countdown, allowlist-validated Join button. */
export default function MeetingHeader({ event }) {
  const link = findMeetingLink(event);
  const countdown = useCountdown(event.start);

  // Don't echo the location line when it's just the join URL again.
  const showLocation = event.location && !(link && event.location.includes(link.url));

  return (
    <header className="meeting">
      <div className="meeting__row">
        <h2 className="meeting__title">{event.summary}</h2>
        {link && (
          <a className="btn meeting__join" href={link.url} target="_blank" rel="noopener noreferrer">
            Join {link.provider}
          </a>
        )}
      </div>
      <p className="meeting__when">
        {formatWhen(event.start, event.end)}
        {countdown && (
          <span className={countdown.urgent ? 'meeting__countdown meeting__countdown--urgent' : 'meeting__countdown'}>
            {' · '}{countdown.label}
          </span>
        )}
      </p>
      {showLocation && <p className="meeting__loc">{event.location}</p>}
    </header>
  );
}

/**
 * 30s tick is plenty for minute-granularity text and cheap enough to run for
 * the panel's whole lifetime. Only render-driving state; no side effects.
 */
function useCountdown(start) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const startMs = start?.dateTime ? Date.parse(start.dateTime) : NaN;
  if (Number.isNaN(startMs)) return null; // all-day events get no countdown

  const diffMin = Math.round((startMs - Date.now()) / 60_000);
  if (diffMin > 24 * 60 || diffMin < -60) return null; // too far out / long over
  if (diffMin > 60) return { label: `in ${Math.floor(diffMin / 60)} h ${diffMin % 60} min`, urgent: false };
  if (diffMin >= 1) return { label: `in ${diffMin} min`, urgent: diffMin <= 15 };
  if (diffMin === 0) return { label: 'starting now', urgent: true };
  return { label: `started ${-diffMin} min ago`, urgent: true };
}
