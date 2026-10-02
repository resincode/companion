import { describe, expect, it } from 'vitest';
import { jargonItemId, type Entry, type MiniContext } from '@meetcc/shared';
import { AIError, type AIClient, type CompletionRequest } from './client';
import { planJargonReview, reviewMeetingJargon } from './jargon';

const entry = (text: string, id?: string): Entry => ({ ...(id ? { id } : {}), speaker: 'A', text, time: '2026-09-01T00:00:00Z' });
const context = (id = 'unpaid', term = 'unpaid', definition = 'invoice not yet settled'): MiniContext => ({
  id, term, definition, tags: ['billing'], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
});
const match = (overrides: Record<string, unknown> = {}) => ({
  miniContextId: 'unpaid', entryId: 'E1', variant: 'raw', observed: 'unpad', reason: 'Likely ASR distortion: the customer has not paid the invoice.', ...overrides,
});
const response = (...matches: unknown[]) => JSON.stringify({ matches });
const clientOf = (complete: AIClient['complete']): AIClient => ({ provider: 'custom', complete });
const packets = (request: CompletionRequest): { transcript: Array<{ entryId: string; variant: string; text: string }>; glossary: MiniContext[] } => {
  const [transcript, glossary] = request.user.split('\n\nRegistered jargon packet (JSON data):\n');
  return { transcript: JSON.parse(transcript.split('\n').slice(1).join('\n')), glossary: JSON.parse(glossary) };
};
const longTranscript = () => Array.from({ length: 8 }, (_, i) => entry(`line ${i} ${'x'.repeat(7000)}`));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('planJargonReview', () => {
  it('preserves imported IDs and adds a clean variant only when wording differs', () => {
    const raw = [entry('unpad', 'imported-42'), entry('same')];
    const effective = [entry('unpaid', 'imported-42'), entry('same')];
    const batch = planJargonReview(raw, effective, [context()]);
    expect(JSON.parse(batch[0].transcriptPacket)).toEqual([
      { entryId: 'imported-42', variant: 'raw', text: 'unpad', speaker: 'A', time: raw[0].time },
      { entryId: 'imported-42', variant: 'clean', text: 'unpaid', speaker: 'A', time: raw[0].time },
      { entryId: 'E2', variant: 'raw', text: 'same', speaker: 'A', time: raw[1].time },
    ]);
    expect(raw[1].id).toBeUndefined();
    expect(effective[1].id).toBeUndefined();
  });

  it('counts array delimiters, commas and escaped characters at the packet boundary', () => {
    const rowSize = JSON.stringify({ entryId: 'E1', variant: 'raw', text: '', speaker: 'A', time: entry('').time }).length;
    const exact = entry('x'.repeat(12_000 - rowSize - 2));
    expect(planJargonReview([exact], [exact], [])[0].transcriptPacket.length).toBe(12_000);
    expect(() => planJargonReview([entry(exact.text + 'x')], [], [])).toThrow(AIError);
    const escaped = Array.from({ length: 5 }, () => entry('"\\\n'.repeat(900)));
    const batches = planJargonReview(escaped, escaped, []);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every(batch => batch.transcriptPacket.length <= 12_000 && batch.glossaryPacket === '[]')).toBe(true);
    expect(batches.flatMap(batch => JSON.parse(batch.transcriptPacket)).map(row => row.text)).toEqual(escaped.map(row => row.text));
  });

  it('rejects oversized glossary rows rather than dropping or truncating meanings', () => {
    const rowSize = JSON.stringify({ id: 'unpaid', term: 'unpaid', definition: '', tags: ['billing'] }).length;
    const exact = context('unpaid', 'unpaid', 'd'.repeat(12_000 - rowSize - 2));
    expect(planJargonReview([entry('unpad')], [], [exact])[0].glossaryPacket.length).toBe(12_000);
    expect(() => planJargonReview([entry('unpad')], [], [{ ...exact, definition: exact.definition + 'd' }])).toThrow(AIError);
  });

  it('evaluates the Cartesian product and scans each transcript packet once without a glossary', () => {
    const raw = longTranscript();
    const glossary = [context('a', 'A', 'a'.repeat(7000)), context('b', 'B', 'b'.repeat(7000))];
    const noGlossary = planJargonReview(raw, raw, []);
    const batches = planJargonReview(raw, raw, glossary);
    expect(batches.length).toBe(noGlossary.length * 2);
    for (const transcript of noGlossary) {
      expect(batches.filter(batch => batch.transcriptPacket === transcript.transcriptPacket).map(batch => JSON.parse(batch.glossaryPacket)[0].id)).toEqual(['a', 'b']);
    }
    expect(batches.every(batch => batch.transcriptPacket.length <= 12_000 && batch.glossaryPacket.length <= 12_000)).toBe(true);
  });
});

