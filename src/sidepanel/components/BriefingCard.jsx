import { formatTimestamp, formatDay } from '../format.js';

/**
 * The synthesized briefing card. Trust provenance of every rendered field:
 *  - URLs (document links): API-sourced, resolved worker-side by index —
 *    the model never produced them.
 *  - Names/emails/RSVP/dates: API-sourced.
 *  - agenda items, summaries, relevance notes: MODEL TEXT — rendered
 *    exclusively as JSX text nodes (React-escaped). Never innerHTML.
 */
export default function BriefingCard({ card, generatedAt, auto, onRegenerate }) {
  return (
    <div className="card">
      <AgendaSection items={card.agenda} />
      <AttendeesSection attendees={card.attendees} />
      <DocumentsSection documents={card.documents} />

      <footer className="card__footer">
        <span className="card__meta">
          Generated {formatTimestamp(generatedAt)}
          {auto && <span className="card__badge">refreshed</span>}
        </span>
        <button className="btn btn--ghost" onClick={onRegenerate}>
          Regenerate
        </button>
      </footer>
    </div>
  );
}

function AgendaSection({ items }) {
  return (
    <section>
      <h3 className="card__heading">Core agenda</h3>
      {items.length > 0 ? (
        <ul className="card__agenda">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="card__none">No agenda could be derived from the invite or recent email.</p>
      )}
    </section>
  );
}

const RSVP_LABELS = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'maybe',
  needsAction: 'no reply',
};

function AttendeesSection({ attendees }) {
  return (
    <section>
      <h3 className="card__heading">Attendees</h3>
      {attendees.length === 0 && <p className="card__none">Just you.</p>}
      {attendees.map((a) => (
        <div className="person" key={a.email}>
          <div className="person__head">
            <span
              className={`event__rsvp event__rsvp--${a.responseStatus || 'unknown'}`}
              title={RSVP_LABELS[a.responseStatus] ?? ''}
            />
            <span className="person__name">{a.name || a.email}</span>
            {a.lastDate && <span className="person__date">{formatDay(a.lastDate)}</span>}
          </div>
          {a.degraded ? (
            // Honest degradation: this attendee's Gmail query failed in the
            // fan-out, which is different from "no email exists".
            <p className="person__summary person__summary--degraded">
              Couldn't check email history for this attendee.
            </p>
          ) : a.summary ? (
            <p className="person__summary">{a.summary}</p>
          ) : (
            <p className="person__summary card__none">No recent email with this attendee.</p>
          )}
        </div>
      ))}
    </section>
  );
}

// Glyphs, not remote icons: no network fetch, no icon-set dependency.
const MIME_ICONS = [
  ['vnd.google-apps.document', '📝'],
  ['vnd.google-apps.spreadsheet', '📊'],
  ['vnd.google-apps.presentation', '📽️'],
  ['vnd.google-apps.folder', '📁'],
  ['pdf', '📕'],
];

function mimeIcon(mimeType) {
  return MIME_ICONS.find(([needle]) => mimeType?.includes(needle))?.[1] ?? '📄';
}

/**
 * Says whether we actually read the file. Sourced from the pipeline, never
 * from the model — so a document can't be described as "read" because the
 * model said so. 'off' and 'ok' render nothing: the common cases stay quiet.
 */
function ContentNote({ status, truncated }) {
  if (status === 'ok') {
    return truncated ? <span className="doc__note">Summarised from the first part only</span> : null;
  }
  const text = {
    unsupported: "Content not read — this file type isn't supported",
    error: "Content couldn't be read",
    not_fetched: 'Content not read (document limit reached)',
  }[status];
  return text ? <span className="doc__note">{text}</span> : null;
}

function DocumentsSection({ documents }) {
  return (
    <section>
      <h3 className="card__heading">Documents</h3>
      {documents.length === 0 && (
        <p className="card__none">No relevant documents found in Drive.</p>
      )}
      {documents.map((d) => (
        <div className="doc" key={d.url || d.name}>
          <span className="doc__icon" aria-hidden="true">{mimeIcon(d.mimeType)}</span>
          <div className="doc__body">
            {d.url ? (
              <a href={d.url} target="_blank" rel="noopener noreferrer">
                {d.name}
              </a>
            ) : (
              <span>{d.name}</span>
            )}
            <span className="doc__meta">
              {d.modifiedTime && `Modified ${formatDay(d.modifiedTime)}`}
              {d.relevance && ` · ${d.relevance}`}
            </span>
            {/* Model prose — plain JSX text node, React-escaped, like every
                other model output. Kept to a couple of lines: the card's
                value is scannability, not completeness. */}
            {d.keyPoints && <span className="doc__points">{d.keyPoints}</span>}
            <ContentNote status={d.contentStatus} truncated={d.truncated} />
          </div>
        </div>
      ))}
    </section>
  );
}
