import { useEffect, useId, useRef, useState } from 'react';
import { t } from '@meetcc/shared/i18n';
import type { AnalysisRecord, CleanRecord, JargonEvidence, Meeting } from '@meetcc/shared';
import {
  getContext, getGoals, getMeetingTags, loadClean,
  saveContext, saveGoals, saveMeetingTags,
  CONTEXT_PREFIX, GOALS_PREFIX, MEETING_TAGS_PREFIX, JARGON_REVIEW_PREFIX, CLEAN_PREFIX,
} from '@meetcc/shared';
import { Button, TextInput, useToast } from '@meetcc/ui';
import { ContextCard } from './ContextCard';
import { MeetingJargonPanel } from './MeetingJargonPanel';

interface Props {
  meeting: Meeting;
  record: AnalysisRecord | null;
  live: boolean;
  onViewEvidence(evidence: JargonEvidence): void;
  onClarifyEvidence(evidence: JargonEvidence): void;
  onClarifyTerm(): void;
  focusSection?: 'review' | 'clarify';
}

interface Draft {
  context: string;
  tags: string[];
  goals: string[];
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.context === b.context &&
    a.tags.length === b.tags.length && a.tags.every((tag, i) => tag === b.tags[i]) &&
    a.goals.length === b.goals.length && a.goals.every((goal, i) => goal === b.goals[i]);
}

async function readDraft(id: string): Promise<Draft> {
  const [context, tags, goals] = await Promise.all([getContext(id), getMeetingTags(id), getGoals(id)]);
  return { context, tags, goals };
}

export function ContextGoalsView(props: Props) {
  return <SavedContextEditor key={props.meeting.id} {...props} />;
}

