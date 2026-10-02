import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { planJargonReview } from '@meetcc/ai';
import type { JargonReviewAction } from '@meetcc/meeting';
import {
  CLEAN_PREFIX, JARGON_REVIEW_PREFIX, MINI_CONTEXTS_KEY,
  effectiveClean, entriesById, getJargonReview, getMiniContexts,
  isJargonEvidenceValid, loadClean, resolveMeetingMiniContexts, withEntryIds,
  type CleanRecord, type Entry, type JargonEvidence, type Meeting,
  type MeetingJargonItem, type MeetingJargonReview, type MiniContext,
} from '@meetcc/shared';
import { locale, t } from '@meetcc/shared/i18n';
import { Button, TextInput } from '@meetcc/ui';

export interface MeetingJargonPanelProps {
  meeting: Meeting;
  live: boolean;
  disabled: boolean;
  tags: string[];
  onViewEvidence(evidence: JargonEvidence): void;
  onClarifyEvidence(evidence: JargonEvidence): void;
  onAttachTerm(term: string): void;
  onClarifyTerm?(): void;
  focusSection?: 'review' | 'clarify';
}

export function MeetingJargonPanel(props: MeetingJargonPanelProps) {
  return <JargonPanel key={props.meeting.id} {...props} />;
}

function EvidenceQuote({ evidence, raw, effective, onViewEvidence }: {
  evidence: JargonEvidence;
  raw: Entry[];
  effective: Entry[];
  onViewEvidence(evidence: JargonEvidence): void;
}) {
  const original = entriesById(raw).get(evidence.entryId);
  const cleaned = entriesById(effective).get(evidence.entryId);
  const valid = isJargonEvidenceValid(evidence, raw, effective);
  const differs = original && cleaned && original.text !== cleaned.text;
  return (
    <div className="jargon-evidence">
      {original && <p className="jargon-meta">
        {original.speaker} · {new Date(original.time).toLocaleTimeString(locale(), {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        })}
      </p>}
      <p className="jargon-meta">{evidence.variant === 'raw' ? t('ext.jargon.raw') : t('ext.jargon.clean')}</p>
      <blockquote>{evidence.sourceText}</blockquote>
      {differs && <div className="jargon-wording">
        <p><strong>{t('ext.jargon.raw')}</strong> {original.text}</p>
        <p><strong>{t('ext.jargon.clean')}</strong> {cleaned.text}</p>
      </div>}
      {!valid && <p className="jargon-notice">{t('ext.jargon.staleEvidence')}</p>}
      <Button type="button" className="small" disabled={!valid} onClick={() => onViewEvidence(evidence)}>
        {t('ext.jargon.viewTranscript')}
      </Button>
    </div>
  );
}

