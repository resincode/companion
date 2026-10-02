import { reviewMeetingJargon, type AIClient } from '@meetcc/ai';
import {
  effectiveClean,
  isJargonEvidenceValid,
  isLive,
  jargonItemId,
  jargonOccurrenceKey,
  normalizeJargonPhrase,
  withEntryIds,
  type CleanRecord,
  type JargonEvidence,
  type Meeting,
  type MeetingJargonItem,
  type MeetingJargonReview,
  type MiniContext,
} from '@meetcc/shared';
import { t } from '@meetcc/shared/i18n';
import { STALE_PROCESSING_MS } from './detect';
import { createInFlight } from './inflight';

export interface JargonReviewDeps {
  getMeeting(id: string): Promise<Meeting | null>;
  getClean(id: string): Promise<CleanRecord | null>;
  getRegistry(): Promise<MiniContext[]>;
  getReview(id: string): Promise<MeetingJargonReview | null>;
  saveReview(id: string, review: MeetingJargonReview): Promise<void>;
  saveRegistry(contexts: MiniContext[]): Promise<void>;
  createClient(): Promise<AIClient>;
  now(): string;
}

export type JargonReviewAction =
  | { type: 'confirm'; item: MeetingJargonItem }
  | { type: 'dismiss'; itemId: string }
  | { type: 'remove'; itemId: string }
  | { type: 'register'; itemId: string };

export type JargonReviewResult =
  | { ok: true }
  | { ok: false; error: string; existingMiniContextId?: string };

const scans = createInFlight<JargonReviewResult>();
const writes = new Map<string, Promise<unknown>>();
const REGISTRY_QUEUE = 'registry';

// A promise chain queues distinct actions rather than joining their results.
function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  writes.set(key, settled);
  void settled.then(() => {
    if (writes.get(key) === settled) writes.delete(key);
  });
  return result;
}

