/**
 * Briefing pipeline orchestrator: emails -> docs -> synthesize -> resolve.
 *
 * MV3 resumability design (unchanged from Phase 3): each step checkpoints
 * into chrome.storage.session before running; a 'running' checkpoint
 * untouched for STALE_AFTER_MS is a dead run and gets re-driven from its
 * last completed step by resumeStaleBriefing (demand-driven — nothing can
 * run while the worker is dead anyway). Retries after fixing auth/key skip
 * straight to the failed step.
 *
 * Phase 4 addition — buildCard() is the SECURITY BOUNDARY for LLM output:
 * the model only returns integer indexes + free text; this module resolves
 * indexes against the API-sourced arrays it owns, bounds-checking every one.
 * Every URL and identity on the stored card provably originated from a
 * Google API response, never from the model.
 */

import { AuthError } from './auth.js';
import { getLatestThreadWith, findRecentDocs, getDocumentText, textStrategyFor } from './googleApi.js';
import { synthesizeBriefing, LlmError } from './llm.js';
import { STORAGE_KEYS, LOCAL_KEYS } from '../shared/messages.js';

const STEPS = ['emails', 'docs', 'docContents', 'synthesize'];
const order = (step) => STEPS.indexOf(step);

const STALE_AFTER_MS = 60_000;
const MAX_CONTEXT_ATTENDEES = 12; // rows on the card / entries in the prompt
const MAX_EMAIL_ATTENDEES = 8; // latency cap: 2 Gmail calls per attendee
const MAX_DOC_ATTENDEES = 5; // Drive q-string length cap
const MAX_TITLE_TERMS = 4;

/**
 * Document-content budget (opt-in feature). Defaults chosen so a briefing
 * stays fast and cheap: 3 documents at ~6k characters each is roughly
 * 4–5k tokens of document text — meaningful context, still a small fraction
 * of the prompt budget, and bounded regardless of how large the files are.
 */
const MAX_DOCS_WITH_CONTENT = 3;
const MAX_CHARS_PER_DOC = 6000;
const MAX_TOTAL_DOC_CHARS = 15000;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'with', 'on', 'in', 'at',
  'meeting', 'call', 'sync', 'chat', 'catch', 'catchup', 'weekly', 'monthly',
  'daily', 'standup', 'review', 're', 'fwd',
]);

async function writeBriefing(briefing) {
  await chrome.storage.session.set({
    [STORAGE_KEYS.BRIEFING]: { ...briefing, updatedAt: Date.now() },
  });
  return briefing;
}

function otherHumans(event) {
  return event.attendees.filter(
    (a) => a.email && !a.self && !a.email.endsWith('resource.calendar.google.com'),
  );
}

/**
 * THE canonical attendee list for one briefing. The prompt's attendee
 * indexes, buildCard's resolution, and the rendered rows must all come from
 * this one function — index integrity across prompt->output->card depends
 * on everyone slicing the same array the same way.
 */
function briefingAttendees(event) {
  return otherHumans(event).slice(0, MAX_CONTEXT_ATTENDEES);
}

function titleTerms(summary) {
  const words = (summary ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, MAX_TITLE_TERMS);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Parallel latest-thread lookups. allSettled so one flaky query can't sink
 * the run — but per-attendee failures are RECORDED, not swallowed: the card
 * marks those attendees degraded instead of implying "no email history".
 * Auth failures fail every call identically, so they propagate to needs-auth.
 */
async function collectEmails(event) {
  const targets = briefingAttendees(event).slice(0, MAX_EMAIL_ATTENDEES);
  const settled = await Promise.allSettled(targets.map((a) => getLatestThreadWith(a.email)));

  const authFailure = settled.find(
    (r) => r.status === 'rejected' && r.reason instanceof AuthError,
  );
  if (authFailure) throw authFailure.reason;

  const threads = [];
  const failedFor = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      if (r.value) threads.push({ ...r.value, displayName: targets[i].displayName });
    } else {
      failedFor.push(targets[i].email);
    }
  });
  return { threads, failedFor };
}

async function collectDocs(event) {
  return findRecentDocs({
    titleTerms: titleTerms(event.summary),
    attendeeEmails: briefingAttendees(event)
      .slice(0, MAX_DOC_ATTENDEES)
      .map((a) => a.email),
  });
}

