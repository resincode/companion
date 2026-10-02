import { useEffect, useId, useMemo, useState } from 'react';
import { t } from '@meetcc/shared/i18n';
import type { Meeting, MiniContext } from '@meetcc/shared';
import {
  getMiniContexts,
  watchStorage,
  MINI_CONTEXTS_KEY,
} from '@meetcc/shared';
import { Button, TextArea } from '@meetcc/ui';

function appendContextTagsToMap(map: Map<string, MiniContext[]>, c: MiniContext): void {
  for (let j = 0; j < c.tags.length; j++) {
    const tg = c.tags[j].toLowerCase();
    let list = map.get(tg);
    if (!list) {
      list = [];
      map.set(tg, list);
    }
    list.push(c);
  }
}

function buildTagToContextsMap(contexts: MiniContext[]): Map<string, MiniContext[]> {
  const map = new Map<string, MiniContext[]>();
  for (let i = 0; i < contexts.length; i++) {
    appendContextTagsToMap(map, contexts[i]);
  }
  return map;
}

interface Props {
  meeting: Meeting;
  context: string;
  tags: string[];
  onContextChange(context: string): void;
  onTagsChange(tags: string[]): void;
  onSave(): void;
  saving: boolean;
}

export function ContextCard(props: Props) {
  return <ContextCardEditor key={props.meeting.id} {...props} />;
}

function ContextCardEditor({
  context, tags: selectedTags, onContextChange, onTagsChange, onSave, saving,
}: Props) {
  const inputId = useId();
  const [open, setOpen] = useState(!context.trim() && selectedTags.length === 0);
  const [availableContexts, setAvailableContexts] = useState<MiniContext[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getMiniContexts().then((contexts) => {
        if (alive) setAvailableContexts(contexts);
      }).catch(() => undefined);
    };
    reload();
    const unsubscribe = watchStorage(reload, [MINI_CONTEXTS_KEY]);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);


  const tagToContexts = useMemo(() => buildTagToContextsMap(availableContexts), [availableContexts]);

  const uniqueTags = useMemo(() => {
    return Array.from(tagToContexts.keys()).sort();
  }, [tagToContexts]);

  const tagCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [tg, list] of tagToContexts.entries()) {
      map.set(tg, list.length);
    }
    return map;
  }, [tagToContexts]);


  const toggleTag = (tag: string) => {
    const lower = tag.toLowerCase();
    const isAttached = selectedTags.some((t) => t.toLowerCase() === lower);
    const nextTags = isAttached
      ? selectedTags.filter((t) => t.toLowerCase() !== lower)
      : [...selectedTags, lower];
    onTagsChange(nextTags);
  };

  const isCtxActive = (ctx: MiniContext) => {
    const termLower = ctx.term.toLowerCase();
    return selectedTags.some(
      (t) => t.toLowerCase() === termLower || ctx.tags.some((tg) => tg.toLowerCase() === t.toLowerCase()),
    );
  };

  const toggleSingle = (ctx: MiniContext) => {
    const termLower = ctx.term.toLowerCase();
    const isAttached = selectedTags.some((t) => t.toLowerCase() === termLower);
    const nextTags = isAttached
      ? selectedTags.filter((t) => t.toLowerCase() !== termLower)
      : [...selectedTags, termLower];
    onTagsChange(nextTags);
  };

  const hasContext = !!context.trim() || selectedTags.length > 0;

  return (
    <div className="summary-context-card">
      <Button
        type="button"
        className="summary-context-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="summary-context-title">
          {t('ext.summary.contextTitle')}
          {hasContext && <span className="context-indicator" />}
        </span>
        <span className="summary-context-preview dim">
          {context.trim()
            ? context.trim().slice(0, 45) + (context.trim().length > 45 ? '…' : '')
            : selectedTags.length > 0
              ? selectedTags.map((tg) => `#${tg}`).join(' ')
              : t('ext.summary.contextHint')}
        </span>
        <span className="summary-context-arrow">{open ? '▲' : '▼'}</span>
      </Button>
      {open && (
        <div className="summary-context-body">
          <label htmlFor={inputId}>{t('ext.context.contextLabel')}</label>
          <TextArea
            id={inputId}
            className="summary-context-input"
            value={context}
            placeholder={t('ext.summary.contextPlaceholder')}
            onChange={(e) => onContextChange(e.target.value)}
            disabled={saving}
            rows={3}
          />
          {selectedTags.length > 0 && (
            <div className="summary-active-tags-row">
              <span className="summary-active-tags-label">{t('ext.header.activeTags')}:</span>
              <div className="summary-active-tags-list">
                {selectedTags.map((tg) => (
                  <span key={tg} className="summary-active-tag-chip">
                    #{tg}
                    <Button
                      type="button"
                      className="summary-active-tag-remove"
                      onClick={() => void toggleTag(tg)}
                      disabled={saving}
                      aria-label={t('ext.header.close')}
                    >
                      ✕
                    </Button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="summary-context-quick-insert">
            <span className="quick-insert-label">
              ✦ {t('ext.header.insertContext')}:
            </span>
            <div className="quick-insert-tags" title={t('ext.header.insertByTag')}>
              {uniqueTags.map((tg) => {
                const count = tagCounts.get(tg) ?? 0;
                const isAttached = selectedTags.some((t) => t.toLowerCase() === tg.toLowerCase());
                return (
                  <Button
                    key={tg}
                    type="button"
                    className={`quick-insert-tag-btn ${isAttached ? 'active' : ''}`}
                    onClick={() => void toggleTag(tg)}
                    disabled={saving}
                    title={t('ext.header.insertAllWithTag', { tag: tg, count })}
                  >
                    {isAttached ? '✓' : '+'} #{tg} <span className="tag-count">({count})</span>
                  </Button>
                );
              })}
              {availableContexts.length > 0 && (
                <div className="quick-insert-single-wrap">
                  <Button
                    type="button"
                    className="quick-insert-single-btn"
                    onClick={() => setPopoverOpen((v) => !v)}
                  >
                    ✦ {t('ext.header.insertSingle')} ▾
                  </Button>
                  {popoverOpen && (
                    <div className="summary-context-popover">
                      <div className="summary-popover-head">
                        <span className="summary-popover-title">{t('ext.header.contextPopoverTitle')}</span>
                        <Button
                          type="button"
                          className="summary-popover-close"
                          onClick={() => setPopoverOpen(false)}
                          aria-label={t('ext.header.close')}
                        >
                          ✕
                        </Button>
                      </div>
                      <div className="summary-popover-item-list">
                        {availableContexts.map((ctx) => {
                          const active = isCtxActive(ctx);
                          return (
                            <Button
                              key={ctx.id}
                              type="button"
                              className={`summary-ctx-item-btn ${active ? 'active' : ''}`}
                              onClick={() => void toggleSingle(ctx)}
                              disabled={saving}
                            >
                              <span className="ctx-item-term">
                                {active ? '✓ ' : ''}{ctx.term}
                              </span>
                              <span className="dim ctx-item-def">{ctx.definition}</span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {availableContexts.length === 0 && (
                <span className="dim" style={{ fontSize: 11 }}>
                  {t('ext.header.noContextsAvailable')}
                </span>
              )}
            </div>
          </div>
          <div className="summary-context-footer">
            <span className="dim" style={{ fontSize: 11 }}>
              {t('ext.summary.contextHint')}
            </span>
            <Button type="button" className="small" variant="primary" onClick={onSave} disabled={saving}>
              {saving ? t('ext.context.saving') : t('ext.summary.contextSave')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
