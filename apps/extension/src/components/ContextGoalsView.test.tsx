// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '@meetcc/shared/i18n';
import {
  CONTEXT_PREFIX, GOALS_PREFIX, MEETING_TAGS_PREFIX, CLEAN_PREFIX, MINI_CONTEXTS_KEY,
  type Meeting,
} from '@meetcc/shared';
import { ContextGoalsView } from './ContextGoalsView';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const meeting = (id = 'one'): Meeting => ({
  id, meta: null,
  entries: [{ speaker: 'A', time: '2026-09-01T10:00:00.000Z', text: 'Discuss payment' }],
});
let stored: Record<string, unknown>;
let listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
const sendMessage = vi.fn();
const get = vi.fn();
const set = vi.fn();
const remove = vi.fn();
const navigation = { onViewEvidence: vi.fn(), onClarifyEvidence: vi.fn(), onClarifyTerm: vi.fn() };

function notify(keys: string[]) {
  const changes = Object.fromEntries(keys.map((key) => [key, { newValue: stored[key] }]));
  for (const listener of listeners) listener(changes, 'local');
}

function renderEditor(value = meeting()) {
  return render(<ContextGoalsView meeting={value} record={null} live={false} {...navigation} />);
}

async function loaded() {
  await screen.findByText(t('ext.context.saved'));
}

async function addGoal(value: string) {
  await userEvent.type(screen.getByLabelText(t('ext.context.goalLabel')), value);
  await userEvent.click(screen.getByRole('button', { name: t('ext.context.add') }));
}

function saveButton() {
  return screen.getByRole('button', { name: t('ext.context.save') });
}
function applyButton() {
  return screen.getByRole('button', { name: t('ext.context.applyToSummary') });
}

