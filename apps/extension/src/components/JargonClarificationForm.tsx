import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CLEAN_PREFIX,
  effectiveClean,
  getJargonReview,
  getMiniContexts,
  isJargonEvidenceValid,
  jargonItemId,
  jargonOccurrenceKey,
  loadClean,
  watchStorage,
  withEntryIds,
  type CleanRecord,
  type Entry,
  type JargonEvidence,
  type Meeting,
  type MeetingJargonItem,
  type MiniContext,
} from '@meetcc/shared';
import { locale, t } from '@meetcc/shared/i18n';
import { Button, SegmentedControl, TextArea, TextInput } from '@meetcc/ui';

export interface JargonClarificationFormProps {
  meeting: Meeting;
  /** The transcript occurrence the form was opened from, when there is one. */
  seed?: JargonEvidence;
  registry: MiniContext[];
  onCancel(): void;
  onSaved(item: MeetingJargonItem): void;
  /** Registry promotion lives in the worker; duplicate is reported, never overwritten. */
  onRegister(
    itemId: string,
  ): Promise<{ ok: true } | { ok: false; error: string; existingMiniContextId?: string }>;
  disabled?: boolean;
}

type Variant = 'raw' | 'clean';

interface Duplicate {
  id: string;
  term: string;
  definition: string;
}

function seedKey(seed: JargonEvidence | undefined): string {
  return seed ? `${seed.entryId}:${seed.variant}:${seed.observed}` : 'none';
}

export function JargonClarificationForm(props: JargonClarificationFormProps) {
  return <ClarificationForm key={`${props.meeting.id}:${seedKey(props.seed)}`} {...props} />;
}

