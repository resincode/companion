import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendAudit,
  clearMeeting,
  ensureReleaseT0,
  getReleaseT0,
  loadAudit,
  loadDashboard,
  loadSettings,
  matchesPrefixes,
  parseAnalyses,
  parseMeetings,
  parseTitles,
  saveTitle,
  getContext,
  saveContext,
  getMeetingTags,
  saveMeetingTags,
  getMiniContexts,
  saveMiniContexts,
  getJargonReview,
  saveJargonReview,
  JARGON_REVIEW_PREFIX,
  watchStorage,
  ANALYSIS_PREFIX,
  AUDIT_KEY,
  AUDIT_RING_MAX,
  CONTEXT_PREFIX,
  MEETING_TAGS_PREFIX,
  META_PREFIX,
  MINI_CONTEXTS_KEY,
  TITLE_PREFIX,
  GOALS_PREFIX,
  getGoals,
  saveGoals,
  TRANSCRIPT_PREFIX,
  WATCH_DEBOUNCE_MS,
} from './storage';
import type { MeetingJargonReview } from './types';

const entry = (text: string, time: string) => ({ speaker: 'A', text, time });

const RAW: Record<string, unknown> = {
  [TRANSCRIPT_PREFIX + 'old']: [entry('x', '2026-01-01T01:00:00Z')],
  [TRANSCRIPT_PREFIX + 'new']: [entry('y', '2026-07-01T01:00:00Z')],
  [META_PREFIX + 'new']: { id: 'new', startedAt: '2026-07-01T01:00:00Z', lastSeenAt: '2026-07-01T02:00:00Z' },
  [ANALYSIS_PREFIX + 'new']: {
    status: 'done',
    provider: 'openai',
    generatedAt: '2026-07-01T03:00:00Z',
    analysis: { executiveSummary: 'ok' },
  },
  [TITLE_PREFIX + 'new']: 'Sprint planning',
  [TITLE_PREFIX + 'blank']: '',
  settings: { provider: 'openai', apiKey: '', baseUrl: '', model: 'gpt-4o-mini' },
};

// in-memory chrome stub; `get(null)` returns everything, like the real API
let store: Record<string, unknown>;
let getCalls: number;
let listeners: Array<(changes: Record<string, unknown>) => void>;

beforeEach(() => {
  vi.useFakeTimers();
  store = { ...RAW };
  getCalls = 0;
  listeners = [];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string | null) => {
          getCalls++;
          return key === null ? { ...store } : { [key]: store[key] };
        },
        set: async (obj: Record<string, unknown>) => void Object.assign(store, obj),
        remove: async (key: string | string[]) => {
          for (const k of [key].flat()) delete store[k];
        },
      },
      onChanged: {
        addListener: (fn: (c: Record<string, unknown>) => void) => void listeners.push(fn),
        removeListener: (fn: (c: Record<string, unknown>) => void) => {
          listeners = listeners.filter((l) => l !== fn);
        },
      },
    },
  });
});

const emit = (...keys: string[]) => {
  const changes = Object.fromEntries(keys.map((k) => [k, { newValue: 1 }]));
  for (const l of [...listeners]) l(changes);
};