beforeEach(() => {
  setLang('en');
  stored = {};
  listeners = new Set();
  sendMessage.mockReset().mockResolvedValue({ ok: true, goals: ['Suggested target'], changed: 1 });
  get.mockReset().mockImplementation(async (key: string) => ({ [key]: stored[key] }));
  set.mockReset().mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(stored, values);
    notify(Object.keys(values));
  });
  remove.mockReset().mockImplementation(async (key: string) => {
    delete stored[key];
    notify([key]);
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: { get, set, remove },
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

describe('saved context editor', () => {
  it('does not apply old persisted goals until the draft is saved', async () => {
    renderEditor();
    await loaded();
    await addGoal('Agree a payment deadline');
    expect((applyButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('ext.context.applyToClean') }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: t('ext.context.suggestGoals') }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(applyButton());
    expect(sendMessage).not.toHaveBeenCalled();
    await userEvent.click(saveButton());
    await loaded();
    expect(stored[GOALS_PREFIX + 'one']).toEqual(['Agree a payment deadline']);
    await userEvent.click(applyButton());
    expect(sendMessage).toHaveBeenCalledWith({ type: 'regenerate', meetingId: 'one' });
  });

  it('keeps the draft and shows a save failure instead of claiming saved', async () => {
    renderEditor();
    await loaded();
    await addGoal('Keep this target');
    set.mockRejectedValueOnce(new Error('Storage quota exceeded'));
    await userEvent.click(saveButton());
    expect((await screen.findByRole('alert')).textContent).toContain('Storage quota exceeded');
    expect(screen.getByText('Keep this target')).toBeTruthy();
    expect(screen.queryByText(t('ext.context.saved'))).toBeNull();
    expect((applyButton() as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton()).toHaveProperty('disabled', false);
    await userEvent.click(saveButton());
    await loaded();
    expect(stored[GOALS_PREFIX + 'one']).toEqual(['Keep this target']);
  });

  it('does not autosave context or attached terms from the controlled card', async () => {
    stored[CONTEXT_PREFIX + 'one'] = 'Saved context';
    stored[MINI_CONTEXTS_KEY] = [{
      id: 'invoice', term: 'unpaid', definition: 'Invoice not yet settled', tags: ['finance'],
      createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
    }];
    renderEditor();
    await loaded();
    const input = screen.getByLabelText(t('ext.context.contextLabel'));
    await userEvent.clear(input);
    await userEvent.type(input, 'Draft context');
    await userEvent.tab();
    await userEvent.click(screen.getByRole('button', { name: /\+ #finance/ }));
    expect(stored[MEETING_TAGS_PREFIX + 'one']).toBeUndefined();
    expect(stored[CONTEXT_PREFIX + 'one']).toBe('Saved context');
    expect(set).not.toHaveBeenCalled();
    await userEvent.click(saveButton());
    await loaded();
    expect(stored[CONTEXT_PREFIX + 'one']).toBe('Draft context');
    expect(stored[MEETING_TAGS_PREFIX + 'one']).toEqual(['finance']);
  });

  it('keeps dirty edits on external changes, then reloads only on explicit discard', async () => {
    renderEditor();
    await loaded();
    await addGoal('Local goal');
    await act(async () => {
      stored[GOALS_PREFIX + 'one'] = ['External goal'];
      stored[MEETING_TAGS_PREFIX + 'one'] = ['external tag'];
      notify([GOALS_PREFIX + 'one', MEETING_TAGS_PREFIX + 'one']);
    });
    expect(await screen.findByText(t('ext.context.conflict'))).toBeTruthy();
    expect(screen.getByText('Local goal')).toBeTruthy();
    expect(screen.queryByText('External goal')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: t('ext.context.reloadSaved') }));
    expect(screen.getByText('External goal')).toBeTruthy();
    expect(screen.queryByText('Local goal')).toBeNull();
    await loaded();
    await userEvent.click(applyButton());
    expect(stored[MEETING_TAGS_PREFIX + 'one']).toEqual(['external tag']);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'regenerate', meetingId: 'one' });
  });

  it('acknowledges an external baseline without persisting kept edits until Save', async () => {
    renderEditor();
    await loaded();
    await addGoal('My goal');
    await act(async () => {
      stored[GOALS_PREFIX + 'one'] = ['Header goal'];
      notify([GOALS_PREFIX + 'one']);
    });
    await screen.findByText(t('ext.context.conflict'));
    await userEvent.click(screen.getByRole('button', { name: t('ext.context.keepEdits') }));
    expect(stored[GOALS_PREFIX + 'one']).toEqual(['Header goal']);
    expect(screen.getByText('My goal')).toBeTruthy();
    expect((applyButton() as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(saveButton());
    await loaded();
    expect(stored[GOALS_PREFIX + 'one']).toEqual(['My goal']);
  });

  it('reloads a clean draft on external edits and ignores other meeting keys', async () => {
    renderEditor();
    await loaded();
    await act(async () => {
      stored[GOALS_PREFIX + 'one'] = ['External goal'];
      notify([GOALS_PREFIX + 'one']);
    });
    expect(await screen.findByText('External goal')).toBeTruthy();
    expect(screen.queryByText(t('ext.context.conflict'))).toBeNull();
    get.mockClear();
    await act(async () => { notify([GOALS_PREFIX + 'one-other']); });
    expect(get).not.toHaveBeenCalled();
  });

  it('ignores intermediate self-save notifications until every field is persisted', async () => {
    const finalWrite = deferred<void>();
    const write = set.getMockImplementation()!;
    set.mockImplementation(async (values: Record<string, unknown>) => {
      if (GOALS_PREFIX + 'one' in values) await finalWrite.promise;
      await write(values);
    });
    renderEditor();
    await loaded();
    await userEvent.type(screen.getByLabelText(t('ext.context.contextLabel')), 'Context draft');
    await addGoal('Goal draft');
    await userEvent.click(saveButton());
    await waitFor(() => expect(stored[CONTEXT_PREFIX + 'one']).toBe('Context draft'));
    expect(screen.queryByText(t('ext.context.conflict'))).toBeNull();
    expect(screen.getByText('Goal draft')).toBeTruthy();
    expect(screen.queryByText(t('ext.context.saved'))).toBeNull();
    await act(async () => { finalWrite.resolve(); });
    await loaded();
    expect(stored[GOALS_PREFIX + 'one']).toEqual(['Goal draft']);
  });

  it('does not clobber edits made before initial storage reads resolve', async () => {
    const pending = deferred<Record<string, unknown>>();
    get.mockImplementation((key: string) => key === GOALS_PREFIX + 'one'
      ? pending.promise : Promise.resolve({ [key]: stored[key] }));
    renderEditor();
    await addGoal('Started typing early');
    await act(async () => { pending.resolve({ [GOALS_PREFIX + 'one']: ['Older saved goal'] }); });
    await screen.findByText(t('ext.context.conflict'));
    expect(screen.getByText('Started typing early')).toBeTruthy();
    expect(screen.queryByText('Older saved goal')).toBeNull();
  });

  it('isolates goal suggestions and apply responses when navigating to another meeting', async () => {
    const suggestions = deferred<{ ok: boolean; goals: string[] }>();
    sendMessage.mockReturnValueOnce(suggestions.promise);
    const view = renderEditor();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: t('ext.context.suggestGoals') }));
    view.rerender(<ContextGoalsView meeting={meeting('two')} record={null} live={false} {...navigation} />);
    await loaded();
    await act(async () => { suggestions.resolve({ ok: true, goals: ['Old meeting suggestion'] }); });
    expect(screen.queryByText('Old meeting suggestion')).toBeNull();
    const applyResult = deferred<{ ok: boolean; error: string }>();
    sendMessage.mockReturnValueOnce(applyResult.promise);
    await userEvent.click(applyButton());
    view.rerender(<ContextGoalsView meeting={meeting('three')} record={null} live={false} {...navigation} />);
    await loaded();
    await act(async () => { applyResult.resolve({ ok: false, error: 'Old meeting failure' }); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((applyButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('cancels remaining writes and isolates save errors after switching meeting', async () => {
    const pendingWrite = deferred<void>();
    set.mockReturnValueOnce(pendingWrite.promise);
    const view = renderEditor();
    await loaded();
    await userEvent.type(screen.getByLabelText(t('ext.context.contextLabel')), 'Old draft');
    await addGoal('Old goal');
    await userEvent.click(saveButton());
    view.rerender(<ContextGoalsView meeting={meeting('two')} record={null} live={false} {...navigation} />);
    await loaded();
    await act(async () => { pendingWrite.reject(new Error('Old save error')); });
    expect(screen.queryByText('Old goal')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(stored[GOALS_PREFIX + 'one']).toBeUndefined();
    expect((applyButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it('starts cleanup from scratch and only blocks a genuinely active clean run', async () => {
    stored[CLEAN_PREFIX + 'one'] = {
      status: 'processing', updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      done: 1, total: 3, entries: [],
    };
    renderEditor();
    await loaded();
    const button = screen.getByRole('button', { name: t('ext.context.applyToClean') });
    await waitFor(() => expect(button).toHaveProperty('disabled', true));
    await act(async () => {
      stored[CLEAN_PREFIX + 'one'] = {
        status: 'processing', updatedAt: new Date(Date.now() - 61_000).toISOString(),
        startedAt: new Date(Date.now() - 61_000).toISOString(), done: 1, total: 3, entries: [],
      };
      notify([CLEAN_PREFIX + 'one']);
    });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    await userEvent.click(button);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'clean-transcript', meetingId: 'one', fromScratch: true });
  });
});
