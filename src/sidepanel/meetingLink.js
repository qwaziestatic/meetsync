/**
 * Meeting-URL detection for the Join button. Host ALLOWLIST, not heuristics:
 * a Join button is the most clickable pixel on the card, so only URLs whose
 * host provably belongs to a known conferencing provider may become one.
 * https-only, same rel rules as every other external link.
 *
 * Sources scanned, most-authoritative first: hangoutLink (Meet, API-vended),
 * conferenceData video entry point (Zoom/Teams add-ons), then free-text
 * location and description (regex-extracted candidates, each re-validated
 * through the same allowlist — raw text never becomes an href).
 */

const PROVIDERS = [
  { label: 'Meet', match: (h) => h === 'meet.google.com' },
  // Zoom uses per-tenant subdomains (us02web.zoom.us, company.zoom.us).
  { label: 'Zoom', match: (h) => h === 'zoom.us' || h.endsWith('.zoom.us') },
  { label: 'Teams', match: (h) => h === 'teams.microsoft.com' || h === 'teams.live.com' },
];

function validate(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const provider = PROVIDERS.find((p) => p.match(url.hostname.toLowerCase()));
  return provider ? { url: url.href, provider: provider.label } : null;
}

function extractUrls(text) {
  return text?.match(/https?:\/\/[^\s"'<>()]+/g) ?? [];
}

/** @returns {{url: string, provider: string} | null} */
export function findMeetingLink(event) {
  const candidates = [
    event.hangoutLink,
    event.conferenceLink,
    ...extractUrls(event.location),
    ...extractUrls(event.description),
  ].filter(Boolean);

  for (const raw of candidates) {
    const hit = validate(raw);
    if (hit) return hit;
  }
  return null;
}