describe('parsers', () => {
  it('groups transcript + meta into meetings, newest start first', () => {
    const meetings = parseMeetings(RAW);
    expect(meetings.map((m) => m.id)).toEqual(['new', 'old']);
    expect(meetings[0].entries).toHaveLength(1);
    expect(meetings[0].meta?.startedAt).toBe('2026-07-01T01:00:00Z');
  });

  it('reads analyses and titles, skipping blank titles', () => {
    expect(Object.keys(parseAnalyses(RAW))).toEqual(['new']);
    expect(parseTitles(RAW)).toEqual({ new: 'Sprint planning' });
  });

  it('parses context and gets/saves context', async () => {
    const rawWithCtx = {
      ...RAW,
      [CONTEXT_PREFIX + 'new']: 'Sprint goal: finish checkout',
    };
    const meetings = parseMeetings(rawWithCtx);
    expect(meetings[0].context).toBe('Sprint goal: finish checkout');

    await saveContext('new', 'Updated goal');
    expect(await getContext('new')).toBe('Updated goal');

    await saveContext('new', '   ');
    expect(await getContext('new')).toBe('');
  });

  it('parses and manages meeting tags in storage', async () => {
    const rawWithTags = {
      ...RAW,
      [MEETING_TAGS_PREFIX + 'new']: ['backend', 'infra'],
    };
    const meetings = parseMeetings(rawWithTags);
    expect(meetings[0].tags).toEqual(['backend', 'infra']);

    await saveMeetingTags('new', ['security', 'compliance']);
    expect(await getMeetingTags('new')).toEqual(['security', 'compliance']);

    await saveMeetingTags('new', []);
    expect(await getMeetingTags('new')).toEqual([]);
  });

  it('manages mini contexts in storage', async () => {
    expect(MINI_CONTEXTS_KEY).toBe('mini_contexts');
    expect(await getMiniContexts()).toEqual([]);
    const item = {
      id: 'ctx-1',
      term: 'P95',
      definition: '95th percentile latency',
      tags: ['infra', 'latency'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveMiniContexts([item]);
    expect(await getMiniContexts()).toEqual([item]);
  });
});

describe('loadDashboard', () => {
  it('builds every view from a single full-storage read', async () => {
    const d = await loadDashboard();
    expect(getCalls).toBe(1);
    expect(d.meetings.map((m) => m.id)).toEqual(['new', 'old']);
    expect(d.records.new.status).toBe('done');
    expect(d.titles).toEqual({ new: 'Sprint planning' });
  });
});

describe('matchesPrefixes', () => {
  it('matches everything when no prefixes are given', () => {
    expect(matchesPrefixes(['anything'])).toBe(true);
    expect(matchesPrefixes(['anything'], [])).toBe(true);
  });

  it('matches only the requested prefixes', () => {
    expect(matchesPrefixes([TRANSCRIPT_PREFIX + 'a'], [TRANSCRIPT_PREFIX])).toBe(true);
    expect(matchesPrefixes(['docs:a', TRANSCRIPT_PREFIX + 'a'], [TRANSCRIPT_PREFIX])).toBe(true);
    expect(matchesPrefixes(['docs:a'], [TRANSCRIPT_PREFIX, META_PREFIX])).toBe(false);
  });
});

describe('watchStorage', () => {
  it('coalesces a burst of writes into one callback', () => {
    const onChange = vi.fn();
    watchStorage(onChange);
    for (let i = 0; i < 20; i++) emit(TRANSCRIPT_PREFIX + 'new');
    expect(onChange).not.toHaveBeenCalled(); // nothing fires synchronously
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores changes outside the watched prefixes', () => {
    const onChange = vi.fn();
    watchStorage(onChange, [ANALYSIS_PREFIX]);
    emit(TRANSCRIPT_PREFIX + 'new');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    emit(ANALYSIS_PREFIX + 'new');
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('stops firing and drops a pending callback after unsubscribe', () => {
    const onChange = vi.fn();
    const stop = watchStorage(onChange);
    emit(TRANSCRIPT_PREFIX + 'new');
    stop();
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });
});

describe('saveTitle', () => {
  it('stores a trimmed title and removes the override when blanked', async () => {
    await saveTitle('new', '  Retro Q3  ');
    expect(store[TITLE_PREFIX + 'new']).toBe('Retro Q3');
    await saveTitle('new', '   ');
    expect(store[TITLE_PREFIX + 'new']).toBeUndefined();
  });
});

describe('loadSettings retention', () => {
  it('defaults to keeping data forever', async () => {
    expect((await loadSettings()).retentionDays).toBe(0);
  });

  it('falls back to 0 for values that are not a positive number', async () => {
    for (const bad of ['90', -5, Number.NaN, Infinity, null]) {
      store.settings = { ...(RAW.settings as object), retentionDays: bad };
      expect((await loadSettings()).retentionDays).toBe(0);
    }
  });

  it('keeps a valid window, floored to whole days', async () => {
    store.settings = { ...(RAW.settings as object), retentionDays: 90.7 };
    expect((await loadSettings()).retentionDays).toBe(90);
  });
});

describe('audit ring (§32.1 W3)', () => {
  const ev = (i: number) => ({ time: new Date(i * 1000).toISOString(), event: 'test', detail: String(i) });

  it('keeps 201 events — the old 200-slot ring would have evicted the first export', async () => {
    for (let i = 0; i < 201; i++) await appendAudit('test', String(i));
    const log = await loadAudit();
    expect(log).toHaveLength(201);
    expect(log[0].detail).toBe('0');
  });

  it('evicts only the oldest rows past AUDIT_RING_MAX (5.000)', async () => {
    store[AUDIT_KEY] = Array.from({ length: AUDIT_RING_MAX - 1 }, (_, i) => ev(i));
    await appendAudit('test', 'second-to-last');
    await appendAudit('test', 'last');
    const log = await loadAudit();
    expect(log).toHaveLength(AUDIT_RING_MAX);
    expect(log[0].detail).toBe('1'); // seed[0] evicted, seed[1] survives
    expect(log.at(-1)?.detail).toBe('last');
  });

  it('holds the whole 14-day gate window at a realistic event rate', async () => {
    // ~50 events/day of active use (ask, clean, docgen, retention, …) × 14
    // days = 700 — far below the cap, so export.obsidian rows survive to the
    // gate review even after weeks of heavy usage (audit F3).
    store[AUDIT_KEY] = Array.from({ length: 700 }, (_, i) => ev(i));
    await appendAudit('export.obsidian', 'meetings=3');
    const log = await loadAudit();
    expect(log).toHaveLength(701);
    expect(log.at(-1)?.event).toBe('export.obsidian');
  });
});

describe('release T0 (§32.1 gate anchor)', () => {
  it('is unset until the first call', async () => {
    expect(await getReleaseT0()).toBeNull();
  });

  it('stamps the given time once, then keeps returning it', async () => {
    expect(await ensureReleaseT0(1000)).toBe(1000);
    expect(await ensureReleaseT0(2000)).toBe(1000); // already set, second call is a no-op
    expect(await getReleaseT0()).toBe(1000);
  });
});
describe('goals', () => {
  it('saves and retrieves goals', async () => {
    await saveGoals('m1', ['Align on Q4 roadmap', 'Assign owners']);
    expect(await getGoals('m1')).toEqual(['Align on Q4 roadmap', 'Assign owners']);
  });

  it('returns an empty array when no goals are stored', async () => {
    expect(await getGoals('missing')).toEqual([]);
  });

  it('removes goals when saving an empty list', async () => {
    await saveGoals('m1', ['Goal 1']);
    await saveGoals('m1', []);
    expect(await getGoals('m1')).toEqual([]);
    expect(store[GOALS_PREFIX + 'm1']).toBeUndefined();
  });

  it('parses goals from a storage dump', () => {
    const raw: Record<string, unknown> = {
      [TRANSCRIPT_PREFIX + 'm1']: [entry('hello', '2026-01-01T01:00:00Z')],
      [META_PREFIX + 'm1']: { id: 'm1', startedAt: '2026-01-01T01:00:00Z', lastSeenAt: '2026-01-01T02:00:00Z' },
      [GOALS_PREFIX + 'm1']: ['Goal A', 'Goal B'],
    };
    const meetings = parseMeetings(raw);
    expect(meetings[0].goals).toEqual(['Goal A', 'Goal B']);
  });
});

describe('meeting jargon review', () => {
  const review: MeetingJargonReview = {
    status: 'done',
    updatedAt: '2026-09-01T02:00:00Z',
    reviewedAt: '2026-09-01T02:00:00Z',
    reviewedEntryCount: 1,
    items: [
      {
        id: '["E1","raw","unpad","ctx_unpaid"]',
        origin: 'llm',
        status: 'confirmed',
        miniContextId: 'ctx_unpaid',
        term: 'unpaid',
        definition: 'invoice not yet settled',
        reason: 'The customer has not paid.',
        evidence: [
          {
            entryId: 'E1',
            variant: 'raw',
            sourceText: 'invoice ini masih unpad, pelanggan belum membayar',
            observed: 'unpad',
          },
        ],
      },
    ],
  };

  it('distinguishes an absent review from a completed scan with no suggestions', async () => {
    expect(await getJargonReview('missing')).toBeNull();
    const emptyReview: MeetingJargonReview = { ...review, items: [] };
    await saveJargonReview('missing', emptyReview);
    expect(await getJargonReview('missing')).toEqual(emptyReview);
  });

  it('retains confirmed definitions and evidence independently of registry changes', async () => {
    await saveJargonReview('new', review);
    await saveMiniContexts([
      {
        id: 'ctx_unpaid',
        term: 'unpaid',
        definition: 'a later registry definition',
        tags: [],
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
      },
    ]);
    expect(await getJargonReview('new')).toEqual(review);
    await saveMiniContexts([]);
    expect(await getJargonReview('new')).toEqual(review);
  });

  it('removes the review with its meeting without removing another meeting review', async () => {
    await saveJargonReview('new', review);
    await saveJargonReview('old', review);
    await clearMeeting('new');
    expect(await getJargonReview('new')).toBeNull();
    expect(store[JARGON_REVIEW_PREFIX + 'new']).toBeUndefined();
    expect(store[TRANSCRIPT_PREFIX + 'new']).toBeUndefined();
    expect(await getJargonReview('old')).toEqual(review);
    expect(store[TRANSCRIPT_PREFIX + 'old']).toEqual(RAW[TRANSCRIPT_PREFIX + 'old']);
  });
});
