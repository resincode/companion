// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLang, t } from '@meetcc/shared/i18n';
import {
  JARGON_REVIEW_PREFIX,
  MINI_CONTEXTS_KEY,
  jargonItemId,
  type JargonEvidence,
  type Meeting,
  type MeetingJargonItem,
  type MeetingJargonReview,
  type MiniContext,
} from '@meetcc/shared';
import { JargonClarificationForm } from './JargonClarificationForm';

const timestamp = '2026-10-01T10:00:00.000Z';

const meeting: Meeting = {
  id: 'one',
  meta: null,
  entries: [
    { speaker: 'A', time: '2026-09-01T10:00:00.000Z', text: 'invoice ini masih unpad, pelanggan belum membayar' },
    { speaker: 'B', time: '2026-09-01T10:00:05.000Z', text: 'kode biru artinya eskalasi yang disepakati tim' },
  ],
};

const seed: JargonEvidence = {
  entryId: 'E1',
  variant: 'raw',
  sourceText: meeting.entries[0].text,
  observed: 'unpad',
};

const unpaid: MiniContext = {
  id: 'ctx-unpaid',
  term: 'unpaid',
  definition: 'invoice not yet settled',
  tags: ['finance'],
  createdAt: timestamp,
  updatedAt: timestamp,
};

let stored: Record<string, unknown>;
let listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
const sendMessage = vi.fn();

function notify(keys: string[]) {
  const changes = Object.fromEntries(keys.map((key) => [key, { newValue: stored[key] }]));
  for (const listener of listeners) listener(changes, 'local');
}

function readReview(): MeetingJargonReview {
  return (
    (stored[JARGON_REVIEW_PREFIX + 'one'] as MeetingJargonReview | undefined) ?? {
      status: 'done',
      updatedAt: timestamp,
      items: [],
    }
  );
}

/** Minimal stand-in for the worker mutation used by the real message route. */
function applyUpdate(action: { type: string; item?: MeetingJargonItem; itemId?: string }): MeetingJargonReview {
  const review = readReview();
  const registry = (stored[MINI_CONTEXTS_KEY] as MiniContext[] | undefined) ?? [];
  let items = review.items;
  if (action.type === 'confirm' && action.item) {
    const source = action.item;
    const context = source.miniContextId ? registry.find((item) => item.id === source.miniContextId) : undefined;
    const id = jargonItemId(source.evidence[0], source.miniContextId);
    items = [
      ...items.filter((item) => item.id !== id),
      {
        ...source,
        id,
        status: 'confirmed' as const,
        term: (context?.term ?? source.term).trim(),
        definition: (context?.definition ?? source.definition).trim(),
      },
    ];
  } else if (action.type === 'remove' && action.itemId) {
    items = items.filter((item) => item.id !== action.itemId);
  }
  const next: MeetingJargonReview = { ...review, updatedAt: timestamp, items };
  stored[JARGON_REVIEW_PREFIX + 'one'] = next;
  notify([JARGON_REVIEW_PREFIX + 'one']);
  return next;
}

function renderForm(overrides: Partial<Parameters<typeof JargonClarificationForm>[0]> = {}) {
  return render(
    <JargonClarificationForm
      meeting={meeting}
      seed={seed}
      registry={[unpaid]}
      onCancel={vi.fn()}
      onSaved={vi.fn()}
      onRegister={vi.fn().mockResolvedValue({ ok: true })}
      {...overrides}
    />,
  );
}

function phraseField() {
  return screen.getByLabelText(t('ext.jargon.clarifyPhrase')) as HTMLInputElement;
}
function meaningField() {
  return screen.getByLabelText(t('ext.jargon.clarifyMeaning')) as HTMLTextAreaElement;
}
function saveButton() {
  return screen.getByRole('button', { name: t('ext.jargon.clarifySave') });
}
async function selectRegistryTerm() {
  const card = screen.getByText('unpaid').closest('article') as HTMLElement;
  await userEvent.click(within(card).getByRole('button'));
}

beforeEach(() => {
  setLang('en');
  stored = { [MINI_CONTEXTS_KEY]: [unpaid] };
  listeners = new Set();
  sendMessage.mockReset().mockImplementation(async (message: { type: string; meetingId: string; action: { type: string } }) => {
    if (message.type !== 'update-jargon-review') return { ok: true };
    applyUpdate(message.action as never);
    return { ok: true };
  });
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
          notify(Object.keys(values));
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key];
          notify([key]);
        }),
      },
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

