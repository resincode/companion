import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '@meetcc/shared/i18n';
import type { AnalysisRecord, Meeting, MiniContext } from '@meetcc/shared';
import {
  getContext,
  getGoals,
  getMeetingTags,
  getMiniContexts,
  saveContext,
  saveGoals,
  saveMeetingTags,
  watchStorage,
  CONTEXT_PREFIX,
  GOALS_PREFIX,
  MEETING_TAGS_PREFIX,
  MINI_CONTEXTS_KEY,
} from '@meetcc/shared';
import { Button, TextInput, useToast } from '@meetcc/ui';
import { ContextCard } from './ContextCard';

interface Props {
  meeting: Meeting;
  record: AnalysisRecord | null;
  live: boolean;
}


export function ContextGoalsView({ meeting, record, live }: Props) {
  const toast = useToast();
  const [context, setContext] = useState(meeting.context ?? '');
  const [tags, setTags] = useState<string[]>(meeting.tags ?? []);
  const [goals, setGoals] = useState<string[]>(meeting.goals ?? []);
  const [newGoal, setNewGoal] = useState('');
  const [draftGoals, setDraftGoals] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void getContext(meeting.id).then((c) => alive && setContext(c ?? ''));
    void getMeetingTags(meeting.id).then((t) => alive && setTags(t ?? []));
    void getGoals(meeting.id).then((g) => alive && setGoals(g ?? []));
    return () => {
      alive = false;
    };
  }, [meeting.id]);

  useEffect(() => {
    return watchStorage(() => {
      void getContext(meeting.id).then((c) => c !== undefined && setContext(c));
      void getMeetingTags(meeting.id).then((t) => t !== undefined && setTags(t));
      void getGoals(meeting.id).then((g) => g !== undefined && setGoals(g));
    }, [CONTEXT_PREFIX + meeting.id, MEETING_TAGS_PREFIX + meeting.id, GOALS_PREFIX + meeting.id]);
  }, [meeting.id]);

  const hasContent = !!context.trim() || tags.length > 0 || goals.length > 0;

  const handleSave = async () => {
    setSaving(true);
    await saveContext(meeting.id, context);
    await saveMeetingTags(meeting.id, tags);
    await saveGoals(meeting.id, goals);
    setSaving(false);
    toast('success', t('ext.context.saved'));
  };

  const regenerateSummary = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'regenerate', meetingId: meeting.id });
      if (res?.ok) toast('success', live ? t('ext.summary.momDone') : t('ext.summary.notesDone'));
      else toast('error', t('ext.failed', { error: res?.error ?? res?.reason ?? t('ext.unknownError') }));
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    }
  };

  const applyToClean = async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'clean-transcript',
        meetingId: meeting.id,
      });
      if (res?.ok) toast('success', t('ext.transcript.cleaned', { count: res.changed }));
      else toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    }
  };

  const copyAsMarkdown = useCallback(() => {
    const lines = [
      `# ${t('ext.context.title')}`,
      '',
      meeting.context?.trim() || '_No context set._',
      '',
      `## ${t('ext.context.goals')}`,
      ...(goals.length ? goals.map((g) => `- ${g}`) : ['_No goals set._']),
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    toast('success', t('ext.docs.markdownCopied'));
  }, [meeting.context, goals, toast]);

  const addGoal = () => {
    const trimmed = newGoal.trim();
    if (!trimmed) return;
    setGoals((prev) => [...prev, trimmed]);
    setNewGoal('');
  };

  const removeGoal = (index: number) => {
    setGoals((prev) => prev.filter((_, i) => i !== index));
  };

  const acceptDraft = (goal: string) => {
    if (!goals.includes(goal)) setGoals((prev) => [...prev, goal]);
    setDraftGoals((prev) => prev.filter((g) => g !== goal));
  };

  const rejectDraft = (goal: string) => {
    setDraftGoals((prev) => prev.filter((g) => g !== goal));
  };

  const suggestGoals = async () => {
    setSuggesting(true);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'suggest-goals',
        meetingId: meeting.id,
      });
      if (res?.ok) {
        setDraftGoals(res.goals);
      } else {
        toast('error', t('ext.failed', { error: res?.error ?? t('ext.unknownError') }));
      }
    } catch (e) {
      toast('error', t('ext.failed', { error: (e as Error).message }));
    } finally {
      setSuggesting(false);
    }
  };

  const [availableContexts, setAvailableContexts] = useState<MiniContext[]>([]);
  useEffect(() => {
    void getMiniContexts().then(setAvailableContexts).catch(() => undefined);
    return watchStorage(() => {
      void getMiniContexts().then(setAvailableContexts).catch(() => undefined);
    }, [MINI_CONTEXTS_KEY]);
  }, []);

  const matchedMiniContexts = useMemo(() => {
    const tagSet = new Set((meeting.tags ?? tags).map((t) => t.toLowerCase()));
    if (tagSet.size === 0) return [];
    return availableContexts.filter(
      (c) =>
        tagSet.has(c.term.toLowerCase()) || c.tags.some((tg) => tagSet.has(tg.toLowerCase())),
    );
  }, [availableContexts, meeting.tags, tags]);


  return (
    <div className="context-view">
      <div className="context-view-toolbar">
        <div className="context-view-title">
          {t('ext.context.title')}
          {hasContent && <span className="context-amber-pill">{t('ext.context.saved')}</span>}
        </div>
      </div>
      <div className="subbar" style={{ padding: '10px 16px' }}>
        <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? t('ext.summary.processing') : t('ext.context.save')}
        </Button>
        <Button type="button" onClick={regenerateSummary} disabled={!!record?.status && record.status !== 'done'}>
          {t('ext.context.applyToSummary')}
        </Button>
        <Button type="button" onClick={applyToClean}>
          {t('ext.context.applyToClean')}
        </Button>
        <Button type="button" onClick={copyAsMarkdown}>
          {t('ext.context.copyAsMarkdown')}
        </Button>
        <span className="spacer" />
        <Button type="button" onClick={suggestGoals} disabled={suggesting}>
          {suggesting ? t('ext.summary.processing') : t('ext.context.suggestGoals')}
        </Button>
      </div>
      <ContextCard meeting={meeting} />
      <div className="goals-section">
        <h3 className="goals-heading">{t('ext.context.goals')}</h3>
        <div className="goals-list">
          {goals.map((goal, idx) => (
            <span key={`${goal}-${idx}`} className="goal-chip">
              {goal}
              <button
                type="button"
                className="remove"
                onClick={() => removeGoal(idx)}
                aria-label={t('ext.header.close')}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <div className="goal-add-row">
          <TextInput
            value={newGoal}
            onChange={(e) => setNewGoal(e.target.value)}
            placeholder={t('ext.context.addGoal')}
            onKeyDown={(e) => e.key === 'Enter' && addGoal()}
          />
          <Button type="button" onClick={addGoal}>
            {t('ext.context.save')}
          </Button>
        </div>
        {draftGoals.length > 0 && (
          <div className="draft-goals">
            <span className="dim draft-goals-label">{t('ext.context.suggestGoals')}</span>
            <div className="goals-list">
              {draftGoals.map((goal, idx) => (
                <span key={`draft-${idx}`} className="goal-chip draft">
                  {goal}
                  <button type="button" className="accept" onClick={() => acceptDraft(goal)} aria-label="Accept">
                    ✓
                  </button>
                  <button type="button" className="remove" onClick={() => rejectDraft(goal)} aria-label="Reject">
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      {matchedMiniContexts.length > 0 && (
        <div className="mini-context-preview">
          <h3 className="goals-heading">{t('ext.kb.contextTitle')}</h3>
          <ul className="mini-context-list">
            {matchedMiniContexts.map((c) => (
              <li key={c.id}>
                <strong>{c.term}</strong> — {c.definition}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
