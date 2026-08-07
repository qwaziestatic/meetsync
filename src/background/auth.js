/**
 * chrome.identity wrapper — the single auth entry point for the extension.
 *
 * Design notes:
 *  - chrome.identity.getAuthToken is itself the token cache. Chrome stores
 *    the OAuth access token per (client_id, scopes, profile) and refreshes it
 *    behind the scenes; we never see a refresh token and never persist tokens
 *    to chrome.storage (which would only widen the attack surface). The only
 *    state this module adds is in-flight de-duplication, and that state being
 *    wiped on a service-worker restart is harmless.
 *  - Scopes come from manifest.json's oauth2.scopes by default. We re-declare
 *    them here ONLY to validate grants: since Chrome's granular-permissions
 *    consent screen lets users untick individual scopes, a "successful" auth
 *    can still be missing e.g. Gmail. Callers must find that out here, at
 *    auth time, not as a confusing 403 three API calls deep.
 *
 * Known failure modes surfaced by getAuthToken (message substrings differ
 * slightly across Chrome versions, hence the loose matching below):
 *  - "OAuth2 not granted or revoked"  -> no prior consent; need interactive.
 *  - "The user did not approve access" / "The user turned off browser signin"
 *                                     -> user declined; do NOT auto-retry.
 *  - "The user is not signed in"      -> no Chrome profile Google account.
 *  - "bad client id" / "OAuth2 request failed"
 *                                     -> manifest client_id doesn't match the
 *                                        extension ID (see README: key field).
 */

/** Must mirror manifest.json oauth2.scopes — validated against grants below. */
export const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

/**
 * Reading document CONTENTS needs drive.readonly, which is strictly broader
 * than the metadata scope in the base set.
 *
 * INCREMENTAL, not baseline: this scope is deliberately absent from
 * manifest.json's oauth2.scopes and requested only via getAuthToken's
 * `scopes` override, which supersedes the manifest list. The consequence is
 * the one that matters — a user who never enables document reading is never
 * asked for it and never re-consents, so their privacy posture is exactly
 * what it was before this feature existed. Only opting in triggers the
 * (unavoidable) re-consent.
 *
 * NOTE for setup: the scope must also be listed on the Google Cloud consent
 * screen, or the interactive grant fails even though the manifest is fine.
 */
const DRIVE_CONTENT_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DOC_CONTENT_SETTING = 'readDocumentContents';

export const CONTENT_SCOPES = [...REQUIRED_SCOPES, DRIVE_CONTENT_SCOPE];

/**
 * The scope set this install currently needs. Read per call rather than
 * cached: the user can toggle document reading at any time, and a stale
 * cached scope list would either over-request or silently under-request.
 */
export async function activeScopes() {
  try {
    const stored = await chrome.storage.local.get(DOC_CONTENT_SETTING);
    return stored[DOC_CONTENT_SETTING] ? CONTENT_SCOPES : REQUIRED_SCOPES;
  } catch {
    return REQUIRED_SCOPES;
  }
}

/** Error subtype so callers can branch on auth failures vs network failures. */
export class AuthError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'consent_required'|'user_declined'|'not_signed_in'|'missing_scopes'|'config'|'unknown',
   *           missingScopes?: string[] }} details
   */
  constructor(message, { code, missingScopes = [] }) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.missingScopes = missingScopes;
  }
}

function classifyIdentityError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  if (msg.includes('not granted') || msg.includes('revoked')) return 'consent_required';
  if (msg.includes('did not approve') || msg.includes('rejected')) return 'user_declined';
  if (msg.includes('not signed in') || msg.includes('signin')) return 'not_signed_in';
  if (msg.includes('bad client id') || msg.includes('invalid')) return 'config';
  return 'unknown';
}

