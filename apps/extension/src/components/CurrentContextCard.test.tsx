// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '@meetcc/shared/i18n';
import {
  CONTEXT_PREFIX, GOALS_PREFIX, JARGON_REVIEW_PREFIX, MEETING_TAGS_PREFIX, MINI_CONTEXTS_KEY,
  type Meeting, type MeetingJargonItem, type MeetingJargonReview, type MiniContext,
} from '@meetcc/shared';
import { CurrentContextCard } from './CurrentContextCard';

const timestamp = '2026-09-01T10:00:00.000Z';
const meeting = (id = 'one'): Meeting => ({
  id, meta: null, context: 'Stale embedded context', tags: ['stale'], goals: ['Stale embedded goal'],
  entries: [{ speaker: 'A', time: timestamp, text: 'invoice ini masih unpad' }],
});
const registered = (id: string, term: string, definition: string, tags: string[] = []): MiniContext => ({
  id, term, definition, tags, createdAt: timestamp, updatedAt: timestamp,
});
const item = (overrides: Partial<MeetingJargonItem> = {}): MeetingJargonItem => ({
  id: 'invoice-match', origin: 'llm', status: 'confirmed', miniContextId: 'invoice',
  term: 'unpaid', definition: 'Invoice not yet settled', reason: 'Payment remains due',
  evidence: [{ entryId: 'E1', variant: 'raw', sourceText: 'invoice ini masih unpad', observed: 'unpad' }],
  ...overrides,
});
const review = (items: MeetingJargonItem[] = [], overrides: Partial<MeetingJargonReview> = {}): MeetingJargonReview => ({
  status: 'done', updatedAt: timestamp, reviewedAt: timestamp, items, ...overrides,
});

let stored: Record<string, unknown>;
let listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
const get = vi.fn();
const set = vi.fn();
const sendMessage = vi.fn();
const onReviewJargon = vi.fn();
const onClarifyTerm = vi.fn();

function notify(key: string, area = 'local') {
  for (const listener of listeners) listener({ [key]: { newValue: stored[key] } }, area);
}
function renderCard(value = meeting()) {
  return render(<CurrentContextCard meeting={value} onReviewJargon={onReviewJargon} onClarifyTerm={onClarifyTerm} />);
}
async function loaded() {
  await screen.findByRole('heading', { name: t('ext.currentContext.terms') });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  setLang('en');
  stored = {};
  listeners = new Set();
  get.mockReset().mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  set.mockReset();
  sendMessage.mockReset();
  onReviewJargon.mockReset();
  onClarifyTerm.mockReset();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: { get, set },
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => listeners.add(listener),
        removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(listener),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLang('en');
});

