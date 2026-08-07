import { sanitizeEventHtml } from '../sanitize.js';

/**
 * Event description block.
 *
 * This is the ONLY dangerouslySetInnerHTML in the codebase, and its input is
 * exclusively calendar-description HTML that has passed the DOMPurify
 * allowlist in sanitize.js. LLM output never reaches this component — model
 * text renders through plain JSX text nodes everywhere (React escaping is
 * that boundary). Keep it that way: adding another rich-render path means
 * re-doing the Phase 4 injection review.
 */
export default function Description({ text }) {
  if (!text) return null;

  // Plenty of invites carry plain text with newlines rather than HTML —
  // sanitized-HTML rendering would collapse those, so branch on shape.
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(text);
  if (!looksLikeHtml) {
    return <p className="event__description">{text}</p>;
  }
  return (
    <div
      className="event__description event__description--rich"
      dangerouslySetInnerHTML={{ __html: sanitizeEventHtml(text) }}
    />
  );
}