/**
 * Fetch text for the top few documents — OPT-IN ONLY.
 *
 * Returns a per-document record keyed by index into `documents`, so the
 * indexes the model sees are unchanged whether or not contents were read.
 *
 * Parallel + allSettled, matching the Gmail fan-out: one failed export (a
 * file shared without download rights, a transient 5xx) must not sink the
 * briefing. Failures and unsupported types are RECORDED, not swallowed, so
 * the card can say "content not read" instead of implying the document was
 * empty or irrelevant.
 */
async function collectDocContents(documents) {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.DOC_CONTENT);
  if (!stored[LOCAL_KEYS.DOC_CONTENT]) return { enabled: false, byIndex: {} };

  const targets = documents.slice(0, MAX_DOCS_WITH_CONTENT);
  const settled = await Promise.allSettled(
    targets.map((file) => getDocumentText(file, MAX_CHARS_PER_DOC)),
  );

  // Auth failures fail every call identically — propagate so the run lands in
  // needs-auth ("reconnect your account") rather than reporting every
  // document as unreadable. This is the path a scope escalation takes.
  const authFailure = settled.find((r) => r.status === 'rejected' && r.reason instanceof AuthError);
  if (authFailure) throw authFailure.reason;

  const byIndex = {};
  let budget = MAX_TOTAL_DOC_CHARS;

  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      byIndex[i] = { status: 'error' };
      return;
    }
    if (result.value === null) {
      // No text strategy for this MIME type (PDF, image, video, archive).
      byIndex[i] = { status: 'unsupported' };
      return;
    }
    let { text, truncated } = result.value;
    // Aggregate cap, applied in document order so truncation is deterministic
    // and reproducible rather than dependent on which fetch resolved first.
    if (text.length > budget) {
      text = text.slice(0, budget);
      truncated = true;
    }
    budget -= text.length;
    byIndex[i] = { status: 'ok', text, truncated };
  });

  return { enabled: true, byIndex };
}

// ---------------------------------------------------------------------------
// Resolution — LLM output security boundary
// ---------------------------------------------------------------------------

/**
 * Resolve index-based model output into the renderable card. Bounds-check +
 * dedupe every index; anything invalid is silently dropped (a hostile or
 * confused model degrades the card, it can't inject into it). All URLs and
 * identities come from the API-sourced arrays held HERE — model strings only
 * ever land in fields the panel renders as plain text (summary, relevance,
 * agenda items), length-capped so a runaway generation can't bloat storage.
 */
