import { describe, expect, it, vi } from 'vitest';
import type { AIClient } from '@meetcc/ai';
import {
  jargonItemId,
  type Entry,
  type Meeting,
  type MeetingJargonItem,
  type MeetingJargonReview,
  type MiniContext,
} from '@meetcc/shared';
import { runJargonReview, updateJargonReview, type JargonReviewAction, type JargonReviewDeps } from './jargon';

const NOW = '2026-07-13T03:00:00Z';
const raw: Entry[] = [
  { id: 'imported-line', speaker: 'A', text: 'invoice ini masih unpad, pelanggan belum membayar', time: '2026-07-13T01:00:05Z' },
  { speaker: 'B', text: 'kode biru artinya eskalasi', time: '2026-07-13T01:00:06Z' },
];
const glossary: MiniContext[] = [
  { id: 'unpaid', term: 'unpaid', definition: 'invoice not yet settled', tags: [], createdAt: NOW, updatedAt: NOW },
  { id: 'other', term: 'unpad', definition: 'a university', tags: [], createdAt: NOW, updatedAt: NOW },
];

function candidate(contextId: string | null = 'unpaid', entry = 0): MeetingJargonItem {
  const evidence = { entryId: raw[entry].id ?? `E${entry + 1}`, variant: 'raw' as const, sourceText: raw[entry].text, observed: entry === 0 ? 'unpad' : 'kode biru' };
  const context = glossary.find((item) => item.id === contextId);
  return {
    id: jargonItemId(evidence, contextId), origin: 'llm', status: 'suggested', miniContextId: contextId,
    term: context?.term ?? evidence.observed, definition: context?.definition ?? '', reason: 'The invoice is unsettled.', evidence: [evidence],
  };
}