function SavedContextEditor({
  meeting, record, live, onViewEvidence, onClarifyEvidence, onClarifyTerm, focusSection,
}: Props) {
  const toast = useToast();
  const goalInputId = useId();
  const [draft, setDraft] = useState<Draft>(() => ({
    context: meeting.context ?? '', tags: meeting.tags ?? [], goals: meeting.goals ?? [],
  }));
  const [baseline, setBaseline] = useState(draft);
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  const alive = useRef(true);
  const selfSaving = useRef(false);
  const reloadVersion = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [conflict, setConflict] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [draftGoals, setDraftGoals] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<'summary' | 'clean' | null>(null);
  const [cleanRecord, setCleanRecord] = useState<CleanRecord | null>(null);
  const [now, setNow] = useState(Date.now);

  const changeDraft = (next: Draft) => {
    draftRef.current = next;
    setDraft(next);
    setError('');
  };
  const changeBaseline = (next: Draft) => {
    baselineRef.current = next;
    setBaseline(next);
  };

  useEffect(() => {
    alive.current = true;
    const reload = async () => {
      if (selfSaving.current) return;
      const version = ++reloadVersion.current;
      try {
        const next = await readDraft(meeting.id);
        if (!alive.current || selfSaving.current || version !== reloadVersion.current) return;
        if (sameDraft(draftRef.current, baselineRef.current)) {
          draftRef.current = next;
          baselineRef.current = next;
          setDraft(next);
          setBaseline(next);
          setConflict(null);
        } else {
          setConflict(sameDraft(next, baselineRef.current) ? null : next);
        }
        setLoaded(true);
      } catch (e) {
        if (alive.current && version === reloadVersion.current) setError((e as Error).message);
      }
    };
    let cleanReloadVersion = 0;
    const reloadClean = () => {
      const version = ++cleanReloadVersion;
      void loadClean(meeting.id).then((next) => {
        if (alive.current && version === cleanReloadVersion) setCleanRecord(next);
      }).catch((e: Error) => {
        if (alive.current && version === cleanReloadVersion) setError(e.message);
      });
    };
    const editorKeys: Record<string, true> = {
      [CONTEXT_PREFIX + meeting.id]: true, [MEETING_TAGS_PREFIX + meeting.id]: true,
      [GOALS_PREFIX + meeting.id]: true, [JARGON_REVIEW_PREFIX + meeting.id]: true,
    };
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area !== 'local') return;
      if (Object.keys(changes).some((key) => editorKeys[key] === true)) void reload();
      if (CLEAN_PREFIX + meeting.id in changes) reloadClean();
    };
    chrome.storage.onChanged.addListener(listener);
    void reload();
    reloadClean();
    const timer = setInterval(() => setNow(Date.now()), 8000);
    return () => {
      alive.current = false;
      ++reloadVersion.current;
      chrome.storage.onChanged.removeListener(listener);
      clearInterval(timer);
    };
  }, [meeting.id]);

  const dirty = !sameDraft(draft, baseline);
  const cleanRunning = cleanRecord?.status === 'processing' &&
    now - Date.parse(cleanRecord.updatedAt) < 60_000;
  const blocked = !loaded || dirty || saving || !!conflict;
  const empty = meeting.entries.length === 0;

  const handleSave = async () => {
    if (!loaded || selfSaving.current || conflict) return;
    const snapshot = draftRef.current;
    selfSaving.current = true;
    ++reloadVersion.current;
    setSaving(true);
    setError('');
    try {
      await saveContext(meeting.id, snapshot.context);
      if (!alive.current) return;
      await saveMeetingTags(meeting.id, snapshot.tags);
      if (!alive.current) return;
      await saveGoals(meeting.id, snapshot.goals);
      if (!alive.current) return;
      const persisted = await readDraft(meeting.id);
      if (!alive.current) return;
      const normalized = { ...snapshot, context: snapshot.context.trim() };
      if (sameDraft(persisted, normalized)) {
        changeBaseline(persisted);
        changeDraft(persisted);
        setConflict(null);
      } else {
        setConflict(persisted);
      }
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
      // A failed multi-key save can have persisted only some fields. Keep the
      // draft, but acknowledge the actual saved state rather than claiming saved.
      try {
        const persisted = await readDraft(meeting.id);
        if (alive.current) changeBaseline(persisted);
      } catch { /* Retain the last known baseline if storage is still unavailable. */ }
    } finally {
      selfSaving.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const apply = async (target: 'summary' | 'clean') => {
    if (blocked || live || empty || applying || (target === 'clean' && cleanRunning)) return;
    setApplying(target);
    setError('');
    try {
      const res = await chrome.runtime.sendMessage(target === 'clean'
        ? { type: 'clean-transcript', meetingId: meeting.id, fromScratch: true }
        : { type: 'regenerate', meetingId: meeting.id });
      if (!alive.current) return;
      if (!res?.ok) setError(res?.error ?? res?.reason ?? t('ext.unknownError'));
      else toast('success', target === 'clean'
        ? t('ext.transcript.cleaned', { count: res.changed }) : t('ext.summary.notesDone'));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setApplying(null);
    }
  };

  const suggestGoals = async () => {
    if (blocked || live || empty || suggesting) return;
    setSuggesting(true);
    setError('');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'suggest-goals', meetingId: meeting.id });
      if (!alive.current) return;
      if (res?.ok) setDraftGoals(res.goals);
      else setError(res?.error ?? t('ext.unknownError'));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setSuggesting(false);
    }
  };

  const copyAsMarkdown = async () => {
    const lines = [
      `# ${t('ext.context.title')}`, '',
      draft.context.trim() || t('ext.context.noContext'), '',
      `## ${t('ext.context.goals')}`,
      ...(draft.goals.length ? draft.goals.map((goal) => `- ${goal}`) : [t('ext.context.noGoals')]),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      if (alive.current) toast('success', t('ext.docs.markdownCopied'));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };

  const addGoal = () => {
    const goal = newGoal.trim();
    if (!goal || saving) return;
    changeDraft({ ...draftRef.current, goals: [...draftRef.current.goals, goal] });
    setNewGoal('');
  };

  const resolveConflict = (keep: boolean) => {
    if (!conflict) return;
    changeBaseline(conflict);
    if (!keep) {
      changeDraft(conflict);
      setNewGoal('');
      setDraftGoals([]);
    }
    setConflict(null);
  };

  return (
    <div className="context-view">
      <div className="context-view-toolbar">
        <h2 className="context-view-title">{t('ext.context.title')}</h2>
        <span className="context-amber-pill" role="status" aria-live="polite">
          {saving ? t('ext.context.saving') : !loaded ? t('ext.context.loading')
            : error ? t('ext.context.errorStatus') : dirty || conflict ? t('ext.context.unsaved') : t('ext.context.saved')}
        </span>
      </div>
      {error && <p role="alert">{t('ext.failed', { error })}</p>}
      {conflict && (
        <div role="alert">
          <p>{t('ext.context.conflict')}</p>
          <Button type="button" onClick={() => resolveConflict(false)}>{t('ext.context.reloadSaved')}</Button>
          <Button type="button" onClick={() => resolveConflict(true)}>{t('ext.context.keepEdits')}</Button>
        </div>
      )}
      <div className="subbar" style={{ padding: '10px 16px', flexWrap: 'wrap' }}>
        <Button type="button" variant="primary" onClick={handleSave} disabled={!loaded || saving || !!conflict}>
          {saving ? t('ext.context.saving') : t('ext.context.save')}
        </Button>
        <Button type="button" onClick={() => apply('summary')}
          disabled={blocked || live || empty || !!applying || record?.status === 'processing'}>
          {t('ext.context.applyToSummary')}
        </Button>
        <Button type="button" onClick={() => apply('clean')}
          disabled={blocked || live || empty || cleanRunning || !!applying}>
          {t('ext.context.applyToClean')}
        </Button>
        <Button type="button" onClick={copyAsMarkdown}>{t('ext.context.copyAsMarkdown')}</Button>
        <span className="spacer" />
        <Button type="button" onClick={suggestGoals} disabled={blocked || live || empty || suggesting}>
          {suggesting ? t('ext.summary.processing') : t('ext.context.suggestGoals')}
        </Button>
      </div>
      {(dirty || saving || conflict) && <p className="dim">{t('ext.context.saveFirst')}</p>}
      <p className="dim">{t('ext.context.nextResults')}</p>
      <fieldset disabled={!loaded || !!conflict} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <ContextCard meeting={meeting} context={draft.context} tags={draft.tags}
        onContextChange={(context) => changeDraft({ ...draftRef.current, context })}
        onTagsChange={(tags) => changeDraft({ ...draftRef.current, tags })}
        onSave={handleSave} saving={saving} />
      </fieldset>
      <div className="goals-section">
        <h3 className="goals-heading">{t('ext.context.goals')}</h3>
        <div className="goals-list">
          {draft.goals.map((goal, idx) => (
            <span key={`${goal}-${idx}`} className="goal-chip">
              {goal}
              <button type="button" className="remove" disabled={saving}
                onClick={() => changeDraft({ ...draftRef.current,
                  goals: draftRef.current.goals.filter((_, i) => i !== idx) })}
                aria-label={t('ext.context.removeGoal', { goal })}>×</button>
            </span>
          ))}
        </div>
        <label htmlFor={goalInputId}>{t('ext.context.goalLabel')}</label>
        <div className="goal-add-row">
          <TextInput id={goalInputId} value={newGoal} disabled={saving}
            onChange={(e) => setNewGoal(e.target.value)} placeholder={t('ext.context.addGoal')}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addGoal(); } }} />
          <Button type="button" onClick={addGoal} disabled={saving}>{t('ext.context.add')}</Button>
        </div>
        {draftGoals.length > 0 && (
          <div className="draft-goals">
            <h3 className="draft-goals-label">{t('ext.context.suggestGoals')}</h3>
            <div className="goals-list">
              {draftGoals.map((goal, idx) => (
                <span key={`draft-${idx}`} className="goal-chip draft">
                  {goal}
                  <button type="button" className="accept" disabled={saving} onClick={() => {
                    if (!draftRef.current.goals.includes(goal)) {
                      changeDraft({ ...draftRef.current, goals: [...draftRef.current.goals, goal] });
                    }
                    setDraftGoals((prev) => prev.filter((g) => g !== goal));
                  }} aria-label={t('ext.context.acceptGoal', { goal })}>✓</button>
                  <button type="button" className="remove" disabled={saving}
                    onClick={() => setDraftGoals((prev) => prev.filter((g) => g !== goal))}
                    aria-label={t('ext.context.rejectGoal', { goal })}>×</button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <MeetingJargonPanel meeting={meeting} live={live} disabled={blocked} tags={baseline.tags}
        onViewEvidence={onViewEvidence} onClarifyEvidence={onClarifyEvidence}
        onClarifyTerm={onClarifyTerm} focusSection={focusSection}
        onAttachTerm={(term) => {
          if (!loaded || saving || conflict) return;
          if (!draftRef.current.tags.some((tag) => tag.toLowerCase() === term.toLowerCase())) {
            changeDraft({ ...draftRef.current, tags: [...draftRef.current.tags, term] });
          }
        }} />
    </div>
  );
}
