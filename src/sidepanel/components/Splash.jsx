import { useEffect, useRef, useState } from 'react';
import { LOCAL_KEYS, STORAGE_KEYS } from '../../shared/messages.js';

/**
 * Branded splash OVERLAY.
 *
 * Three properties matter more than the animation, and they shape the design:
 *
 *  1. IT IS NOT A GATE. This renders on top of an already-mounted, already-
 *     initialising panel. App's data effects run regardless of splash state,
 *     so dismissing early reveals a ready panel rather than a spinner. The
 *     splash never awaits anything and nothing awaits the splash.
 *  2. IT IS ALWAYS SKIPPABLE. Any click or key dismisses it. It is also
 *     inert to assistive tech (aria-hidden + pointer-driven) so it cannot
 *     trap focus — the panel behind it is the real UI.
 *  3. IT COSTS TIME ONLY ONCE PER SESSION. Full presentation on the first
 *     open per browser session; a brief fade on every subsequent open. The
 *     marker lives in chrome.storage.session, which Chrome clears when the
 *     browser closes — so "once per session" needs no expiry logic of ours.
 *
 * Asset note: the logo mark is an <img> when public/assets/logo.png exists
 * and a CSS-drawn ring otherwise, so the splash is correct before any asset
 * is supplied. The wordmark and tagline are LIVE TEXT, never baked into a
 * raster — the side panel's width is user-draggable, and text reflows and
 * stays crisp at any DPI where a fixed-width image would not.
 */

const FULL_MS = 6000;
const BRIEF_MS = 800;
const FADE_MS = 320;

export default function Splash() {
  // 'checking' until storage answers — never flash a splash at a user who
  // disabled it, and never skip the fade-in by rendering the final state.
  const [phase, setPhase] = useState('checking');
  const [leaving, setLeaving] = useState(false);
  const timers = useRef([]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get(LOCAL_KEYS.SPLASH_DISABLED),
        chrome.storage.session.get(STORAGE_KEYS.SPLASH_SHOWN),
      ]);
      if (cancelled) return;

      if (local[LOCAL_KEYS.SPLASH_DISABLED]) {
        setPhase('done');
        return;
      }

      const seenThisSession = Boolean(session[STORAGE_KEYS.SPLASH_SHOWN]);
      const duration = seenThisSession ? BRIEF_MS : FULL_MS;
      setPhase(seenThisSession ? 'brief' : 'full');
      if (!seenThisSession) {
        chrome.storage.session.set({ [STORAGE_KEYS.SPLASH_SHOWN]: true }).catch(() => {});
      }
      timers.current.push(setTimeout(dismiss, duration));
    })().catch(() => setPhase('done'));

    return () => {
      cancelled = true;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  function dismiss() {
    setLeaving(true);
    timers.current.push(setTimeout(() => setPhase('done'), FADE_MS));
  }

  // Any interaction anywhere dismisses. Listeners are attached while visible
  // only, and always cleaned up.
  useEffect(() => {
    if (phase === 'checking' || phase === 'done') return undefined;
    const skip = () => dismiss();
    window.addEventListener('pointerdown', skip, { once: true });
    window.addEventListener('keydown', skip, { once: true });
    return () => {
      window.removeEventListener('pointerdown', skip);
      window.removeEventListener('keydown', skip);
    };
  }, [phase]);

  if (phase === 'checking' || phase === 'done') return null;

  return (
    <div
      className={`splash splash--${phase}${leaving ? ' splash--leaving' : ''}`}
      // Decorative overlay: the panel behind it is the accessible UI, and a
      // screen-reader user should never have to dismiss branding.
      aria-hidden="true"
      onClick={dismiss}
    >
      <div className="splash__mark">
        {/* Falls back to the CSS ring if the asset isn't present. */}
        <img
          src="assets/logo.png"
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      </div>
      <div className="splash__word">MeetSync</div>
      <div className="splash__tag">All-in-One Pre-Meeting Workspace</div>
      <div className="splash__bar">
        <div
          className="splash__bar-fill"
          style={{ animationDuration: `${phase === 'full' ? FULL_MS : BRIEF_MS}ms` }}
        />
      </div>
      <div className="splash__skip">click to skip</div>
    </div>
  );
}