describe('jargon clarification form', () => {
  it('prefills the seeded phrase and focuses it', () => {
    renderForm();
    expect(phraseField().value).toBe('unpad');
    expect(document.activeElement).toBe(phraseField());
  });

  it('rejects wording absent from the selected line without sending anything', async () => {
    renderForm();
    await userEvent.clear(phraseField());
    await userEvent.type(phraseField(), 'tidak-ada');
    await selectRegistryTerm();
    await userEvent.click(saveButton());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(phraseField().value).toBe('tidak-ada');
    expect(readReview().items).toHaveLength(0);
  });

  it('fills a read-only registered definition and confirms the real occurrence', async () => {
    renderForm();
    await selectRegistryTerm();
    const definition = screen.getByLabelText(t('ext.jargon.clarifyDefinition')) as HTMLTextAreaElement;
    expect(definition.value).toBe('invoice not yet settled');
    expect(definition.readOnly).toBe(true);
    await userEvent.click(saveButton());
    await waitFor(() => expect(readReview().items).toHaveLength(1));
    const [item] = readReview().items;
    expect(item.miniContextId).toBe('ctx-unpaid');
    expect(item.definition).toBe('invoice not yet settled');
    expect(item.evidence[0].observed).toBe('unpad');
  });

  it('requires a user-written meaning for a meeting-only term', async () => {
    renderForm();
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyMeetingOnly') }));
    await userEvent.click(saveButton());
    expect(sendMessage).not.toHaveBeenCalled();
    expect(meaningField().value).toBe('');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('keeps the form and re-enables save when storage fails', async () => {
    renderForm();
    await selectRegistryTerm();
    sendMessage.mockResolvedValueOnce({ ok: false, error: 'quota exceeded' });
    await userEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(phraseField().value).toBe('unpad');
    expect((screen.getByRole('button', { name: t('ext.jargon.clarifySave') }) as HTMLButtonElement).disabled).toBe(false);
    expect(readReview().items).toHaveLength(0);
  });

  it('disables save while the confirmation is in flight', async () => {
    let resolve!: (value: unknown) => void;
    const gate = new Promise<unknown>((done) => { resolve = done; });
    sendMessage.mockImplementationOnce(() => gate as never);
    renderForm();
    await selectRegistryTerm();
    await userEvent.click(saveButton());
    const pending = screen.getByRole('button', { name: t('ext.jargon.clarifySaving') }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    resolve({ ok: false, error: 'stop' });
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('confirms an existing registered entry on duplicate promotion without overwriting it', async () => {
    const onRegister = vi.fn().mockResolvedValue({ ok: false, error: 'duplicate', existingMiniContextId: 'ctx-unpaid' });
    renderForm({ onRegister });
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyMeetingOnly') }));
    await userEvent.clear(screen.getByLabelText(t('ext.jargon.clarifyMeetingOnly')));
    await userEvent.type(screen.getByLabelText(t('ext.jargon.clarifyMeetingOnly')), 'unpaid');
    await userEvent.type(meaningField(), 'this team means settled later');
    await userEvent.click(saveButton());
    await screen.findByRole('button', { name: t('ext.jargon.clarifyRegister') });
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyRegister') }));
    expect(onRegister).toHaveBeenCalledTimes(1);
    const existing = screen.getByLabelText(t('ext.jargon.clarifyExistingDefinition')) as HTMLTextAreaElement;
    expect(existing.value).toBe('invoice not yet settled');
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyDuplicateConfirm') }));
    await waitFor(() => expect(readReview().items[0].miniContextId).toBe('ctx-unpaid'));
    expect(readReview().items[0].definition).toBe('invoice not yet settled');
    expect((stored[MINI_CONTEXTS_KEY] as MiniContext[])[0].definition).toBe('invoice not yet settled');
  });

  it('selects a transcript line first and confirms the phrase from it without a seed', async () => {
    renderForm({ seed: undefined });
    await userEvent.click(screen.getByRole('button', { name: /kode biru/ }));
    await userEvent.type(phraseField(), 'kode biru');
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyMeetingOnly') }));
    await userEvent.type(screen.getByLabelText(t('ext.jargon.clarifyMeetingOnly')), 'blue code');
    await userEvent.type(meaningField(), 'urgent escalation for this team');
    await userEvent.click(saveButton());
    await waitFor(() => expect(readReview().items).toHaveLength(1));
    const [item] = readReview().items;
    expect(item.evidence[0].entryId).toBe('E2');
    expect(item.evidence[0].observed).toBe('kode biru');
    expect(item.miniContextId).toBeNull();
  });

  it('returns focus to the control that opened it on cancel', async () => {
    const onCancel = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type='button' onClick={() => setOpen(true)}>Open clarification</button>
          {open && (
            <JargonClarificationForm
              meeting={meeting}
              seed={seed}
              registry={[unpaid]}
              onCancel={onCancel}
              onSaved={vi.fn()}
              onRegister={vi.fn().mockResolvedValue({ ok: true })}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open clarification' });
    await userEvent.click(opener);
    await screen.findByLabelText(t('ext.jargon.clarifyPhrase'));
    await userEvent.click(screen.getByRole('button', { name: t('ext.jargon.clarifyCancel') }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });
});