describe('current saved context', () => {
  it('uses persisted attachments and confirmed snapshots, excluding unconfirmed meanings and unrelated registry tags', async () => {
    stored[CONTEXT_PREFIX + 'one'] = 'Saved billing context';
    stored[GOALS_PREFIX + 'one'] = ['Agree the payment deadline'];
    stored[MEETING_TAGS_PREFIX + 'one'] = ['carry'];
    stored[MINI_CONTEXTS_KEY] = [
      registered('weekly', 'weekly review', 'Weekly account review', ['carry']),
      registered('invoice', 'unpaid', 'Changed global meaning', ['finance']),
      registered('other-finance', 'credit', 'Unrelated finance meaning', ['finance']),
      registered('stale', 'stale', 'Stale embedded attachment'),
      registered('suggested', 'lead time', 'Suggested registry meaning'),
    ];
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([
      item(),
      item({ id: 'removed', miniContextId: 'removed', term: 'legacy', definition: 'Retained deleted definition' }),
      item({ id: 'manual', miniContextId: null, origin: 'manual', term: 'kode biru', definition: 'Urgent team escalation' }),
      item({ id: 'suggested', status: 'suggested', miniContextId: 'suggested', term: 'lead time', definition: 'Suggested registry meaning' }),
      item({ id: 'dismissed', status: 'dismissed', miniContextId: null, term: 'rejected', definition: 'Rejected meaning' }),
    ]);
    renderCard();
    await loaded();
    expect(screen.getByText('Saved billing context')).toBeTruthy();
    expect(screen.getByText('Agree the payment deadline')).toBeTruthy();
    expect(screen.getByText('Weekly account review')).toBeTruthy();
    expect(screen.getByText(t('ext.currentContext.attached'))).toBeTruthy();
    expect(screen.getByText('Invoice not yet settled')).toBeTruthy();
    expect(screen.getByText('Retained deleted definition')).toBeTruthy();
    expect(screen.getByText('Urgent team escalation')).toBeTruthy();
    expect(screen.getByText(t('ext.currentContext.registryChanged'))).toBeTruthy();
    expect(screen.getByText(t('ext.currentContext.registryRemoved'))).toBeTruthy();
    expect(screen.getByText(t('ext.currentContext.pending', { count: 1 }))).toBeTruthy();
    for (const excluded of ['Changed global meaning', 'Unrelated finance meaning', 'Stale embedded attachment',
      'Suggested registry meaning', 'Rejected meaning', 'Stale embedded context', 'Stale embedded goal']) {
      expect(screen.queryByText(excluded)).toBeNull();
    }
  });

  it('distinguishes missing and manually created reviews from a completed empty scan', async () => {
    renderCard();
    await loaded();
    expect(screen.getByText(t('ext.currentContext.notReviewed'))).toBeTruthy();
    expect(screen.queryByText(t('ext.currentContext.noSuggestions'))).toBeNull();
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([
      item({ origin: 'manual', miniContextId: null, term: 'kode biru', definition: 'Team escalation' }),
    ], { status: 'idle', reviewedAt: undefined });
    act(() => notify(JARGON_REVIEW_PREFIX + 'one'));
    await screen.findByText('Team escalation');
    expect(screen.getByText(t('ext.currentContext.notReviewed'))).toBeTruthy();
    expect(screen.queryByText(t('ext.currentContext.noSuggestions'))).toBeNull();
    stored[JARGON_REVIEW_PREFIX + 'one'] = review();
    act(() => notify(JARGON_REVIEW_PREFIX + 'one'));
    await screen.findByText(t('ext.currentContext.noSuggestions'));
    expect(screen.queryByText(t('ext.currentContext.notReviewed'))).toBeNull();
  });

  it('refreshes every persisted input without treating prefix collisions or another storage area as this meeting', async () => {
    renderCard();
    await loaded();
    stored[CONTEXT_PREFIX + 'one'] = 'New external context';
    await act(async () => {
      notify(CONTEXT_PREFIX + 'one-other');
      notify(CONTEXT_PREFIX + 'one', 'sync');
    });
    expect(screen.queryByText('New external context')).toBeNull();
    act(() => notify(CONTEXT_PREFIX + 'one'));
    await screen.findByText('New external context');
    stored[GOALS_PREFIX + 'one'] = ['Updated goal'];
    act(() => notify(GOALS_PREFIX + 'one'));
    await screen.findByText('Updated goal');
    stored[MINI_CONTEXTS_KEY] = [registered('attached', 'term', 'Attached meaning', ['carry'])];
    act(() => notify(MINI_CONTEXTS_KEY));
    stored[MEETING_TAGS_PREFIX + 'one'] = ['carry'];
    act(() => notify(MEETING_TAGS_PREFIX + 'one'));
    await screen.findByText('Attached meaning');
    stored[MINI_CONTEXTS_KEY] = [registered('attached', 'term', 'Updated attached meaning', ['carry'])];
    act(() => notify(MINI_CONTEXTS_KEY));
    await screen.findByText('Updated attached meaning');
    expect(screen.queryByText('Attached meaning')).toBeNull();
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([item({ miniContextId: null, term: 'manual', definition: 'New confirmed meaning' })]);
    act(() => notify(JARGON_REVIEW_PREFIX + 'one'));
    await screen.findByText('New confirmed meaning');
  });

  it('retains saved context through processing, interruption and provider errors', async () => {
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([item()], {
      status: 'processing', updatedAt: new Date(Date.now()).toISOString(),
    });
    renderCard();
    await screen.findByText(t('ext.currentContext.processing'));
    expect(screen.getByText('Invoice not yet settled')).toBeTruthy();
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([item()], {
      status: 'processing', updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    });
    act(() => notify(JARGON_REVIEW_PREFIX + 'one'));
    await screen.findByText(t('ext.currentContext.interrupted'));
    expect(screen.getByText('Invoice not yet settled')).toBeTruthy();
    stored[JARGON_REVIEW_PREFIX + 'one'] = review([item()], { status: 'error', error: 'Provider unavailable' });
    act(() => notify(JARGON_REVIEW_PREFIX + 'one'));
    expect((await screen.findByRole('alert')).textContent).toContain('Provider unavailable');
    expect(screen.getByText('Invoice not yet settled')).toBeTruthy();
  });

  it('keeps the last persisted display when a refresh fails and recovers on the next update', async () => {
    stored[CONTEXT_PREFIX + 'one'] = 'Retain saved context';
    renderCard();
    await screen.findByText('Retain saved context');
    get.mockRejectedValueOnce(new Error('Storage unavailable'));
    act(() => notify(CONTEXT_PREFIX + 'one'));
    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable');
    expect(screen.getByText('Retain saved context')).toBeTruthy();
    stored[CONTEXT_PREFIX + 'one'] = 'Storage recovered';
    act(() => notify(CONTEXT_PREFIX + 'one'));
    await screen.findByText('Storage recovered');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a newer storage refresh when an older read finishes last', async () => {
    const oldRead = deferred<Record<string, unknown>>();
    get.mockImplementationOnce(() => oldRead.promise);
    renderCard();
    stored[CONTEXT_PREFIX + 'one'] = 'Newest saved context';
    act(() => notify(CONTEXT_PREFIX + 'one'));
    await screen.findByText('Newest saved context');
    await act(async () => { oldRead.resolve({ [CONTEXT_PREFIX + 'one']: 'Obsolete saved context' }); });
    await waitFor(() => expect(screen.getByText('Newest saved context')).toBeTruthy());
    expect(screen.queryByText('Obsolete saved context')).toBeNull();
  });

  it('does not display a late read from a previously selected meeting', async () => {
    const oldRead = deferred<Record<string, unknown>>();
    get.mockImplementation((key: string) => key === CONTEXT_PREFIX + 'one'
      ? oldRead.promise : Promise.resolve({ [key]: stored[key] }));
    stored[CONTEXT_PREFIX + 'two'] = 'Second meeting context';
    const view = renderCard();
    view.rerender(<CurrentContextCard meeting={meeting('two')} onReviewJargon={onReviewJargon} onClarifyTerm={onClarifyTerm} />);
    await screen.findByText('Second meeting context');
    await act(async () => { oldRead.resolve({ [CONTEXT_PREFIX + 'one']: 'Old late context' }); });
    expect(screen.queryByText('Old late context')).toBeNull();
    expect(screen.getByText('Second meeting context')).toBeTruthy();
    expect(listeners.size).toBe(1);
  });

  it('offers keyboard-operable navigation without changing storage or starting an AI request', async () => {
    setLang('id');
    renderCard();
    await loaded();
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('ext.currentContext.review') }));
    await user.keyboard('{Enter}');
    expect(onReviewJargon).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('ext.currentContext.clarify') }));
    await user.keyboard('{Enter}');
    expect(onClarifyTerm).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
