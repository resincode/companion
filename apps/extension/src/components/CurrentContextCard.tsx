import { useEffect, useId, useState } from 'react';
import { t } from '@meetcc/shared/i18n';
import {
  CONTEXT_PREFIX, GOALS_PREFIX, JARGON_REVIEW_PREFIX, MEETING_TAGS_PREFIX, MINI_CONTEXTS_KEY,
  getContext, getGoals, getJargonReview, getMeetingTags, getMiniContexts, resolveMeetingMiniContexts,
  type Meeting, type MeetingJargonReview, type MiniContext,
} from '@meetcc/shared';
import { Button } from '@meetcc/ui';

interface Props {
  meeting: Meeting;
  onReviewJargon(): void;
  onClarifyTerm(): void;
}

interface SavedContext {
  context: string;
  tags: string[];
  goals: string[];
  registry: MiniContext[];
  review: MeetingJargonReview | null;
}

export function CurrentContextCard(props: Props) {
  return <SavedCurrentContextCard key={props.meeting.id} {...props} />;
}

function SavedCurrentContextCard({ meeting, onReviewJargon, onClarifyTerm }: Props) {
  const titleId = useId();
  const [saved, setSaved] = useState<SavedContext | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    let version = 0;
    const reload = async () => {
      const request = ++version;
      try {
        const [context, tags, goals, registry, review] = await Promise.all([
          getContext(meeting.id), getMeetingTags(meeting.id), getGoals(meeting.id),
          getMiniContexts(), getJargonReview(meeting.id),
        ]);
        if (!active || request !== version) return;
        setSaved({ context, tags, goals, registry, review });
        setError('');
        setNow(Date.now());
      } catch (e) {
        if (active && request === version) setError((e as Error).message);
      }
    };
    const keys: Record<string, true> = {
      [CONTEXT_PREFIX + meeting.id]: true, [MEETING_TAGS_PREFIX + meeting.id]: true,
      [GOALS_PREFIX + meeting.id]: true, [JARGON_REVIEW_PREFIX + meeting.id]: true,
      [MINI_CONTEXTS_KEY]: true,
    };
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && Object.keys(changes).some((key) => keys[key] === true)) void reload();
    };
    chrome.storage.onChanged.addListener(listener);
    void reload();
    return () => {
      active = false;
      ++version;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [meeting.id]);

  const review = saved?.review ?? null;
  useEffect(() => {
    if (review?.status !== 'processing') return;
    const timer = setInterval(() => setNow(Date.now()), 8000);
    return () => clearInterval(timer);
  }, [review?.status]);

  const contexts = saved ? resolveMeetingMiniContexts(saved.tags, saved.registry, review) : [];
  const confirmed = (review?.items ?? []).filter((item) => item.status === 'confirmed');
  const snapshots = new Map(confirmed.filter((item) => item.miniContextId !== null)
    .map((item) => [item.miniContextId, item]));
  const meetingOnly = confirmed.filter((item) => item.miniContextId === null);
  const pending = (review?.items ?? []).filter((item) => item.status === 'suggested').length;
  const interrupted = review?.status === 'processing' && now - Date.parse(review.updatedAt) >= 5 * 60_000;

  return (
    <section className="current-context-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('ext.currentContext.title')}</h2>
      {error && <p role="alert">{t('ext.currentContext.loadFailed', { error })}</p>}
      {!saved && !error && <p role="status">{t('ext.currentContext.loading')}</p>}
      {saved && <>
        {saved.context.trim() && <div>
          <h3>{t('ext.currentContext.context')}</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{saved.context}</p>
        </div>}
        {saved.goals.length > 0 && <div>
          <h3>{t('ext.currentContext.goals')}</h3>
          <ol>{saved.goals.map((goal, index) => <li key={index}>{goal}</li>)}</ol>
        </div>}
        <h3>{t('ext.currentContext.terms')}</h3>
        {contexts.map((context) => {
          const snapshot = snapshots.get(context.id);
          const registered = saved.registry.find((item) => item.id === context.id);
          return <article key={context.id} className="jargon-card">
            <h4>{context.term}</h4>
            <p>{context.definition}</p>
            <p className="dim">{snapshot
              ? t(snapshot.origin === 'llm' ? 'ext.currentContext.confirmedAI' : 'ext.currentContext.userClarification')
              : t('ext.currentContext.attached')}</p>
            {snapshot && !registered && <p className="dim">{t('ext.currentContext.registryRemoved')}</p>}
            {snapshot && registered && (registered.term !== snapshot.term || registered.definition !== snapshot.definition) &&
              <p className="dim">{t('ext.currentContext.registryChanged')}</p>}
          </article>;
        })}
        {meetingOnly.map((item) => <article key={item.id} className="jargon-card">
          <h4>{item.term}</h4>
          <p>{item.definition}</p>
          <p className="dim">{t('ext.currentContext.meetingOnly')}</p>
        </article>)}
        {!contexts.length && !meetingOnly.length && <p className="dim">{t('ext.currentContext.noTerms')}</p>}
        <div aria-live="polite">
          {review?.status === 'processing' && <p>{t(interrupted
            ? 'ext.currentContext.interrupted' : 'ext.currentContext.processing')}</p>}
          {review?.status === 'error' && <p role="alert">{t('ext.currentContext.reviewFailed', { error: review.error ?? '' })}</p>}
          {!review?.reviewedAt && <p>{t('ext.currentContext.notReviewed')}</p>}
          {review?.reviewedAt && review.items.length === 0 && <p>{t('ext.currentContext.noSuggestions')}</p>}
          {(pending > 0 || (review?.reviewedAt && review.items.length > 0)) &&
            <p>{t('ext.currentContext.pending', { count: pending })}</p>}
        </div>
      </>}
      <p className="dim">{t('ext.currentContext.nextRun')}</p>
      <div className="jargon-actions">
        <Button onClick={onReviewJargon}>{t('ext.currentContext.review')}</Button>
        <Button onClick={onClarifyTerm}>{t('ext.currentContext.clarify')}</Button>
      </div>
    </section>
  );
}