function ClarificationForm({
  meeting, seed, registry, onCancel, onSaved, onRegister, disabled = false,
}: JargonClarificationFormProps) {
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const phraseRef = useRef<HTMLInputElement>(null);
  const lineSearchRef = useRef<HTMLInputElement>(null);
  // The control that opened the form; cancel hands focus back to it when it is
  // still mounted (the parent owns cross-view focus, this is the fallback).
  const initiating = useRef<HTMLElement | null>(
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null,
  );

  const [clean, setClean] = useState<CleanRecord | null>(null);
  const [cleanLoaded, setCleanLoaded] = useState(false);
  const [variant, setVariant] = useState<Variant>(seed?.variant ?? 'raw');
  const [entryId, setEntryId] = useState(seed?.entryId ?? '');
  const [lineQuery, setLineQuery] = useState('');
  const [phrase, setPhrase] = useState(seed?.observed ?? '');
  const [mode, setMode] = useState<'registry' | 'meeting'>('registry');
  const [registryQuery, setRegistryQuery] = useState('');
  const [registryId, setRegistryId] = useState('');
  const [term, setTerm] = useState(seed?.observed ?? '');
  const [meaning, setMeaning] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState<MeetingJargonItem | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [registered, setRegistered] = useState(false);
  const [duplicate, setDuplicate] = useState<Duplicate | null>(null);

  useEffect(() => {
    const alive = true;
    const load = () => {
      void loadClean(meeting.id)
        .then((record) => {
          if (alive) {
            setClean(record);
            setCleanLoaded(true);
          }
        })
        .catch(() => {
          if (alive) setCleanLoaded(true);
        });
    };
    load();
    return watchStorage(load, [CLEAN_PREFIX]);
  }, [meeting.id]);

  useEffect(() => {
    if (seed) phraseRef.current?.focus();
    else lineSearchRef.current?.focus();
  }, [seed?.entryId, seed?.variant, seed?.observed]);

  const raw = useMemo(() => withEntryIds(meeting.entries), [meeting.entries]);
  const effective = useMemo(() => effectiveClean(raw, clean), [raw, clean]);
  const canClean = cleanLoaded && clean?.status === 'done';
  const lines = variant === 'clean' ? (canClean ? effective : []) : raw;
  const selectedLine: Entry | null = lines.find((line) => line.id === entryId) ?? null;

  const lineMatches = useMemo(() => {
    const query = lineQuery.trim().toLowerCase();
    const matched = query
      ? lines.filter((line) => `${line.speaker} ${line.text}`.toLowerCase().includes(query))
      : lines;
    return matched.slice(0, 50);
  }, [lines, lineQuery]);

  const registryMatches = useMemo(() => {
    const query = registryQuery.trim().toLowerCase();
    if (!query) return registry;
    return registry.filter((item) =>
      [item.term, item.definition, ...item.tags].some((value) => value.toLowerCase().includes(query)),
    );
  }, [registry, registryQuery]);

  const selectedContext = registry.find((item) => item.id === registryId) ?? null;

  const buildEvidence = (): JargonEvidence | null => {
    if (!selectedLine) return null;
    const evidence: JargonEvidence = {
      entryId: selectedLine.id ?? entryId,
      variant: variant === 'clean' && canClean ? 'clean' : 'raw',
      sourceText: selectedLine.text,
      observed: phrase.trim().replace(/\s+/g, ' '),
    };
    return isJargonEvidenceValid(evidence, raw, effective) ? evidence : null;
  };

  const reloadSaved = async (occurrence: string): Promise<MeetingJargonItem | null> => {
    const review = await getJargonReview(meeting.id);
    return (
      review?.items.find(
        (item) => item.status === 'confirmed' && item.evidence.some((e) => jargonOccurrenceKey(e) === occurrence),
      ) ?? null
    );
  };

  const submit = async () => {
    if (disabled || submitting) return;
    setError('');
    if (!selectedLine) {
      setError(t('ext.jargon.clarifyStale'));
      return;
    }
    if (!phrase.trim()) {
      setError(t('ext.jargon.clarifyPhraseRequired'));
      return;
    }
    const evidence = buildEvidence();
    if (!evidence) {
      setError(t('ext.jargon.clarifyPhraseNotInLine'));
      return;
    }
    let miniContextId: string | null = null;
    let finalTerm = term.trim();
    let finalDefinition = meaning.trim();
    if (mode === 'registry') {
      if (!selectedContext) {
        setError(t('ext.jargon.clarifyRegistryRequired'));
        return;
      }
      miniContextId = selectedContext.id;
      finalTerm = selectedContext.term;
      finalDefinition = selectedContext.definition;
    } else {
      if (!finalTerm) {
        setError(t('ext.jargon.clarifyTermRequired'));
        return;
      }
      if (!finalDefinition) {
        setError(t('ext.jargon.clarifyMeaningRequired'));
        return;
      }
    }
    const item: MeetingJargonItem = {
      id: jargonItemId(evidence, miniContextId),
      origin: 'manual',
      status: 'confirmed',
      miniContextId,
      term: finalTerm,
      definition: finalDefinition,
      reason: '',
      evidence: [evidence],
    };
    setSubmitting(true);
    setStatus('');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'update-jargon-review',
        meetingId: meeting.id,
        action: { type: 'confirm', item },
      });
      if (!response?.ok) {
        setError(response?.error ?? t('ext.unknownError'));
        return;
      }
      const persisted = await reloadSaved(jargonOccurrenceKey(evidence));
      if (!persisted) {
        setError(t('ext.jargon.clarifyNotSaved'));
        return;
      }
      setSaved(persisted);
      setStatus(t('ext.jargon.clarifySaved'));
      onSaved(persisted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const register = async () => {
    if (disabled || !saved || registering) return;
    setRegistering(true);
    setRegisterError('');
    setDuplicate(null);
    try {
      const result = await onRegister(saved.id);
      if (result.ok) {
        const occurrence = saved.evidence[0] ? jargonOccurrenceKey(saved.evidence[0]) : '';
        const linked = await reloadSaved(occurrence);
        if (linked) {
          setSaved(linked);
          onSaved(linked);
        }
        setRegistered(true);
        setStatus(t('ext.jargon.clarifyRegisteredOk'));
      } else if (result.existingMiniContextId) {
        const existing =
          registry.find((item) => item.id === result.existingMiniContextId) ??
          (await getMiniContexts()).find((item) => item.id === result.existingMiniContextId);
        setDuplicate({
          id: result.existingMiniContextId,
          term: existing?.term ?? saved.term,
          definition: existing?.definition ?? '',
        });
      } else {
        setRegisterError(result.error);
      }
    } catch (e) {
      setRegisterError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  // "Use the existing entry" links this meeting clarification to the current
  // registry entry without overwriting it: drop the meeting-only confirmation,
  // then confirm the same occurrence against the registry id and definition.
  const invokeUseExisting = async () => {
    if (!saved || !duplicate || disabled) return;
    const evidence = saved.evidence[0];
    if (!evidence) return;
    setRegistering(true);
    setRegisterError('');
    try {
      const removed = await chrome.runtime.sendMessage({
        type: 'update-jargon-review',
        meetingId: meeting.id,
        action: { type: 'remove', itemId: saved.id },
      });
      if (!removed?.ok) {
        setRegisterError(removed?.error ?? t('ext.unknownError'));
        return;
      }
      const item: MeetingJargonItem = {
        id: jargonItemId(evidence, duplicate.id),
        origin: 'manual',
        status: 'confirmed',
        miniContextId: duplicate.id,
        term: duplicate.term,
        definition: duplicate.definition,
        reason: '',
        evidence: [evidence],
      };
      const response = await chrome.runtime.sendMessage({
        type: 'update-jargon-review',
        meetingId: meeting.id,
        action: { type: 'confirm', item },
      });
      if (!response?.ok) {
        setRegisterError(response?.error ?? t('ext.unknownError'));
        return;
      }
      const linked = await reloadSaved(jargonOccurrenceKey(evidence));
      if (linked) {
        setSaved(linked);
        onSaved(linked);
      }
      setDuplicate(null);
      setRegistered(true);
      setStatus(t('ext.jargon.clarifyRegisteredOk'));
    } catch (e) {
      setRegisterError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  };

  const cancel = () => {
    const target = initiating.current;
    if (target && target.isConnected) target.focus();
    onCancel();
  };

  const showVariantToggle = canClean && (clean?.entries.length ?? 0) > 0;

  return (
    <section
      className="jargon-panel jargon-clarify"
      aria-labelledby={`${ids}-heading`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') cancel();
      }}
    >
      <h3 id={`${ids}-heading`} ref={headingRef} tabIndex={-1}>
        {t('ext.jargon.clarifyTitle')}
      </h3>
      <p className="jargon-meta">{t('ext.jargon.clarifyIntro')}</p>

      {!seed && (
        <div>
          <label htmlFor={`${ids}-lines`}>{t('ext.jargon.clarifyLineSearch')}</label>
          <TextInput
            id={`${ids}-lines`}
            ref={lineSearchRef}
            value={lineQuery}
            onChange={(event) => setLineQuery(event.target.value)}
            placeholder={t('ext.jargon.clarifyLineHint')}
            aria-describedby={`${ids}-line-hint`}
          />
          <p id={`${ids}-line-hint`} className="jargon-meta">
            {t('ext.jargon.clarifyLineHint')}
          </p>
          <div className="jargon-lines">
            {lineMatches.map((line) => (
              <Button
                key={line.id}
                className="jargon-line"
                variant={line.id === entryId ? 'primary' : 'default'}
                onClick={() => setEntryId(line.id ?? '')}
              >
                {line.speaker}: {line.text}
              </Button>
            ))}
          </div>
          {lineMatches.length === 0 && <p className="jargon-notice">{t('ext.jargon.clarifyNoLines')}</p>}
        </div>
      )}

      {showVariantToggle && (
        <SegmentedControl
          ariaLabel={t('ext.jargon.clarifySentence')}
          options={[
            { value: 'raw', label: t('ext.jargon.raw') },
            { value: 'clean', label: t('ext.jargon.clean') },
          ]}
          value={variant}
          onChange={(value) => setVariant(value as Variant)}
        />
      )}

      <label htmlFor={`${ids}-source`}>{t('ext.jargon.clarifySentence')}</label>
      {selectedLine ? (
        <>
          <blockquote id={`${ids}-source`}>{selectedLine.text}</blockquote>
          <p className="jargon-meta">
            {selectedLine.speaker} ·{' '}
            {new Date(selectedLine.time).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}
          </p>
        </>
      ) : (
        <p id={`${ids}-source`} className="jargon-notice">
          {t('ext.jargon.clarifyStale')}
        </p>
      )}

      <label htmlFor={`${ids}-phrase`}>{t('ext.jargon.clarifyPhrase')}</label>
      <TextInput
        id={`${ids}-phrase`}
        ref={phraseRef}
        value={phrase}
        disabled={!selectedLine}
        onChange={(event) => setPhrase(event.target.value)}
        aria-describedby={`${ids}-phrase-hint`}
      />
      <p id={`${ids}-phrase-hint`} className="jargon-meta">
        {t('ext.jargon.clarifyPhraseHint')}
      </p>

      <SegmentedControl
        ariaLabel={t('ext.jargon.clarifyTitle')}
        options={[
          { value: 'registry', label: t('ext.jargon.clarifyRegistered') },
          { value: 'meeting', label: t('ext.jargon.clarifyMeetingOnly') },
        ]}
        value={mode}
        onChange={(value) => setMode(value as 'registry' | 'meeting')}
      />

      {mode === 'registry' ? (
        <div>
          <label htmlFor={`${ids}-registry`}>{t('ext.jargon.searchLabel')}</label>
          <TextInput
            id={`${ids}-registry`}
            value={registryQuery}
            onChange={(event) => setRegistryQuery(event.target.value)}
          />
          <div className="jargon-grid">
            {registryMatches.map((item) => (
              <article className="jargon-card" key={item.id}>
                <h4>{item.term}</h4>
                <p>{item.definition}</p>
                {item.tags.length > 0 && (
                  <p className="jargon-meta">{t('ext.jargon.tags', { tags: item.tags.join(', ') })}</p>
                )}
                <Button
                  variant={item.id === registryId ? 'primary' : 'default'}
                  onClick={() => setRegistryId(item.id)}
                >
                  {t('ext.jargon.clarifyRegistered')}
                </Button>
              </article>
            ))}
          </div>
          {registryMatches.length === 0 && (
            <p className="jargon-notice">{t('ext.jargon.noRegisteredMatches')}</p>
          )}
          {selectedContext && (
            <>
              <label htmlFor={`${ids}-definition`}>{t('ext.jargon.clarifyDefinition')}</label>
              <TextArea id={`${ids}-definition`} value={selectedContext.definition} readOnly />
            </>
          )}
        </div>
      ) : (
        <div>
          <label htmlFor={`${ids}-term`}>{t('ext.jargon.clarifyMeetingOnly')}</label>
          <TextInput
            id={`${ids}-term`}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
          />
          <label htmlFor={`${ids}-meaning`}>{t('ext.jargon.clarifyMeaning')}</label>
          <TextArea
            id={`${ids}-meaning`}
            value={meaning}
            onChange={(event) => setMeaning(event.target.value)}
            aria-describedby={`${ids}-meaning-hint`}
          />
          <p id={`${ids}-meaning-hint`} className="jargon-meta">
            {t('ext.jargon.clarifyMeaningHint')}
          </p>
        </div>
      )}

      <div className="jargon-actions">
        <Button
          variant="primary"
          disabled={disabled || submitting || !selectedLine}
          onClick={() => void submit()}
        >
          {submitting ? t('ext.jargon.clarifySaving') : t('ext.jargon.clarifySave')}
        </Button>
        <Button onClick={cancel}>{t('ext.jargon.clarifyCancel')}</Button>
      </div>

      <div role="status" aria-live="polite" className="jargon-meta">
        {status}
      </div>
      {error && <p role="alert" className="jargon-notice">{t('ext.failed', { error })}</p>}

      {saved && (
        <article className="jargon-card">
          <h4>{saved.evidence.map((evidence) => evidence.observed).join(', ')} → {saved.term}</h4>
          <p>{saved.definition}</p>
          <p className="jargon-meta">{t('ext.jargon.userClarification')}</p>
          {saved.miniContextId === null && (
            <>
              <Button disabled={disabled || registering || registered} onClick={() => void register()}>
                {registering ? t('ext.jargon.clarifyRegistering') : t('ext.jargon.clarifyRegister')}
              </Button>
              {registered && <p className="jargon-meta">{t('ext.jargon.clarifyRegisteredOk')}</p>}
              {registerError && (
                <p role="alert" className="jargon-notice">
                  {t('ext.jargon.clarifyRegisterFailed', { detail: registerError })}
                </p>
              )}
              {duplicate && (
                <div role="alert">
                  <p>{t('ext.jargon.clarifyDuplicate', { term: duplicate.term })}</p>
                  <label htmlFor={`${ids}-existing`}>{t('ext.jargon.clarifyExistingDefinition')}</label>
                  <TextArea id={`${ids}-existing`} value={duplicate.definition} readOnly />
                  <div className="jargon-actions">
                    <Button variant="primary" disabled={registering} onClick={() => void invokeUseExisting()}>
                      {t('ext.jargon.clarifyDuplicateConfirm')}
                    </Button>
                    <Button disabled={registering} onClick={() => setDuplicate(null)}>
                      {t('ext.jargon.clarifyDuplicateCancel')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </article>
      )}
    </section>
  );
}