function JargonPanel({
  meeting, live, disabled, tags, onViewEvidence, onClarifyEvidence,
  onAttachTerm, onClarifyTerm, focusSection,
}: MeetingJargonPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const searchId = useId();
  const [review, setReview] = useState<MeetingJargonReview | null>(null);
  const [registry, setRegistry] = useState<MiniContext[]>([]);
  const [clean, setClean] = useState<CleanRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now);
  const alive = useRef(false);
  const generation = useRef(0);
  const submitting = useRef(false);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const [saved, contexts, cleaned] = await Promise.all([
        getJargonReview(meeting.id), getMiniContexts(), loadClean(meeting.id),
      ]);
      if (!alive.current || request !== generation.current) return;
      setReview(saved);
      setRegistry(contexts);
      setClean(cleaned);
      setLoaded(true);
      setLoadError('');
    } catch (error) {
      if (alive.current && request === generation.current) {
        setLoadError(error instanceof Error ? error.message : t('ext.unknownError'));
      }
    }
  }, [meeting.id]);

  useEffect(() => {
    alive.current = true;
    const keys: Record<string, true> = {
      [JARGON_REVIEW_PREFIX + meeting.id]: true,
      [CLEAN_PREFIX + meeting.id]: true,
      [MINI_CONTEXTS_KEY]: true,
    };
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some((key) => keys[key] === true)) void reload();
    };
    chrome.storage.onChanged.addListener(listener);
    void reload();
    return () => {
      alive.current = false;
      generation.current++;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [meeting.id, reload]);

  useEffect(() => {
    if (focusSection === 'review') heading.current?.focus();
  }, [focusSection]);

  useEffect(() => {
    if (review?.status !== 'processing') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 8000);
    return () => clearInterval(timer);
  }, [review?.status, review?.updatedAt]);

  const raw = useMemo(() => withEntryIds(meeting.entries), [meeting.entries]);
  const effective = useMemo(() => effectiveClean(raw, clean), [raw, clean]);
  const byId = useMemo(() => new Map(registry.map((item) => [item.id, item])), [registry]);
  const plan = useMemo(() => {
    try {
      return { count: planJargonReview(raw, effective, registry).length, error: '' };
    } catch (error) {
      return { count: 0, error: error instanceof Error ? error.message : t('ext.unknownError') };
    }
  }, [raw, effective, registry]);
  const confirmed = review?.items.filter((item) => item.status === 'confirmed') ?? [];
  const suggested = review?.items.filter((item) => item.status === 'suggested') ?? [];
  const recommendations = suggested.filter((item) => item.miniContextId !== null);
  const unknown = suggested.filter((item) => item.miniContextId === null);
  const confirmedIds = new Set(confirmed.map((item) => item.miniContextId));
  const attached = resolveMeetingMiniContexts(tags, registry, review).filter((item) => !confirmedIds.has(item.id));
  const activeIds = new Set(resolveMeetingMiniContexts(tags, registry, review).map((item) => item.id));
  const query = search.trim().toLocaleLowerCase(locale());
  const matches = registry.filter((item) => [item.term, item.definition, ...item.tags]
    .some((value) => value.toLocaleLowerCase(locale()).includes(query)));
  const updated = Date.parse(review?.updatedAt ?? '');
  const interrupted = review?.status === 'processing' && (!Number.isFinite(updated) || now - updated > 5 * 60_000);
  const processing = review?.status === 'processing' && !interrupted;
  const canReview = loaded && !live && !disabled && !busy && !processing && !plan.error && plan.count > 0;

  const send = async (action?: JargonReviewAction) => {
    if (submitting.current || live || (!action && !canReview)) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    try {
      const response = await chrome.runtime.sendMessage(action
        ? { type: 'update-jargon-review', meetingId: meeting.id, action }
        : { type: 'review-jargon', meetingId: meeting.id });
      if (!alive.current) return;
      if (!response?.ok) setActionError(response?.error ?? t('ext.unknownError'));
      await reload();
    } catch (error) {
      if (alive.current) setActionError(error instanceof Error ? error.message : t('ext.unknownError'));
    } finally {
      if (alive.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  };

  const renderItem = (item: MeetingJargonItem) => {
    const canonical = item.miniContextId ? byId.get(item.miniContextId) : undefined;
    const isConfirmed = item.status === 'confirmed';
    const term = isConfirmed ? item.term : canonical?.term ?? item.term;
    const definition = isConfirmed ? item.definition : canonical?.definition ?? '';
    const valid = item.evidence.length > 0 && item.evidence.every((evidence) => isJargonEvidenceValid(evidence, raw, effective));
    const snapshotChanged = isConfirmed && canonical && (canonical.term !== item.term || canonical.definition !== item.definition);
    return <article className="jargon-card" key={item.id}>
      <h4>{item.evidence.length ? item.evidence.map((evidence) => evidence.observed).join(', ') : item.term}
        {(item.miniContextId !== null || isConfirmed) && <> → {term}</>}
      </h4>
      {definition && <p>{definition}</p>}
      {isConfirmed && <p className="jargon-meta">{item.origin === 'llm'
        ? t('ext.jargon.confirmedAI') : t('ext.jargon.userClarification')}</p>}
      {item.reason && <p>{item.reason}</p>}
      {snapshotChanged && <p className="jargon-notice">{t('ext.jargon.registryChanged')}</p>}
      {isConfirmed && item.miniContextId && !canonical && <p className="jargon-notice">{t('ext.jargon.registryDeleted')}</p>}
      {!isConfirmed && item.miniContextId && !canonical && <p className="jargon-notice">{t('ext.jargon.suggestionRegistryDeleted')}</p>}
      {item.evidence.map((evidence, index) => <EvidenceQuote key={index} evidence={evidence}
        raw={raw} effective={effective} onViewEvidence={onViewEvidence} />)}
      <div className="jargon-actions">
        {isConfirmed ? <Button type="button" className="small" disabled={live || busy}
          onClick={() => void send({ type: 'remove', itemId: item.id })}>{t('ext.jargon.remove')}</Button>
          : <>
            {item.miniContextId === null
              ? <Button type="button" className="small" disabled={live || busy || !valid}
                onClick={() => onClarifyEvidence(item.evidence[0])}>{t('ext.jargon.clarifyTerm')}</Button>
              : <Button type="button" className="small" variant="primary" disabled={live || busy || !valid || !canonical}
                onClick={() => void send({ type: 'confirm', item })}>{t('ext.jargon.confirm')}</Button>}
            <Button type="button" className="small" disabled={live || busy}
              onClick={() => void send({ type: 'dismiss', itemId: item.id })}>{t('ext.jargon.notRelevant')}</Button>
          </>}
      </div>
    </article>;
  };

  return <section className="jargon-panel" aria-labelledby={`${searchId}-heading`}>
    <div className="jargon-toolbar">
      <h2 id={`${searchId}-heading`} ref={heading} tabIndex={-1}>{t('ext.jargon.title')}</h2>
      {onClarifyTerm && <Button type="button" className="small" disabled={live || busy} onClick={onClarifyTerm}>
        {t('ext.jargon.clarifyTerm')}
      </Button>}
    </div>
    <div className="jargon-review-control">
      <p>{t('ext.jargon.requestCount', { count: plan.count })}</p>
      <Button type="button" disabled={!canReview} onClick={() => void send()}>
        {busy || processing ? t('ext.jargon.processing') : interrupted || review?.status === 'error'
          ? t('ext.jargon.retry') : t('ext.jargon.review')}
      </Button>
      <div role="status" aria-live="polite">
        {!loaded && !loadError && <p>{t('ext.jargon.loading')}</p>}
        {live && <p>{t('ext.jargon.afterMeeting')}</p>}
        {disabled && <p>{t('ext.jargon.saveFirst')}</p>}
        {processing && <p>{t('ext.jargon.processingHint')}</p>}
        {interrupted && <p>{t('ext.jargon.interrupted')}</p>}
        {loaded && !review && <p>{t('ext.jargon.notReviewed')}</p>}
        {review?.status === 'done' && review.items.length === 0 && <p>{t('ext.jargon.noSuggestions')}</p>}
      </div>
      {loadError && <div role="alert"><p>{t('ext.failed', { error: loadError })}</p>
        <Button type="button" onClick={() => void reload()}>{t('ext.jargon.reload')}</Button>
      </div>}
      {(actionError || review?.error || plan.error) && <p role="alert">{t('ext.failed', {
        error: actionError || review?.error || plan.error,
      })}</p>}
    </div>
    <section aria-labelledby={`${searchId}-confirmed`}>
      <h3 id={`${searchId}-confirmed`}>{t('ext.jargon.confirmedContext')}</h3>
      <div className="jargon-grid">
        {confirmed.map(renderItem)}
        {attached.map((item) => <article className="jargon-card" key={item.id}>
          <h4>{item.term}</h4><p>{item.definition}</p>
          <p className="jargon-meta">{t('ext.jargon.attached')}</p>
          <p className="jargon-meta">{t('ext.jargon.removeTagHint')}</p>
        </article>)}
      </div>
      {loaded && !confirmed.length && !attached.length && <p className="jargon-meta">{t('ext.jargon.noConfirmed')}</p>}
    </section>
    <section aria-labelledby={`${searchId}-recommendations`}>
      <h3 id={`${searchId}-recommendations`}>{t('ext.jargon.recommendations')}</h3>
      <div className="jargon-grid">{recommendations.map(renderItem)}</div>
    </section>
    <section aria-labelledby={`${searchId}-clarification`}>
      <h3 id={`${searchId}-clarification`}>{t('ext.jargon.needsClarification')}</h3>
      <div className="jargon-grid">{unknown.map(renderItem)}</div>
    </section>
    <details className="jargon-registry">
      <summary>{t('ext.jargon.registered')}</summary>
      <label htmlFor={searchId}>{t('ext.jargon.searchLabel')}</label>
      <TextInput id={searchId} value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="jargon-grid">
        {matches.map((item) => <article className="jargon-card" key={item.id}>
          <h4>{item.term}</h4><p>{item.definition}</p>
          {item.tags.length > 0 && <p className="jargon-meta">{t('ext.jargon.tags', { tags: item.tags.join(', ') })}</p>}
          <Button type="button" className="small" disabled={live || busy || activeIds.has(item.id)} onClick={() => onAttachTerm(item.term)}>
            {activeIds.has(item.id) ? t('ext.jargon.alreadyAttached') : t('ext.jargon.attach')}
          </Button>
        </article>)}
      </div>
      {loaded && !matches.length && <p>{t('ext.jargon.noRegisteredMatches')}</p>}
    </details>
  </section>;
}
