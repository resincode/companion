import { describe, expect, it, vi } from 'vitest';
import { AIError, type AIClient } from '@meetcc/ai';
import type { AnalysisRecord, Meeting } from '@meetcc/shared';
import { runPipeline, type PipelineDeps } from './pipeline';

const NOW = '2026-10-02T00:00:00Z';
const meeting: Meeting = {
  id: 'regeneration',
  meta: null,
  entries: [{ speaker: 'A', text: 'The invoice is unpaid.', time: '2026-10-01T00:00:00Z' }],
};
const prior: AnalysisRecord = {
  status: 'done',
  analysis: {
    executiveSummary: 'Previously saved summary',
    timeline: [{ time: '00:00', topic: 'Invoice' }],
    keyDiscussions: ['Payment remains outstanding'],
    decisions: [],
    actionItems: [{ task: 'Follow up', owner: 'A', due: 'Tomorrow' }],
    risks: ['Late payment'],
    openQuestions: ['When will payment arrive?'],
    nextSteps: ['Contact the customer'],
    diagrams: [],
  },
  generatedAt: '2026-10-01T00:00:00Z',
  provider: 'anthropic',
  provisional: true,
};
const replacement = { ...prior.analysis, executiveSummary: 'Regenerated summary' };

function makeDeps(initial: AnalysisRecord | null, overrides: Partial<PipelineDeps> = {}) {
  let stored = initial ? JSON.stringify(initial) : null;
  const writes: string[] = [];
  const client: AIClient = { provider: 'openai', complete: async () => JSON.stringify(replacement) };
  const deps: PipelineDeps = {
    getMeeting: async () => meeting,
    getRecord: async () => stored ? JSON.parse(stored) as AnalysisRecord : null,
    setRecord: async (_id, record) => {
      stored = JSON.stringify(record);
      writes.push(stored);
    },
    createClient: async () => client,
    audit: vi.fn(async () => {}),
    notify: vi.fn(),
    now: () => NOW,
    ...overrides,
  };
  return { deps, stored: () => stored, writes };
}

function failure(stage: 'configuration' | 'provider'): Partial<PipelineDeps> {
  return {
    createClient: async () => {
      if (stage === 'configuration') throw new Error('Provider not configured');
      return {
        provider: 'openai',
        complete: async () => { throw new AIError('Provider unavailable', false); },
      };
    },
  };
}

describe('runPipeline regeneration', () => {
  it.each(['configuration', 'provider'] as const)(
    'retains the prior done record byte-for-byte on %s failure and returns the error',
    async (stage) => {
      const { deps, stored, writes } = makeDeps(prior, failure(stage));
      const before = stored();
      const error = stage === 'configuration' ? 'Provider not configured' : 'Provider unavailable';

      expect(await runPipeline(`regeneration-${stage}`, deps, { force: true })).toEqual({
        ok: false,
        reason: 'ai-failed',
        error,
      });
      expect(stored()).toBe(before);
      // No intermediate processing/error record can clear the rendered summary.
      expect(writes).toEqual([]);
      if (stage === 'provider') {
        expect(deps.audit).toHaveBeenCalledWith('pipeline.error', `regeneration-${stage}: ${error}`);
        expect(deps.notify).toHaveBeenCalledWith(
          expect.any(String),
          `Meeting regeneration-${stage}: ${error}`,
          `regeneration-${stage}`,
        );
      }
    },
  );

  it('keeps the previous summary visible while regenerating and replaces it only on success', async () => {
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const { deps, stored, writes } = makeDeps(prior, {
      createClient: async () => ({
        provider: 'openai',
        complete: async () => {
          started();
          await pending;
          return JSON.stringify(replacement);
        },
      }),
    });
    const before = stored();
    const run = runPipeline('regeneration-success', deps, { force: true });
    await entered;
    try {
      expect(stored()).toBe(before);
      expect(writes).toEqual([]);
    } finally {
      release();
    }

    expect(await run).toEqual({ ok: true });
    const expected = {
      status: 'done',
      analysis: replacement,
      generatedAt: NOW,
      provider: 'openai',
    };
    expect(JSON.parse(stored()!)).toEqual(expected);
    expect(writes.map((record) => JSON.parse(record))).toEqual([expected]);
    expect(deps.audit).toHaveBeenCalledWith('pipeline.done', 'regeneration-success');
  });

  it.each(['configuration', 'provider'] as const)(
    'still persists an error on %s failure when there is no previous summary',
    async (stage) => {
      const { deps, stored } = makeDeps(null, failure(stage));
      const error = stage === 'configuration' ? 'Provider not configured' : 'Provider unavailable';

      expect(await runPipeline(`new-summary-${stage}`, deps)).toEqual({
        ok: false,
        reason: 'ai-failed',
        error,
      });
      expect(JSON.parse(stored()!)).toEqual({
        status: 'error',
        error,
        failedAt: NOW,
        provider: stage === 'configuration' ? 'unknown' : 'openai',
      });
    },
  );
});
