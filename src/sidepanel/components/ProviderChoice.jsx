import { PROVIDERS } from '../../shared/messages.js';

/**
 * Stacked, full-width selectable provider blocks. Used in BOTH places the
 * choice appears (Settings and the first-run key form) so the two can't drift.
 *
 * Accessibility decisions:
 *  - Real radio inputs, visually hidden but focusable, inside <label> cards.
 *    Keeping native inputs means Tab reaches the group, arrow keys move
 *    within it, and Space/Enter select — all for free, and correctly, which
 *    a div+role reimplementation reliably gets wrong. `aria-checked` and
 *    grouping semantics come from the radios themselves; the visible card is
 *    just styling driven by :checked.
 *  - The whole card is the click target because the <label> wraps everything.
 *  - Selected state is signalled THREE ways — border, background, and an
 *    explicit ✓ affordance — never colour alone, which is invisible to
 *    colour-blind users and in forced-colours mode.
 *  - :focus-visible ring is drawn on the card via :has(:focus-visible), so
 *    the hidden input still produces a visible focus indicator.
 */
export default function ProviderChoice({ value, onChange, name = 'provider', keyed = {} }) {
  return (
    <div className="provider-choice">
      {Object.values(PROVIDERS).map((p) => {
        const selected = value === p.id;
        const hasFreeTier = p.models.some((m) => m.freeTier);
        return (
          <label className={`provider-card${selected ? ' provider-card--on' : ''}`} key={p.id}>
            <input
              className="provider-card__input"
              type="radio"
              name={name}
              value={p.id}
              checked={selected}
              onChange={() => onChange(p.id)}
            />
            <span className="provider-card__check" aria-hidden="true">
              {selected ? '✓' : ''}
            </span>
            <span className="provider-card__name">{p.label}</span>
            <span className="provider-card__desc">{p.descriptor}</span>
            <span className="provider-card__tags">
              {hasFreeTier && <span className="settings__badge">free tier available</span>}
              {keyed[p.keyStorageKey] ? (
                <span className="settings__badge">key saved</span>
              ) : (
                <span className="settings__badge settings__badge--muted">no key</span>
              )}
            </span>
            {/* The data-use warning stays INSIDE the block it applies to, and
                only when that block is selected — the restyle must not bury
                it, and it is the one thing a user must read before choosing
                the free tier. */}
            {selected && p.freeTierWarning && (
              <span className="provider-card__warning">{p.freeTierWarning}</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