function buildCard(event, { threads, failedFor }, documents, modelOut, docContents) {
  const attendees = briefingAttendees(event);
  const threadByEmail = new Map(threads.map((t) => [t.email, t]));
  const failed = new Set(failedFor);

  const summaries = new Map();
  for (const entry of modelOut.attendee_context ?? []) {
    const i = entry?.attendee_index;
    if (
      Number.isInteger(i) && i >= 0 && i < attendees.length &&
      typeof entry.last_communication === 'string' && !summaries.has(i)
    ) {
      summaries.set(i, entry.last_communication.slice(0, 600));
    }
  }

  const cardAttendees = attendees.map((a, i) => {
    const thread = threadByEmail.get(a.email);
    return {
      email: a.email,
      name: a.displayName || '',
      responseStatus: a.responseStatus || '',
      summary: summaries.get(i) ?? null,
      lastSubject: thread?.subject ?? null,
      lastDate: thread?.date ?? null,
      degraded: failed.has(a.email),
    };
  });

  const seen = new Set();
  const cardDocuments = [];
  for (const entry of modelOut.document_links ?? []) {
    const i = entry?.doc_index;
    if (!Number.isInteger(i) || i < 0 || i >= documents.length || seen.has(i)) continue;
    seen.add(i);
    const d = documents[i];
    const contentRecord = docContents?.byIndex?.[i];
    cardDocuments.push({
      name: d.name ?? '(untitled)',
      url: d.webViewLink ?? '', // API-sourced — the model never saw this URL
      mimeType: d.mimeType ?? '',
      modifiedTime: d.modifiedTime ?? '',
      relevance: typeof entry.relevance === 'string' ? entry.relevance.slice(0, 300) : '',
      // Model prose, length-capped like every other model string and rendered
      // as escaped text by the card.
      keyPoints: typeof entry.key_points === 'string' ? entry.key_points.slice(0, 400) : '',
      // API-sourced fact, NOT model-reported: whether we actually read the
      // file. Keeping this out of the model's hands means it can't claim to
      // have read something it didn't.
      contentStatus: contentRecord?.status ?? (docContents?.enabled ? 'not_fetched' : 'off'),
      truncated: Boolean(contentRecord?.truncated),
    });
  }

  return {
    agenda: (modelOut.core_agenda ?? [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => s.slice(0, 400))
      .slice(0, 12),
    attendees: cardAttendees,
    documents: cardDocuments,
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function startingPoint(checkpoint, eventId) {
  if (!checkpoint || checkpoint.eventId !== eventId) return { step: 'emails', data: {} };
  const data = checkpoint.data ?? {};
  if (data.emails && data.documents && data.docContents) return { step: 'synthesize', data };
  if (data.emails && data.documents) return { step: 'docContents', data };
  if (data.emails) return { step: 'docs', data };
  return { step: 'emails', data: {} };
}

let inflight = null;

/** @param {{auto?: boolean}} opts auto: triggered by the panel's staleness
 *  check rather than a click — surfaces as the "refreshed" badge. */
export async function runBriefing({ auto = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const stored = await chrome.storage.session.get([
      STORAGE_KEYS.EVENT_CONTEXT,
      STORAGE_KEYS.BRIEFING,
    ]);
    const context = stored[STORAGE_KEYS.EVENT_CONTEXT];
    if (context?.status !== 'ready') {
      throw new Error('No resolved event to brief on — click a calendar event first.');
    }
    const event = context.event;
    const { step, data } = startingPoint(stored[STORAGE_KEYS.BRIEFING], event.id);

    try {
      if (order(step) <= order('emails')) {
        await writeBriefing({ status: 'running', step: 'emails', eventId: event.id, data });
        data.emails = await collectEmails(event);
      }
      if (order(step) <= order('docs')) {
        await writeBriefing({ status: 'running', step: 'docs', eventId: event.id, data });
        data.documents = await collectDocs(event);
      }
      if (order(step) <= order('docContents')) {
        await writeBriefing({ status: 'running', step: 'docContents', eventId: event.id, data });
        data.docContents = await collectDocContents(data.documents);
      }
      await writeBriefing({ status: 'running', step: 'synthesize', eventId: event.id, data });
      const modelOut = await synthesizeBriefing({
        event,
        attendees: briefingAttendees(event),
        threads: data.emails.threads,
        failedFor: data.emails.failedFor,
        documents: data.documents,
        docContents: data.docContents,
      });
      return writeBriefing({
        status: 'ready',
        eventId: event.id,
        data,
        card: buildCard(event, data.emails, data.documents, modelOut, data.docContents),
        generatedAt: Date.now(),
        auto,
      });
    } catch (err) {
      // Failure states KEEP checkpoint data so the retry resumes at the
      // failed step instead of re-querying Gmail/Drive.
      if (err instanceof AuthError) {
        return writeBriefing({
          status: 'needs-auth', eventId: event.id, data, authCode: err.code,
        });
      }
      if (err instanceof LlmError && (err.code === 'missing_key' || err.code === 'bad_key')) {
        return writeBriefing({
          status: 'needs-key', eventId: event.id, data,
          // Which provider needs a key — the panel reuses ONE key form,
          // parameterized by this, rather than a second prompt flow.
          provider: err.provider,
          message: err.code === 'bad_key' ? err.message : '',
        });
      }
      console.warn('[mpf] briefing failed:', err);
      return writeBriefing({
        status: 'error', eventId: event.id, data,
        message: String(err?.message ?? err),
        // Lets the panel distinguish a rate limit or safety block from a
        // generic failure. Retry still resumes at 'synthesize' — the Gmail
        // and Drive results in `data` are untouched, so a rate-limit retry
        // costs one API call, not the whole pipeline.
        llmCode: err instanceof LlmError ? err.code : undefined,
      });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function resumeStaleBriefing(briefing) {
  if (
    briefing?.status === 'running' &&
    Date.now() - (briefing.updatedAt ?? 0) > STALE_AFTER_MS &&
    !inflight
  ) {
    return runBriefing();
  }
  return null;
}
