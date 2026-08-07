/**
 * HTML sanitizer for calendar event descriptions — the ONLY place in the
 * codebase where third-party HTML is rendered rich. LLM output never flows
 * through here (it renders as plain text via React's default escaping).
 *
 * Threat model: an event description is authored by whoever sent the invite
 * — i.e. arbitrary internet strangers. Google renders it as HTML, so users
 * expect formatting and links to survive; we allow exactly that and nothing
 * else.
 *
 * Bundle-cost justification: DOMPurify is ~9 kB gzipped and loads in the
 * PANEL bundle only. Unlike the worker (which cold-starts on every event and
 * re-parses its whole bundle each time — the reason we skipped the Anthropic
 * SDK there), the panel is a long-lived page loaded by an explicit user
 * action; +9 kB there is a rounding error against React's 60 kB, and
 * hand-rolling an HTML sanitizer is the classic way to ship an XSS.
 */

import DOMPurify from 'dompurify';

// Tight allowlist: basic text formatting + links. Deliberately absent:
// images (tracking pixels / mixed-content), styles (clickjacking overlay
// tricks), tables/iframes/media (no briefing-card use case worth the
// surface). Unknown tags are dropped but their TEXT is kept, so exotic
// invites degrade to readable plain text rather than vanishing.
const CONFIG = {
  ALLOWED_TAGS: ['a', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'span', 'br', 'ul', 'ol', 'li'],
  ALLOWED_ATTR: ['href'],
  // Only http(s) survives on href — kills javascript:, data:, vbscript:, and
  // also mailto:/tel: (fine for a briefing; they were popup vectors in some
  // handlers and add nothing here).
  ALLOWED_URI_REGEXP: /^https?:/i,
};

// Every surviving link opens in a new tab without opener access, and can't
// leak the panel's URL via Referer.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function sanitizeEventHtml(html) {
  return DOMPurify.sanitize(html, CONFIG);
}