describe('reviewMeetingJargon', () => {
  it('grounds unpad in raw evidence and hydrates only canonical registry meaning without changing capture', async () => {
    const raw = [entry('invoice ini masih unpad, pelanggan belum membayar')];
    const before = JSON.stringify(raw);
    const items = await reviewMeetingJargon(clientOf(async () => response(match({ term: 'invented', definition: 'fabricated', sourceText: 'wrong', status: 'confirmed' }))), raw, raw, [context()]);
    expect(items).toEqual([{
      id: jargonItemId({ entryId: 'E1', variant: 'raw', observed: 'unpad', sourceText: raw[0].text }, 'unpaid'),
      origin: 'llm', status: 'suggested', miniContextId: 'unpaid', term: 'unpaid', definition: 'invoice not yet settled',
      reason: match().reason,
      evidence: [{ entryId: 'E1', variant: 'raw', observed: 'unpad', sourceText: raw[0].text }],
    }]);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('discards hallucinated IDs, absent phrases, invalid variants and malformed rows', async () => {
    const raw = [entry('invoice masih unpad')];
    const bad = [
      match({ miniContextId: 'made-up' }), match({ entryId: 'E99' }), match({ observed: 'unpaid' }),
      match({ variant: 'summary' }), match({ variant: 'clean' }), match({ observed: '   ' }),
      match({ reason: '' }), match({ miniContextId: undefined }), match({ observed: 7 }), null, 'unpad',
    ];
    expect(await reviewMeetingJargon(clientOf(async () => response(...bad)), raw, raw, [context()])).toEqual([]);
  });

  it('validates clean evidence against clean text and preserves nonpositional entry handles', async () => {
    const raw = [entry('invoice unpad', 'capture:17')];
    const effective = [entry('invoice unpaid', 'capture:17')];
    const items = await reviewMeetingJargon(clientOf(async () => response(
      match({ entryId: 'capture:17', variant: 'clean', observed: 'unpaid' }),
      match({ entryId: 'capture:17', variant: 'raw', observed: 'unpaid' }),
      match({ entryId: 'capture:17', variant: 'clean', observed: 'unpad' }),
      match({ entryId: 'E1' }),
    )), raw, effective, [context()]);
    expect(items.map(item => item.evidence)).toEqual([[{ entryId: 'capture:17', variant: 'clean', observed: 'unpaid', sourceText: 'invoice unpaid' }]]);
  });

  it('normalizes case and whitespace for occurrence deduplication, with stable tuple IDs', async () => {
    const raw = [entry('invoice masih UNPAD, kode   biru dibahas')];
    const items = await reviewMeetingJargon(clientOf(async () => response(
      match(), match({ observed: ' UNPAD ' }),
      match({ miniContextId: null, observed: 'kode biru' }), match({ miniContextId: null, observed: 'KODE   BIRU' }),
    )), raw, raw, [context()]);
    expect(items.map(item => item.id)).toEqual(['["E1","raw","unpad","unpaid"]', '["E1","raw","kode biru",null]']);
    expect(items[1].definition).toBe('');
    expect(items[1].term).toBe('kode biru');
  });

  it('preserves alternative registered meanings but suppresses null only for the same matched occurrence across packets', async () => {
    const raw = [entry('unpad lalu kode biru')];
    const glossary = [context('a', 'unpaid', 'a'.repeat(7000)), context('b', 'unpad', 'b'.repeat(7000)), context('c', 'other', 'c'.repeat(7000))];
    const items = await reviewMeetingJargon(clientOf(async request => {
      const id = packets(request).glossary[0].id;
      return response(
        match({ miniContextId: id === 'c' ? null : id }),
        match({ miniContextId: null, observed: 'kode biru' }),
        match({ miniContextId: id === 'a' ? 'b' : 'a', observed: 'kode biru' }),
      );
    }), raw, raw, glossary);
    expect(items.map(item => [item.miniContextId, item.term])).toEqual([['a', 'unpaid'], [null, 'kode biru'], ['b', 'unpad']]);
    expect(items.filter(item => item.miniContextId !== null).map(item => item.definition)).toEqual([glossary[0].definition, glossary[1].definition]);
  });

  it('finds a registered occurrence in the middle of a long transcript and rejects citations outside each packet', async () => {
    const raw = longTranscript();
    raw[4] = entry(`invoice masih unpad ${'x'.repeat(7000)}`);
    const seen: string[] = [];
    const items = await reviewMeetingJargon(clientOf(async request => {
      const { transcript } = packets(request);
      seen.push(...transcript.map(row => row.entryId));
      return response(match({ entryId: 'E5' }));
    }), raw, raw, [context()]);
    expect(seen.sort()).toEqual(['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
    expect(items.map(item => item.evidence[0].entryId)).toEqual(['E5']);
    expect(items[0].definition).toBe('invoice not yet settled');
  });

  it('allows unknown jargon without a registry and never invents its definition', async () => {
    const raw = [entry('kode biru artinya eskalasi yang disepakati tim')];
    const items = await reviewMeetingJargon(clientOf(async () => response(match({ miniContextId: null, observed: 'kode biru', definition: 'urgent escalation' }))), raw, raw, []);
    expect(items[0]).toMatchObject({ miniContextId: null, term: 'kode biru', definition: '', status: 'suggested' });
  });

  it.each(['not JSON', '{"matches":[', '{}', '{"matches":null}', '{"matches":{}}', 'null'])('fails visibly for an unusable response: %s', async bad => {
    const raw = [entry('unpad')];
    await expect(reviewMeetingJargon(clientOf(async () => bad), raw, raw, [context()])).rejects.toThrow(AIError);
  });

  it('accepts brace-wrapped JSON and a successful empty scan', async () => {
    const raw = [entry('normal conversation')];
    expect(await reviewMeetingJargon(clientOf(async () => '```json\n{"matches":[]}\n```'), raw, raw, [])).toEqual([]);
  });

  it('never exceeds two active requests while scanning all packets', async () => {
    const raw = longTranscript();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    await reviewMeetingJargon(clientOf(async () => {
      active++;
      calls++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return response();
    }), raw, raw, []);
    expect(maximum).toBe(2);
    expect(calls).toBe(planJargonReview(raw, raw, []).length);
    expect(active).toBe(0);
  });

  it('stops after a failed middle packet and awaits another active request before rejecting, never returning partial candidates', async () => {
    const raw = longTranscript();
    const second = deferred<string>();
    const middle = deferred<string>();
    const started = deferred<void>();
    let calls = 0;
    let settled = false;
    const providerError = new Error('provider unavailable');
    const review = reviewMeetingJargon(clientOf(async () => {
      const index = calls++;
      if (index === 0) return response(match({ observed: 'line', miniContextId: null }));
      if (index === 1) return second.promise;
      if (index === 2) { started.resolve(); return middle.promise; }
      throw new Error('unexpected scheduled packet');
    }), raw, raw, []);
    const outcome = review.then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await started.promise;
    middle.reject(providerError);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toBe(3);
    second.resolve(response());
    expect(await outcome).toEqual({ error: providerError });
    expect(calls).toBe(3);
  });

  it('also drains the active request when JSON validation fails', async () => {
    const raw = longTranscript();
    const active = deferred<string>();
    let calls = 0;
    let settled = false;
    const review = reviewMeetingJargon(clientOf(async () => calls++ === 0 ? '{}' : active.promise), raw, raw, []);
    const outcome = review.then(() => undefined, error => error as Error).finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toBe(2);
    active.resolve(response());
    expect(await outcome).toBeInstanceOf(AIError);
    expect(calls).toBe(2);
  });

  it('rejects an oversized input before any provider call', async () => {
    let calls = 0;
    const raw = [entry('x'.repeat(12_000))];
    await expect(reviewMeetingJargon(clientOf(async () => { calls++; return response(); }), raw, raw, [])).rejects.toThrow(AIError);
    expect(calls).toBe(0);
  });
});
