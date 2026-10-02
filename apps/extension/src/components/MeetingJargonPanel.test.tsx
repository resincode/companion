// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEAN_PREFIX, JARGON_REVIEW_PREFIX, MINI_CONTEXTS_KEY,
  type Meeting, type MeetingJargonItem, type MeetingJargonReview, type MiniContext,
} from '@meetcc/shared';
import { locale, setLang, t } from '@meetcc/shared/i18n';
import { MeetingJargonPanel, type MeetingJargonPanelProps } from './MeetingJargonPanel';

const timestamp = '2026-09-01T10:00:00.000Z';
const meeting: Meeting = {
  id: 'one', meta: null,
  entries: [{ id: 'import-line-a', speaker: 'Rani', time: timestamp, text: 'invoice ini masih unpad, pelanggan belum membayar' }],
};
const registered: MiniContext = {
  id: 'invoice', term: 'unpaid', definition: 'Invoice not yet settled', tags: ['finance'],
  createdAt: timestamp, updatedAt: timestamp,
};
const suggestion: MeetingJargonItem = {
  id: 'candidate', origin: 'llm', status: 'suggested', miniContextId: registered.id,
  term: 'unpaid', definition: 'Old cached meaning', reason: 'ASR wording matches the unpaid invoice context',
  evidence: [{ entryId: 'import-line-a', variant: 'raw', sourceText: meeting.entries[0].text, observed: 'unpad' }],
};
let stored: Record<string, unknown>;
let listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
const sendMessage = vi.fn();
const get = vi.fn();
const set = vi.fn();
const onViewEvidence = vi.fn();
const onClarifyEvidence = vi.fn();
const onAttachTerm = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function review(items: MeetingJargonItem[], status: MeetingJargonReview['status'] = 'done'): MeetingJargonReview {
  return { status, updatedAt: timestamp, items };
}
function notify(keys: string[], area = 'local') {
  const changes = Object.fromEntries(keys.map((key) => [key, { newValue: stored[key] }]));
  for (const listener of listeners) listener(changes, area);
}
function props(overrides: Partial<MeetingJargonPanelProps> = {}): MeetingJargonPanelProps {
  return { meeting, live: false, disabled: false, tags: [], onViewEvidence, onClarifyEvidence, onAttachTerm, ...overrides };
}
function panel(overrides: Partial<MeetingJargonPanelProps> = {}) {
  return render(<MeetingJargonPanel {...props(overrides)} />);
}
function recommendations() {
  return screen.getByRole('region', { name: t('ext.jargon.recommendations') });
}
function confirmed() {
  return screen.getByRole('region', { name: t('ext.jargon.confirmedContext') });
}
async function loaded() {
  await waitFor(() => expect(screen.queryByText(t('ext.jargon.loading'))).toBeNull());
}

