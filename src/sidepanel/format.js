/** Date/time formatting helpers shared by the panel components. */

/** Event start/end -> "Mon, Jul 20, 2:00 PM – 2:30 PM" (all-day: date only). */
export function formatWhen(start, end) {
  if (start?.date) {
    return start.date === end?.date ? start.date : `${start.date} – ${end?.date ?? ''}`;
  }
  if (!start?.dateTime) return '';
  const s = new Date(start.dateTime);
  const e = end?.dateTime ? new Date(end.dateTime) : null;
  const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const t = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return e ? `${day}, ${t(s)} – ${t(e)}` : `${day}, ${t(s)}`;
}

/** ms epoch or parseable string -> "Jul 20, 2:04 PM" (year added if not current). */
export function formatTimestamp(value) {
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** RFC2822/ISO string -> "Jul 12" / "Dec 3, 2025". Falls back to raw text. */
export function formatDay(value) {
  if (!value) return '';
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
