/**
 * Loading skeleton mirroring the card layout (agenda lines, attendee rows,
 * document rows), with the per-step progress text streamed from the worker.
 * aria-busy + a live status line keep it honest for screen readers.
 */
const STEP_LABELS = {
  emails: 'Scanning recent email…',
  docs: 'Searching Drive…',
  docContents: 'Reading documents…',
  synthesize: 'Synthesizing briefing…',
};

export default function BriefingSkeleton({ step }) {
  return (
    <div className="card" aria-busy="true">
      <p className="pipeline__status" role="status">
        {STEP_LABELS[step] ?? 'Working…'}
      </p>

      <h3 className="card__heading">Core agenda</h3>
      <div className="skel skel--line" style={{ width: '85%' }} />
      <div className="skel skel--line" style={{ width: '70%' }} />
      <div className="skel skel--line" style={{ width: '55%' }} />

      <h3 className="card__heading">Attendees</h3>
      {[0, 1].map((i) => (
        <div className="skel-row" key={i}>
          <div className="skel skel--dot" />
          <div style={{ flex: 1 }}>
            <div className="skel skel--line" style={{ width: '40%' }} />
            <div className="skel skel--line" style={{ width: '90%' }} />
          </div>
        </div>
      ))}

      <h3 className="card__heading">Documents</h3>
      <div className="skel skel--line" style={{ width: '65%' }} />
      <div className="skel skel--line" style={{ width: '50%' }} />
    </div>
  );
}