beforeEach(() => {
  setLang('en');
  stored = { [MINI_CONTEXTS_KEY]: [registered], [JARGON_REVIEW_PREFIX + meeting.id]: review([suggestion]) };
  listeners = new Set();
  sendMessage.mockReset().mockResolvedValue({ ok: true });
  get.mockReset().mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  set.mockReset();
  onViewEvidence.mockReset();
  onClarifyEvidence.mockReset();
  onAttachTerm.mockReset();
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

describe('meeting jargon panel', () => {
  it('shows grounded imported evidence and current canonical meaning without confirming or invoking AI on open', async () => {
    stored[CLEAN_PREFIX + meeting.id] = {
      status: 'done', entries: [{ ...meeting.entries[0], text: 'invoice ini masih unpaid, pelanggan belum membayar' }],
      updatedAt: timestamp,
    };
    panel();
    const section = recommendations();
    await within(section).findByText(registered.definition);
    expect(within(section).queryByText(suggestion.definition)).toBeNull();
    expect(within(section).getByText(suggestion.reason)).toBeTruthy();
    expect(section.querySelector('blockquote')?.textContent).toBe(meeting.entries[0].text);
    expect(within(section).getByText('invoice ini masih unpaid, pelanggan belum membayar')).toBeTruthy();
    const expectedTime = new Date(timestamp).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    expect(within(section).getByText(`Rani · ${expectedTime}`)).toBeTruthy();
    expect(within(confirmed()).queryByText(registered.definition)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
    await userEvent.click(within(section).getByRole('button', { name: t('ext.jargon.viewTranscript') }));
    expect(onViewEvidence).toHaveBeenCalledWith(suggestion.evidence[0]);
  });

  it('navigates clean evidence by its actual imported handle and respects rejected corrections', async () => {
    const cleanedText = 'invoice ini masih unpaid, pelanggan belum membayar';
    const evidence = { ...suggestion.evidence[0], variant: 'clean' as const, sourceText: cleanedText, observed: 'unpaid' };
    stored[CLEAN_PREFIX + meeting.id] = {
      status: 'done', entries: [{ ...meeting.entries[0], text: cleanedText }], updatedAt: timestamp,
    };
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([{ ...suggestion, evidence: [evidence] }]);
    panel();
    const view = await within(recommendations()).findByRole('button', { name: t('ext.jargon.viewTranscript') });
    await userEvent.click(view);
    expect(onViewEvidence).toHaveBeenCalledWith(evidence);
    await act(async () => {
      stored[CLEAN_PREFIX + meeting.id] = {
        status: 'done', entries: [{ ...meeting.entries[0], text: cleanedText }], kept: [0], updatedAt: timestamp,
      };
      notify([CLEAN_PREFIX + meeting.id]);
    });
    await within(recommendations()).findByText(t('ext.jargon.staleEvidence'));
    expect(view).toHaveProperty('disabled', true);
    expect(within(recommendations()).getByRole('button', { name: t('ext.jargon.confirm') })).toHaveProperty('disabled', true);
  });

  it('opens unknown occurrences for human clarification without an invented definition', async () => {
    const unknown: MeetingJargonItem = {
      ...suggestion, id: 'unknown', miniContextId: null, term: 'unpad', definition: '',
    };
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([unknown]);
    panel();
    const section = screen.getByRole('region', { name: t('ext.jargon.needsClarification') });
    await within(section).findByText('unpad');
    expect(within(section).queryByRole('button', { name: t('ext.jargon.confirm') })).toBeNull();
    expect(within(section).queryByText(registered.definition)).toBeNull();
    await userEvent.click(within(section).getByRole('button', { name: t('ext.jargon.clarifyTerm') }));
    expect(onClarifyEvidence).toHaveBeenCalledWith(unknown.evidence[0]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps failed confirmations visible and never claims success without persisted state', async () => {
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'Storage quota exceeded' });
    panel();
    const button = await within(recommendations()).findByRole('button', { name: t('ext.jargon.confirm') });
    await userEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('Storage quota exceeded');
    expect(within(recommendations()).getByText(registered.definition)).toBeTruthy();
    expect(within(confirmed()).queryByText(registered.definition)).toBeNull();
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    await userEvent.click(button);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(within(confirmed()).queryByText(registered.definition)).toBeNull();
    expect(within(recommendations()).getByRole('button', { name: t('ext.jargon.confirm') })).toBeTruthy();
  });

  it('reloads confirmed snapshots and removal only from completed worker storage writes', async () => {
    sendMessage.mockImplementation(async (message) => {
      const value = stored[JARGON_REVIEW_PREFIX + meeting.id] as MeetingJargonReview;
      if (message.action.type === 'confirm') {
        value.items = [{ ...suggestion, status: 'confirmed', definition: registered.definition }];
      } else if (message.action.type === 'remove') value.items = [];
      return { ok: true };
    });
    panel();
    await userEvent.click(await within(recommendations()).findByRole('button', { name: t('ext.jargon.confirm') }));
    await within(confirmed()).findByText(registered.definition);
    expect(within(recommendations()).queryByText(registered.definition)).toBeNull();
    const remove = within(confirmed()).getByRole('button', { name: t('ext.jargon.remove') });
    await waitFor(() => expect(remove).toHaveProperty('disabled', false));
    await userEvent.click(remove);
    await waitFor(() => expect(within(confirmed()).queryByText(registered.definition)).toBeNull());
  });

  it('keeps meeting-only terms and their human definitions visible without synthesizing registry attachments', async () => {
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([{
      ...suggestion, origin: 'manual', status: 'confirmed', miniContextId: null,
      term: 'pending payment', definition: 'Waiting for this customer to settle the invoice',
    }]);
    panel();
    await within(confirmed()).findByText('Waiting for this customer to settle the invoice');
    expect(within(confirmed()).getByRole('heading', { name: 'unpad → pending payment' })).toBeTruthy();
    expect(within(confirmed()).queryByText(t('ext.jargon.attached'))).toBeNull();
    expect(within(recommendations()).queryByText(registered.definition)).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retains confirmed definitions when registry entries change or disappear', async () => {
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([{ ...suggestion, status: 'confirmed', definition: 'Saved meeting meaning' }]);
    panel();
    await within(confirmed()).findByText('Saved meeting meaning');
    expect(within(confirmed()).getByText(t('ext.jargon.registryChanged'))).toBeTruthy();
    await act(async () => {
      stored[MINI_CONTEXTS_KEY] = [];
      notify([MINI_CONTEXTS_KEY]);
    });
    await within(confirmed()).findByText(t('ext.jargon.registryDeleted'));
    expect(within(confirmed()).getByText('Saved meeting meaning')).toBeTruthy();
  });

  it('labels attachments separately and searches registry definitions and tags without writes', async () => {
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([]);
    stored[MINI_CONTEXTS_KEY] = [registered, { ...registered, id: 'lead', term: 'lead time', definition: 'Time to completion', tags: ['onboarding'] }];
    panel({ tags: ['finance'] });
    await within(confirmed()).findByText(registered.definition);
    expect(within(confirmed()).getByText(t('ext.jargon.attached'))).toBeTruthy();
    expect(within(confirmed()).queryByRole('button', { name: t('ext.jargon.viewTranscript') })).toBeNull();
    await userEvent.click(screen.getByText(t('ext.jargon.registered')));
    const search = screen.getByLabelText(t('ext.jargon.searchLabel'));
    await userEvent.type(search, 'onboarding');
    expect(screen.getByText('lead time')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.attach') }));
    expect(onAttachTerm).toHaveBeenCalledWith('lead time');
    await userEvent.clear(search);
    await userEvent.type(search, 'not yet settled');
    expect(screen.queryByText('lead time')).toBeNull();
    expect(screen.getByRole('button', { name: t('ext.jargon.alreadyAttached') })).toHaveProperty('disabled', true);
    expect(set).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([{ live: true, disabled: false }, { live: false, disabled: true }])('does not run AI while live or dirty: %o', async (state) => {
    panel(state);
    await loaded();
    const button = screen.getByRole('button', { name: t('ext.jargon.review') });
    expect(button).toHaveProperty('disabled', true);
    await userEvent.click(button);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('retains manual entry points and registered search after provider failure', async () => {
    const onClarifyTerm = vi.fn();
    sendMessage.mockResolvedValue({ ok: false, error: 'No provider configured' });
    panel({ onClarifyTerm });
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.review') }));
    expect((await screen.findByRole('alert')).textContent).toContain('No provider configured');
    const clarify = screen.getByRole('button', { name: t('ext.jargon.clarifyTerm') });
    await waitFor(() => expect(clarify).toHaveProperty('disabled', false));
    await userEvent.click(clarify);
    expect(onClarifyTerm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByText(t('ext.jargon.registered')));
    await userEvent.type(screen.getByLabelText(t('ext.jargon.searchLabel')), 'finance');
    expect(screen.getByRole('button', { name: t('ext.jargon.attach') })).toHaveProperty('disabled', false);
  });

  it('rejects stale evidence in the UI instead of navigating or confirming another line', async () => {
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([{ ...suggestion, evidence: [{ ...suggestion.evidence[0], sourceText: 'An old transcript line' }] }]);
    panel();
    await within(recommendations()).findByText(t('ext.jargon.staleEvidence'));
    const section = within(recommendations());
    expect(section.getByRole('button', { name: t('ext.jargon.confirm') })).toHaveProperty('disabled', true);
    await userEvent.click(section.getByRole('button', { name: t('ext.jargon.viewTranscript') }));
    expect(onViewEvidence).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps existing cards after an interrupted scan and offers explicit retry', async () => {
    stored[JARGON_REVIEW_PREFIX + meeting.id] = review([suggestion], 'processing');
    panel();
    await screen.findByText(t('ext.jargon.interrupted'));
    expect(within(recommendations()).getByText(registered.definition)).toBeTruthy();
    expect(screen.getByRole('button', { name: t('ext.jargon.retry') })).toHaveProperty('disabled', false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores a pending action response after switching meetings', async () => {
    const pending = deferred<{ ok: false; error: string }>();
    sendMessage.mockReturnValueOnce(pending.promise);
    const mounted = panel();
    await userEvent.click(await within(recommendations()).findByRole('button', { name: t('ext.jargon.confirm') }));
    mounted.rerender(<MeetingJargonPanel {...props({ meeting: { ...meeting, id: 'two', entries: [{ ...meeting.entries[0], id: 'second-line', text: 'Another discussion' }] } })} />);
    await screen.findByText(t('ext.jargon.notReviewed'));
    await act(async () => pending.resolve({ ok: false, error: 'Error from previous meeting' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(recommendations()).queryByText(registered.definition)).toBeNull();
    expect(screen.getByRole('button', { name: t('ext.jargon.review') })).toHaveProperty('disabled', false);
  });

  it('ignores delayed initial storage from a different meeting', async () => {
    const pending = deferred<Record<string, unknown>>();
    get.mockImplementation((key: string) => key === JARGON_REVIEW_PREFIX + 'one'
      ? pending.promise : Promise.resolve({ [key]: stored[key] }));
    const mounted = panel();
    mounted.rerender(<MeetingJargonPanel {...props({ meeting: { ...meeting, id: 'two' } })} />);
    await screen.findByText(t('ext.jargon.notReviewed'));
    await act(async () => pending.resolve({ [JARGON_REVIEW_PREFIX + 'one']: review([suggestion]) }));
    expect(within(recommendations()).queryByText(registered.definition)).toBeNull();
    expect(screen.getByText(t('ext.jargon.notReviewed'))).toBeTruthy();
  });

  it('watches exact meeting keys and ignores other meeting or storage-area changes', async () => {
    panel();
    await within(recommendations()).findByText(registered.definition);
    get.mockClear();
    await act(async () => {
      notify([JARGON_REVIEW_PREFIX + 'one-more', CLEAN_PREFIX + 'two']);
      notify([MINI_CONTEXTS_KEY], 'sync');
    });
    expect(get).not.toHaveBeenCalled();
    await act(async () => {
      stored[JARGON_REVIEW_PREFIX + 'one'] = review([{ ...suggestion, status: 'dismissed' }]);
      notify([JARGON_REVIEW_PREFIX + 'one']);
    });
    await waitFor(() => expect(within(recommendations()).queryByText(registered.definition)).toBeNull());
  });

  it('focuses the review heading for keyboard navigation', async () => {
    panel({ focusSection: 'review' });
    await loaded();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: t('ext.jargon.title') }));
  });
});