function manual(entry = 1): MeetingJargonItem {
  return { ...candidate(null, entry), id: 'untrusted-id', origin: 'manual', status: 'dismissed', term: 'kode biru', definition: 'urgent escalation for this team', reason: 'untrusted provenance' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let sequence = 0;
function harness(complete: AIClient['complete'] = async () => JSON.stringify({ matches: [] })) {
  const id = `jargon-${++sequence}`;
  let meeting: Meeting | null = {
    id, meta: { id, startedAt: '2026-07-13T01:00:00Z', lastSeenAt: '2026-07-13T02:00:00Z' }, entries: structuredClone(raw),
  };
  let review: MeetingJargonReview | null = null;
  let registry = structuredClone(glossary);
  const client: AIClient = { provider: 'openai', complete: vi.fn(complete) };
  const deps: JargonReviewDeps = {
    getMeeting: vi.fn(async () => structuredClone(meeting)),
    getClean: vi.fn(async () => null),
    getRegistry: vi.fn(async () => structuredClone(registry)),
    getReview: vi.fn(async () => structuredClone(review)),
    saveReview: vi.fn(async (_id, next) => { review = structuredClone(next); }),
    saveRegistry: vi.fn(async (next) => { registry = structuredClone(next); }),
    createClient: vi.fn(async () => client),
    now: () => NOW,
  };
  return {
    id, deps, client,
    get meeting() { return meeting; }, set meeting(next: Meeting | null) { meeting = next; },
    get review() { return review; }, set review(next: MeetingJargonReview | null) { review = next; },
    get registry() { return registry; }, set registry(next: MiniContext[]) { registry = next; },
    seed(items: MeetingJargonItem[], status: MeetingJargonReview['status'] = 'done', updatedAt = NOW) {
      review = { status, updatedAt, reviewedAt: NOW, reviewedEntryCount: raw.length, items: structuredClone(items) };
    },
  };
}

const answer = (contextId: string | null = 'unpaid') => JSON.stringify({ matches: [
  { miniContextId: contextId, entryId: 'imported-line', variant: 'raw', observed: 'unpad', reason: 'The invoice is unsettled.' },
] });

describe('jargon confirmation boundary', () => {
  it('uses real evidence, deterministic ID and trusted manual provenance without changing transcript or registry', async () => {
    const h = harness();
    const before = structuredClone(h.meeting);
    expect(await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items).toEqual([{
      ...manual(), id: jargonItemId(manual().evidence[0], null), origin: 'manual', status: 'confirmed', reason: '',
    }]);
    expect(h.meeting).toEqual(before);
    expect(h.registry).toEqual(glossary);
  });

  it('hydrates the current registry definition rather than trusting client replacements', async () => {
    const h = harness();
    const suggested = candidate();
    h.seed([suggested]);
    h.registry[0].definition = 'current registered meaning';
    expect(await updateJargonReview(h.id, { type: 'confirm', item: { ...suggested, term: 'invented', definition: 'invented' } }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items[0]).toMatchObject({ term: 'unpaid', definition: 'current registered meaning', origin: 'llm', status: 'confirmed' });
  });

  it('requires removal before changing a meeting-only meaning with the same deterministic ID', async () => {
    const h = harness();
    expect(await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps)).toEqual({ ok: true });
    const before = structuredClone(h.review);
    expect((await updateJargonReview(h.id, { type: 'confirm', item: { ...manual(), definition: 'a conflicting meaning' } }, h.deps)).ok).toBe(false);
    expect(h.review).toEqual(before);
  });

  it('marks a clarified unknown suggestion as human-authored context while retaining its real evidence', async () => {
    const h = harness();
    const unknown = candidate(null, 1);
    h.seed([unknown]);
    expect(await updateJargonReview(h.id, { type: 'confirm', item: { ...unknown, definition: 'urgent escalation for this team' } }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items[0]).toMatchObject({ origin: 'manual', status: 'confirmed', definition: 'urgent escalation for this team', evidence: unknown.evidence, reason: '' });
  });

  it('requires an existing saved AI candidate and binds its evidence and registry ID', async () => {
    const h = harness();
    expect((await updateJargonReview(h.id, { type: 'confirm', item: candidate() }, h.deps)).ok).toBe(false);
    h.seed([candidate()]);
    expect((await updateJargonReview(h.id, { type: 'confirm', item: { ...candidate(), miniContextId: 'other' } }, h.deps)).ok).toBe(false);
    const forged = { ...candidate(), evidence: manual().evidence };
    expect((await updateJargonReview(h.id, { type: 'confirm', item: forged }, h.deps)).ok).toBe(false);
    expect(h.review?.items[0].status).toBe('suggested');
  });

  it.each([
    { evidence: [{ ...manual().evidence[0], entryId: 'made-up' }] },
    { evidence: [{ ...manual().evidence[0], sourceText: 'older transcript text' }] },
    { evidence: [{ ...manual().evidence[0], observed: 'not in the sentence' }] },
    { evidence: [{ ...manual().evidence[0], observed: '   ' }] },
    { term: ' ' },
    { definition: ' ' },
    { miniContextId: 'not-registered' },
  ])('rejects invalid or stale confirmation %# without publishing it', async (change) => {
    const h = harness();
    expect((await updateJargonReview(h.id, { type: 'confirm', item: { ...manual(), ...change } }, h.deps)).ok).toBe(false);
    expect(h.review).toBeNull();
  });

  it.each([null, {}, { type: 'unexpected' }, { type: 'remove' }, { type: 'confirm', item: null },
    { type: 'confirm', item: { ...manual(), evidence: [null] } },
    { type: 'confirm', item: { ...manual(), evidence: [{ ...manual().evidence[0], variant: 'invented' }] } },
  ])('rejects malformed runtime action %# with a route error rather than throwing', async (action) => {
    const h = harness();
    expect((await updateJargonReview(h.id, action as unknown as JargonReviewAction, h.deps)).ok).toBe(false);
    expect(h.review).toBeNull();
  });

  it('rejects stale effective-clean evidence after the correction is rejected', async () => {
    const h = harness();
    const item = manual(0);
    item.evidence = [{ ...item.evidence[0], variant: 'clean', sourceText: 'invoice unpaid', observed: 'unpaid' }];
    h.deps.getClean = async () => ({ status: 'done', entries: [{ ...raw[0], text: 'invoice unpaid' }], kept: [0], changed: 1, generatedAt: NOW });
    expect((await updateJargonReview(h.id, { type: 'confirm', item }, h.deps)).ok).toBe(false);
  });

  it('serializes distinct concurrent confirmations and keeps both', async () => {
    const h = harness();
    const results = await Promise.all([
      updateJargonReview(h.id, { type: 'confirm', item: manual(0) }, h.deps),
      updateJargonReview(h.id, { type: 'confirm', item: manual(1) }, h.deps),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(h.review?.items.map((item) => item.evidence[0].entryId)).toEqual(['imported-line', 'E2']);
  });

  it('confirms one alternative, persists dismissal of others, and requires removal before changing meaning', async () => {
    const h = harness();
    h.seed([candidate(), candidate('other')]);
    expect(await updateJargonReview(h.id, { type: 'confirm', item: candidate() }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items.find((item) => item.miniContextId === 'other')?.status).toBe('dismissed');
    const alternative = { ...candidate('other'), origin: 'manual' as const };
    expect((await updateJargonReview(h.id, { type: 'confirm', item: alternative }, h.deps)).ok).toBe(false);
    expect(await updateJargonReview(h.id, { type: 'remove', itemId: candidate().id }, h.deps)).toEqual({ ok: true });
    expect(await updateJargonReview(h.id, { type: 'confirm', item: alternative }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items).toMatchObject([{ miniContextId: 'other', status: 'confirmed' }]);
  });

  it('allows obsolete confirmed snapshots to be removed, but never dismissed accidentally', async () => {
    const h = harness();
    const item = { ...candidate(), status: 'confirmed' as const };
    h.seed([item]);
    h.meeting!.entries[0].text = 'edited transcript';
    expect((await updateJargonReview(h.id, { type: 'dismiss', itemId: item.id }, h.deps)).ok).toBe(false);
    expect(await updateJargonReview(h.id, { type: 'remove', itemId: item.id }, h.deps)).toEqual({ ok: true });
    expect(h.review?.items).toEqual([]);
  });

  it('returns storage failures without discarding previously confirmed items and releases the queue', async () => {
    const h = harness();
    h.seed([{ ...candidate(), status: 'confirmed' }]);
    const before = structuredClone(h.review);
    vi.mocked(h.deps.saveReview).mockRejectedValueOnce(new Error('disk unavailable'));
    const failed = await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps);
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('disk unavailable') });
    expect(h.review).toEqual(before);
    expect(await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps)).toEqual({ ok: true });
  });
});

describe('on-demand jargon scan', () => {
  it('joins concurrent scans while leaving the action queue free; completion preserves new decisions', async () => {
    const gate = deferred<string>();
    const entered = deferred<void>();
    const h = harness(async () => { entered.resolve(); return gate.promise; });
    const first = runJargonReview(h.id, h.deps);
    await entered.promise;
    const second = runJargonReview(h.id, h.deps);
    expect(first).toBe(second);
    expect(h.review?.status).toBe('processing');
    expect(await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps)).toEqual({ ok: true });
    gate.resolve(answer());
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(h.client.complete).toHaveBeenCalledTimes(1);
    expect(h.review?.items).toMatchObject([
      { origin: 'manual', status: 'confirmed', definition: 'urgent escalation for this team' },
      { status: 'suggested', term: 'unpaid', definition: 'invoice not yet settled' },
    ]);
  });

  it('keeps confirmed snapshots and dismissed deterministic candidates on rerun', async () => {
    const h = harness(async () => answer());
    h.seed([{ ...candidate(), status: 'dismissed' }, { ...manual(), id: jargonItemId(manual().evidence[0], null), status: 'confirmed' }]);
    expect(await runJargonReview(h.id, h.deps)).toEqual({ ok: true });
    expect(h.review?.items.map((item) => item.status)).toEqual(['dismissed', 'confirmed']);
    h.registry[0].definition = 'changed globally';
    h.seed([{ ...candidate(), status: 'confirmed' }]);
    expect(await runJargonReview(h.id, h.deps)).toEqual({ ok: true });
    expect(h.review?.items[0].definition).toBe('invoice not yet settled');
  });

  it.each(['provider', 'malformed'])('keeps the full previous list and human decisions on %s failure', async (kind) => {
    const h = harness(async () => { if (kind === 'provider') throw new Error('provider offline'); return 'not JSON'; });
    const items = [candidate(), { ...manual(), status: 'confirmed' as const }, { ...candidate('other'), status: 'dismissed' as const }];
    h.seed(items);
    expect((await runJargonReview(h.id, h.deps)).ok).toBe(false);
    expect(h.review).toMatchObject({ status: 'error', items, reviewedAt: NOW, reviewedEntryCount: 2 });
    expect(h.review?.error).toBeTruthy();
  });

  it('saves real client-configuration errors while retaining the existing review', async () => {
    const h = harness();
    h.seed([candidate()]);
    h.deps.createClient = async () => { throw new Error('Configure your API key'); };
    expect(await runJargonReview(h.id, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining('Configure your API key') });
    expect(h.review).toMatchObject({ status: 'error', items: [candidate()] });
  });

  it.each(['deleted', 'live', 'empty'])('rejects %s meetings before client creation', async (kind) => {
    const h = harness();
    if (kind === 'deleted') h.meeting = null;
    if (kind === 'live') h.meeting!.meta!.lastSeenAt = NOW;
    if (kind === 'empty') h.meeting!.entries = [];
    expect((await runJargonReview(h.id, h.deps)).ok).toBe(false);
    expect(h.deps.createClient).not.toHaveBeenCalled();
    expect(h.review).toBeNull();
  });

  it('blocks fresh persisted processing but permits an explicit retry after five minutes', async () => {
    const h = harness();
    h.seed([candidate()], 'processing');
    expect((await runJargonReview(h.id, h.deps)).ok).toBe(false);
    expect(h.deps.createClient).not.toHaveBeenCalled();
    h.seed([candidate()], 'processing', '2026-07-13T02:54:59Z');
    expect(await runJargonReview(h.id, h.deps)).toEqual({ ok: true });
    expect(h.review?.status).toBe('done');
    expect(h.review?.items).toEqual([]);
  });

  it.each([true, false])('never resurrects a review after deletion during a successful=%s provider call', async (success) => {
    const gate = deferred<string>();
    const entered = deferred<void>();
    const h = harness(async () => { entered.resolve(); return gate.promise; });
    const run = runJargonReview(h.id, h.deps);
    await entered.promise;
    h.meeting = null;
    h.review = null;
    if (success) gate.resolve(answer()); else gate.reject(new Error('offline'));
    expect((await run).ok).toBe(false);
    expect(h.review).toBeNull();
  });

  it('rejects completion when transcript evidence changed during the request', async () => {
    const gate = deferred<string>();
    const entered = deferred<void>();
    const h = harness(async () => { entered.resolve(); return gate.promise; });
    h.seed([candidate('other')]);
    const run = runJargonReview(h.id, h.deps);
    await entered.promise;
    h.meeting!.entries[0].text = 'now a different sentence';
    gate.resolve(answer());
    expect((await run).ok).toBe(false);
    expect(h.review).toMatchObject({ status: 'error', items: [candidate('other')] });
  });
});

describe('explicit registry promotion', () => {
  async function confirmedHarness() {
    const h = harness();
    await updateJargonReview(h.id, { type: 'confirm', item: manual() }, h.deps);
    return h;
  }

  it('creates an empty-tag registry entry and links the deterministic item ID without rewriting its snapshot', async () => {
    const h = await confirmedHarness();
    const before = structuredClone(h.review!.items[0]);
    expect(await updateJargonReview(h.id, { type: 'register', itemId: before.id }, h.deps)).toEqual({ ok: true });
    const context = h.registry.find((item) => item.term === before.term)!;
    expect(context).toMatchObject({ definition: before.definition, tags: [], createdAt: NOW, updatedAt: NOW });
    expect(h.review!.items[0]).toEqual({ ...before, id: jargonItemId(before.evidence[0], context.id), miniContextId: context.id });
  });

  it('reports trimmed case-insensitive duplicates without replacing the existing definition', async () => {
    const h = await confirmedHarness();
    h.registry.push({ ...glossary[0], id: 'existing-blue', term: ' KODE BIRU ', definition: 'a different global meaning' });
    const before = structuredClone(h.review);
    const result = await updateJargonReview(h.id, { type: 'register', itemId: h.review!.items[0].id }, h.deps);
    expect(result).toMatchObject({ ok: false, existingMiniContextId: 'existing-blue' });
    expect(h.review).toEqual(before);
    expect(h.registry.at(-1)?.definition).toBe('a different global meaning');
    expect(h.deps.saveRegistry).not.toHaveBeenCalled();
  });

  it('leaves the successful meeting-only clarification intact when registry storage fails', async () => {
    const h = await confirmedHarness();
    const before = structuredClone(h.review);
    vi.mocked(h.deps.saveRegistry).mockRejectedValueOnce(new Error('registry quota exceeded'));
    expect(await updateJargonReview(h.id, { type: 'register', itemId: h.review!.items[0].id }, h.deps)).toMatchObject({ ok: false, error: expect.stringContaining('registry quota exceeded') });
    expect(h.review).toEqual(before);
    expect(h.registry).toEqual(glossary);
  });

  it('globally serializes promotions from different meetings so only one duplicate is created', async () => {
    const a = await confirmedHarness();
    const b = await confirmedHarness();
    let registry = structuredClone(glossary);
    for (const h of [a, b]) {
      h.deps.getRegistry = async () => structuredClone(registry);
      h.deps.saveRegistry = async (next) => { registry = structuredClone(next); };
    }
    const results = await Promise.all([a, b].map((h) => updateJargonReview(h.id, { type: 'register', itemId: h.review!.items[0].id }, h.deps)));
    expect(results[0]).toEqual({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, existingMiniContextId: registry.at(-1)!.id });
    expect(registry.filter((context) => context.term === 'kode biru')).toHaveLength(1);
    expect(b.review!.items[0].miniContextId).toBeNull();
  });

  it('checks timestamp ID collisions and does not replace another registry row', async () => {
    const h = await confirmedHarness();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      h.registry.push({ ...glossary[0], id: 'ctx_1000', term: 'other term' });
      expect(await updateJargonReview(h.id, { type: 'register', itemId: h.review!.items[0].id }, h.deps)).toEqual({ ok: true });
      expect(h.registry.find((item) => item.id === 'ctx_1000')?.term).toBe('other term');
      expect(h.review!.items[0].miniContextId).toBe('ctx_1000_1');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not resurrect a sidecar when deletion happens during registry persistence', async () => {
    const h = await confirmedHarness();
    h.deps.saveRegistry = async (contexts) => { h.registry = contexts; h.meeting = null; h.review = null; };
    expect((await updateJargonReview(h.id, { type: 'register', itemId: h.review!.items[0].id }, h.deps)).ok).toBe(false);
    expect(h.review).toBeNull();
  });
});

describe('whole-scan publication', () => {
  it('does not publish a successful first packet when a later packet fails', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      if (calls === 1) return answer();
      throw new Error('middle packet unavailable');
    });
    const oldItems = [{ ...candidate('other'), status: 'dismissed' as const }, { ...manual(), status: 'confirmed' as const }];
    h.seed(oldItems);
    h.meeting!.entries = [
      { ...raw[0], text: raw[0].text + ' x'.repeat(3500) },
      { ...raw[1], text: raw[1].text + ' y'.repeat(3500) },
      { ...raw[1], text: 'last packet' + ' z'.repeat(3500) },
    ];
    expect((await runJargonReview(h.id, h.deps)).ok).toBe(false);
    expect(h.review).toMatchObject({ status: 'error', items: oldItems });
    expect(h.review?.items.some((item) => item.status === 'suggested')).toBe(false);
  });

  it('dismisses newly scanned alternatives to a previously confirmed occurrence', async () => {
    const h = harness(async () => answer('other'));
    h.seed([{ ...candidate(), status: 'confirmed' }]);
    expect(await runJargonReview(h.id, h.deps)).toEqual({ ok: true });
    expect(h.review?.items).toMatchObject([
      { miniContextId: 'unpaid', status: 'confirmed' },
      { miniContextId: 'other', status: 'dismissed' },
    ]);
  });
});