class ReviewError extends Error {
  constructor(message: string, readonly existingMiniContextId?: string) {
    super(message);
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown, kind: 'storageFailed' | 'reviewFailed' = 'storageFailed'): JargonReviewResult {
  if (error instanceof ReviewError) {
    return {
      ok: false,
      error: error.message,
      ...(error.existingMiniContextId ? { existingMiniContextId: error.existingMiniContextId } : {}),
    };
  }
  return {
    ok: false,
    error: kind === 'reviewFailed'
      ? t('pkg.jargon.reviewFailed', { detail: detail(error) })
      : t('pkg.jargon.storageFailed', { detail: detail(error) }),
  };
}

function meetingQueue(id: string): string {
  return `meeting:${id}`;
}

async function requireMeeting(id: string, deps: JargonReviewDeps): Promise<Meeting> {
  const meeting = await deps.getMeeting(id);
  if (!meeting) throw new ReviewError(t('pkg.jargon.notFound'));
  if (!meeting.entries.some((entry) => entry.text.trim())) throw new ReviewError(t('pkg.jargon.empty'));
  if (isLive(meeting, Date.parse(deps.now()))) throw new ReviewError(t('pkg.jargon.live'));
  return meeting;
}

async function saveExisting(id: string, review: MeetingJargonReview, deps: JargonReviewDeps): Promise<void> {
  // In particular, a provider response after clearMeeting must not recreate a sidecar.
  if (!await deps.getMeeting(id)) throw new ReviewError(t('pkg.jargon.notFound'));
  await deps.saveReview(id, review);
}

function emptyReview(deps: JargonReviewDeps): MeetingJargonReview {
  return { status: 'idle', updatedAt: deps.now(), items: [] };
}

export function runJargonReview(id: string, deps: JargonReviewDeps): Promise<JargonReviewResult> {
  if (typeof id !== 'string' || !id.trim()) return Promise.resolve(failure(new ReviewError(t('pkg.jargon.invalidAction'))));
  return scans.run(id, () => runReview(id, deps));
}

async function runReview(id: string, deps: JargonReviewDeps): Promise<JargonReviewResult> {
  let input: { raw: Meeting['entries']; effective: Meeting['entries']; registry: MiniContext[] };
  try {
    input = await enqueue(meetingQueue(id), async () => {
      const meeting = await requireMeeting(id, deps);
      const review = await deps.getReview(id) ?? emptyReview(deps);
      const age = Date.parse(deps.now()) - Date.parse(review.updatedAt);
      if (review.status === 'processing' && Number.isFinite(age) && age <= STALE_PROCESSING_MS) {
        throw new ReviewError(t('pkg.jargon.processing'));
      }
      const raw = withEntryIds(meeting.entries);
      const effective = effectiveClean(raw, await deps.getClean(id));
      const registry = await deps.getRegistry();
      const previous = Object.fromEntries(Object.entries(review).filter(([k]) => k !== "error"));
      await saveExisting(id, { ...previous, status: 'processing', updatedAt: deps.now(), items: review.items }, deps);
      return { raw, effective, registry };
    });
  } catch (error) {
    return failure(error);
  }

  try {
    // Neither client creation nor provider requests hold the short-write queue.
    const client = await deps.createClient();
    const candidates = await reviewMeetingJargon(client, input.raw, input.effective, input.registry);
    await enqueue(meetingQueue(id), async () => {
      const meeting = await requireMeeting(id, deps);
      const raw = withEntryIds(meeting.entries);
      const effective = effectiveClean(raw, await deps.getClean(id));
      const registry = new Map((await deps.getRegistry()).map((context) => [context.id, context]));
      const review = await deps.getReview(id) ?? emptyReview(deps);
      const decisions = review.items.filter((item) => item.status !== 'suggested');
      const byId = new Map(decisions.map((item) => [item.id, item]));
      for (const candidate of candidates) {
        if (byId.has(candidate.id)) continue;
        if (!candidate.evidence.every((evidence) => isJargonEvidenceValid(evidence, raw, effective))) {
          throw new ReviewError(t('pkg.jargon.staleEvidence'));
        }
        const context = candidate.miniContextId === null ? null : registry.get(candidate.miniContextId);
        if (candidate.miniContextId !== null && !context) continue;
        const next = context ? { ...candidate, term: context.term, definition: context.definition } : candidate;
        // A previously chosen meaning still wins over a newly suggested alternative.
        const chosen = decisions.some((item) => item.status === 'confirmed' && overlaps(item, next));
        byId.set(next.id, chosen ? { ...next, status: 'dismissed' } : next);
      }
      const previous2 = Object.fromEntries(Object.entries(review).filter(([k]) => k !== "error"));
      await saveExisting(id, {
        ...previous2,
        status: 'done',
        updatedAt: deps.now(),
        reviewedAt: deps.now(),
        reviewedEntryCount: input.raw.length,
        items: [...byId.values()],
      }, deps);
    });
    return { ok: true };
  } catch (error) {
    const result = failure(error, 'reviewFailed');
    try {
      await enqueue(meetingQueue(id), async () => {
        if (!await deps.getMeeting(id)) return;
        const review = await deps.getReview(id) ?? emptyReview(deps);
        await saveExisting(id, { ...review, status: 'error', updatedAt: deps.now(), error: result.ok ? '' : result.error }, deps);
      });
    } catch (storageError) {
      return failure(storageError);
    }
    return result;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validEvidence(value: unknown): value is JargonEvidence {
  return record(value) && typeof value.entryId === 'string' && typeof value.sourceText === 'string'
    && typeof value.observed === 'string' && (value.variant === 'raw' || value.variant === 'clean');
}

function validItem(value: unknown): value is MeetingJargonItem {
  return record(value) && typeof value.id === 'string' && typeof value.term === 'string'
    && typeof value.definition === 'string' && typeof value.reason === 'string'
    && (value.origin === 'llm' || value.origin === 'manual')
    && (value.status === 'suggested' || value.status === 'confirmed' || value.status === 'dismissed')
    && (value.miniContextId === null || typeof value.miniContextId === 'string')
    && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(validEvidence);
}

function validAction(value: unknown): value is JargonReviewAction {
  if (!record(value)) return false;
  if (value.type === 'confirm') return validItem(value.item);
  return (value.type === 'dismiss' || value.type === 'remove' || value.type === 'register')
    && typeof value.itemId === 'string' && value.itemId.length > 0;
}

function overlaps(a: MeetingJargonItem, b: MeetingJargonItem): boolean {
  const keys = new Set(a.evidence.map(jargonOccurrenceKey));
  return b.evidence.some((evidence) => keys.has(jargonOccurrenceKey(evidence)));
}

function sameMeaning(a: MeetingJargonItem, b: MeetingJargonItem): boolean {
  return a.miniContextId === b.miniContextId
    && normalizeJargonPhrase(a.term) === normalizeJargonPhrase(b.term)
    && a.definition.trim() === b.definition.trim();
}

function assertEvidence(item: MeetingJargonItem, raw: Meeting['entries'], effective: Meeting['entries']): void {
  if (!item.evidence.length || !item.evidence.every((evidence) => isJargonEvidenceValid(evidence, raw, effective))) {
    throw new ReviewError(t('pkg.jargon.staleEvidence'));
  }
}

function confirmedItem(input: MeetingJargonItem, review: MeetingJargonReview, registry: MiniContext[]): MeetingJargonItem {
  let source = input;
  let origin: MeetingJargonItem['origin'] = 'manual';
  if (input.origin === 'llm') {
    const saved = review.items.find((item) => item.id === input.id && item.origin === 'llm');
    if (!saved || saved.status === 'dismissed') throw new ReviewError(t('pkg.jargon.candidateMissing'));
    // An AI confirmation cites the persisted candidate, never client-authored evidence or registry IDs.
    if (saved.miniContextId !== input.miniContextId || JSON.stringify(saved.evidence) !== JSON.stringify(input.evidence)) {
      throw new ReviewError(t('pkg.jargon.invalidAction'));
    }
    source = { ...saved, term: input.term, definition: input.definition };
    origin = saved.miniContextId === null ? 'manual' : 'llm';
  }
  const context = source.miniContextId === null ? null : registry.find((item) => item.id === source.miniContextId);
  if (source.miniContextId !== null && !context) throw new ReviewError(t('pkg.jargon.registryMissing'));
  const term = (context?.term ?? source.term).trim();
  const definition = (context?.definition ?? source.definition).trim();
  if (!term || !definition) throw new ReviewError(t('pkg.jargon.meaningRequired'));
  return {
    id: jargonItemId(source.evidence[0], source.miniContextId),
    origin,
    status: 'confirmed',
    miniContextId: source.miniContextId,
    term,
    definition,
    reason: origin === 'llm' ? source.reason : '',
    evidence: source.evidence.map((evidence) => ({ ...evidence })),
  };
}

function mergeConfirmation(items: MeetingJargonItem[], confirmed: MeetingJargonItem): MeetingJargonItem[] {
  if (items.some((item) => item.status === 'confirmed'
    && overlaps(item, confirmed) && !sameMeaning(item, confirmed))) {
    throw new ReviewError(t('pkg.jargon.conflict'));
  }
  const next = items.filter((item) => item.id !== confirmed.id).map((item) => (
    item.status === 'suggested' && overlaps(item, confirmed) ? { ...item, status: 'dismissed' as const } : item
  ));
  return [...next, confirmed];
}

export function updateJargonReview(id: string, action: JargonReviewAction, deps: JargonReviewDeps): Promise<JargonReviewResult> {
  if (typeof id !== 'string' || !id.trim() || !validAction(action)) {
    return Promise.resolve(failure(new ReviewError(t('pkg.jargon.invalidAction'))));
  }
  // Take a snapshot before queueing so callers cannot mutate the validated action while it waits.
  const snapshot: JargonReviewAction = action.type === 'confirm'
    ? { type: 'confirm', item: { ...action.item, evidence: action.item.evidence.map((evidence) => ({ ...evidence })) } }
    : { ...action };
  const mutate = () => enqueue(meetingQueue(id), () => updateReview(id, snapshot, deps));
  // Lock ordering is always registry -> meeting. Other actions never take the registry lock.
  const result = snapshot.type === 'register' ? enqueue(REGISTRY_QUEUE, mutate) : mutate();
  return result.catch((error: unknown) => failure(error));
}

async function updateReview(id: string, action: JargonReviewAction, deps: JargonReviewDeps): Promise<JargonReviewResult> {
  const meeting = await requireMeeting(id, deps);
  const review = await deps.getReview(id) ?? emptyReview(deps);
  let items = review.items;
  if (action.type === 'confirm') {
    const raw = withEntryIds(meeting.entries);
    const effective = effectiveClean(raw, await deps.getClean(id));
    const confirmed = confirmedItem(action.item, review, await deps.getRegistry());
    assertEvidence(confirmed, raw, effective);
    items = mergeConfirmation(items, confirmed);
  } else {
    const item = items.find((candidate) => candidate.id === action.itemId);
    if (!item) throw new ReviewError(t('pkg.jargon.candidateMissing'));
    if (action.type === 'dismiss') {
      if (item.status === 'confirmed') throw new ReviewError(t('pkg.jargon.invalidAction'));
      items = items.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'dismissed' } : candidate);
    } else if (action.type === 'remove') {
      if (item.status !== 'confirmed') throw new ReviewError(t('pkg.jargon.invalidAction'));
      items = items.filter((candidate) => candidate.id !== item.id);
    } else {
      if (item.status !== 'confirmed' || item.miniContextId !== null) throw new ReviewError(t('pkg.jargon.invalidAction'));
      const raw = withEntryIds(meeting.entries);
      assertEvidence(item, raw, effectiveClean(raw, await deps.getClean(id)));
      if (!item.term.trim() || !item.definition.trim()) throw new ReviewError(t('pkg.jargon.meaningRequired'));
      const registry = await deps.getRegistry();
      const duplicate = registry.find((context) => normalizeJargonPhrase(context.term) === normalizeJargonPhrase(item.term));
      if (duplicate) throw new ReviewError(t('pkg.jargon.duplicateTerm', { term: duplicate.term }), duplicate.id);
      const base = `ctx_${Date.now()}`;
      let contextId = base;
      let suffix = 1;
      while (registry.some((context) => context.id === contextId)) contextId = `${base}_${suffix++}`;
      const now = deps.now();
      const context: MiniContext = { id: contextId, term: item.term, definition: item.definition, tags: [], createdAt: now, updatedAt: now };
      if (!await deps.getMeeting(id)) throw new ReviewError(t('pkg.jargon.notFound'));
      try {
        await deps.saveRegistry([...registry, context]);
      } catch (error) {
        throw new ReviewError(t('pkg.jargon.registrationFailed', { detail: detail(error) }));
      }
      // Preserve the confirmed meeting snapshot, even after promotion to the registry.
      const linked = { ...item, id: jargonItemId(item.evidence[0], contextId), miniContextId: contextId };
      items = mergeConfirmation(items.filter((candidate) => candidate.id !== item.id), linked);
    }
  }
  await saveExisting(id, { ...review, updatedAt: deps.now(), items }, deps);
  return { ok: true };
}
