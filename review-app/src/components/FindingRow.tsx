import { useId, useState } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import type { Gap } from '../types';

interface Props {
  gap: Gap;
  decision: 'apply' | 'skip';
  selected: boolean;
  onToggleSelect: () => void;
  onToggle: () => void;
  onComment: (text: string) => void;
  onCopyPrompt: () => void;
}

/** One finding. Collapsed = severity + plain claim. Expanded = why + fix + actions. */
export function FindingRow({ gap, decision, selected, onToggleSelect, onToggle, onComment, onCopyPrompt }: Props) {
  const { ui } = useUi();
  const r = ui.register;
  const [open, setOpen] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const bodyId = useId();

  const claim = (r === 'vibe' && gap.plain) ? gap.plain : gap.description;
  const why = gap.whyItMatters;
  const fix = gap.recommendation;
  const sev = gap.severity;

  const handleCopy = () => {
    onCopyPrompt();
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const submitComment = () => {
    const text = draft.trim();
    if (!text) return;
    onComment(text);
    setDraft('');
    setCommenting(false);
  };

  return (
    <li className={`rf-finding ${decision === 'skip' ? 'rf-skipped' : ''} ${selected ? 'rf-selected' : ''}`}>
      <div className="rf-finding-row-wrap">
        <label
          className="rf-finding-check"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select finding ${gap.id}`}
        >
          <input type="checkbox" checked={selected} onChange={onToggleSelect} />
        </label>
        <button
          className="rf-finding-row"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          type="button"
        >
          <span className={`rf-sev rf-sev-${sev}`}>{sev.toUpperCase()}</span>
          <span className="rf-finding-claim">{claim}</span>
          {gap.dimension && <span className="rf-dim">{gap.dimension}</span>}
          <span className="rf-finding-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        </button>
      </div>

      {open && (
        <div id={bodyId} className="rf-finding-body">
          {why && (
            <div className="rf-finding-block">
              <h4 className="rf-finding-sub">{t('findings.whyHeader', r)}</h4>
              <p>{why}</p>
            </div>
          )}
          {fix && (
            <div className="rf-finding-block">
              <h4 className="rf-finding-sub">{t('findings.fixHeader', r)}</h4>
              <p>{fix}</p>
            </div>
          )}
          {(gap.signals && gap.signals.length > 0) && (
            <div className="rf-signals">
              {gap.signals.map((s) => (
                <span key={s} className="rf-signal">{s}</span>
              ))}
            </div>
          )}

          {commenting && (
            <form
              className="rf-comment-form"
              onSubmit={(e) => { e.preventDefault(); submitComment(); }}
            >
              <input
                autoFocus
                className="rf-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setCommenting(false); setDraft(''); } }}
                placeholder={t('findings.commentPlaceholder', r)}
              />
              <button type="submit" className="rf-btn rf-btn-primary rf-btn-sm">{t('common.send', r)}</button>
              <button type="button" className="rf-btn rf-btn-ghost rf-btn-sm" onClick={() => { setCommenting(false); setDraft(''); }}>{t('common.cancel', r)}</button>
            </form>
          )}
        </div>
      )}

      <div className="rf-finding-strip">
        {decision === 'apply' ? (
          <>
            <span className="rf-status-pill rf-status-apply">{t('findings.willFix', r)}</span>
            <button className="rf-btn rf-btn-ghost rf-btn-sm" onClick={onToggle} type="button">{t('findings.skip', r)}</button>
          </>
        ) : (
          <>
            <span className="rf-status-pill rf-status-skip">{t('findings.skipped', r)}</span>
            <button className="rf-btn rf-btn-ghost rf-btn-sm" onClick={onToggle} type="button">{t('findings.undo', r)}</button>
          </>
        )}
        <button
          className="rf-btn rf-btn-ghost rf-btn-sm"
          onClick={() => setCommenting((c) => !c)}
          type="button"
        >
          {t('findings.comment', r)}
        </button>
        <button className="rf-btn rf-btn-ghost rf-btn-sm" onClick={handleCopy} type="button">
          {copied ? t('findings.copyPromptDone', r) : t('findings.copyPrompt', r)}
        </button>
      </div>
    </li>
  );
}