/** Raw promise wrapper. Resolves { token, grantedScopes }. */
async function requestToken(interactive, scopes) {
  // Promise form is safe: minimum_chrome_version 116 > identity promise support.
  // `scopes` overrides manifest.oauth2.scopes — the incremental-auth hook.
  const result = await chrome.identity.getAuthToken({ interactive, scopes });
  if (!result?.token) {
    // Interactive flows that are dismissed can resolve without a token
    // instead of rejecting — normalize to a rejection.
    throw new AuthError('getAuthToken returned no token', { code: 'user_declined' });
  }
  return { token: result.token, grantedScopes: result.grantedScopes ?? [] };
}

function assertScopes({ token, grantedScopes }, required) {
  // Chrome < 87 didn't report grantedScopes; if the list is empty we can't
  // verify and let API-level 403s surface instead. With a populated list,
  // fail fast and tell the caller exactly which consents are missing.
  if (grantedScopes.length > 0) {
    const missing = required.filter((s) => !grantedScopes.includes(s));
    if (missing.length > 0) {
      throw new AuthError(`User granted a partial scope set; missing: ${missing.join(', ')}`, {
        code: 'missing_scopes',
        missingScopes: missing,
      });
    }
  }
  return { token, grantedScopes };
}

// De-dup: if the panel and a future alarm both request auth at once, they
// share one getAuthToken call — critical for interactive mode, where parallel
// calls would stack multiple consent windows. Module state resets when the
// worker is killed, which is fine: it only guards concurrency, not identity.
let inflight = null;

/**
 * Get a valid access token for all three services.
 *
 * @param {{ interactive?: boolean }} opts
 *   interactive: false (default) — silent only; throws AuthError
 *     'consent_required' if the user has never consented. Use from background
 *     chains that must never pop UI.
 *   interactive: true — silent first, then fall back to the consent window
 *     ONLY for consent-shaped failures (never for explicit declines). Use
 *     from direct user actions in the panel ("Connect Google").
 * @returns {Promise<{ token: string, grantedScopes: string[] }>}
 */
export async function getToken({ interactive = false } = {}) {
  if (inflight) return inflight;

  inflight = (async () => {
    // Scope set depends on whether document reading is enabled. Enabling it
    // makes the previously-cached narrower grant insufficient, so the silent
    // request fails with consent_required and the panel shows "reconnect" —
    // which is exactly the intended surfacing of a scope escalation, not a
    // generic API error.
    const scopes = await activeScopes();
    try {
      return assertScopes(await requestToken(false, scopes), scopes);
    } catch (err) {
      const code = err instanceof AuthError ? err.code : classifyIdentityError(err);
      const canEscalate =
        interactive &&
        (code === 'consent_required' || code === 'unknown' || code === 'missing_scopes');
      if (!canEscalate) {
        throw err instanceof AuthError ? err : new AuthError(String(err?.message ?? err), { code });
      }
      try {
        return assertScopes(await requestToken(true, scopes), scopes);
      } catch (interactiveErr) {
        if (interactiveErr instanceof AuthError) throw interactiveErr;
        throw new AuthError(String(interactiveErr?.message ?? interactiveErr), {
          code: classifyIdentityError(interactiveErr),
        });
      }
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Drop a token from Chrome's cache. Called when a Google API answers 401:
 * the cached access token has expired or been revoked server-side, and
 * getAuthToken will keep handing us the same dead token until it's evicted.
 */
export async function invalidateToken(token) {
  if (!token) return;
  await chrome.identity.removeCachedAuthToken({ token });
}

/**
 * fetch() with Authorization header + one-shot 401 recovery.
 *
 * This is the stub every Phase 3 Google API call will go through. The retry
 * path is: 401 -> evict dead token -> SILENT getAuthToken (consent still
 * exists server-side, so Chrome mints a fresh token without UI) -> replay
 * once. A second 401 is returned to the caller — looping here could hammer
 * the API if the user has revoked access entirely.
 */
export async function fetchWithAuth(input, init = {}) {
  const doFetch = (token) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });

  const { token } = await getToken();
  let response = await doFetch(token);

  if (response.status === 401) {
    await invalidateToken(token);
    const { token: freshToken } = await getToken();
    response = await doFetch(freshToken);
  }

  return response;
}
