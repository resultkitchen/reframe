import { useState, useEffect, useRef } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import type { RunData } from '../types';

interface Props {
  data: RunData | null;
  isOfflineMock: boolean;
  saving: boolean;
  savedAt: number | null;
  onPrimary: () => void;
  primaryDisabled?: boolean;
}

/**
 * Top bar — single row.
 *   wordmark · status dot · run-info popover · auto-saved indicator
 *   · Vibe/Technical toggle · primary action
 */
export function TopBar({ data, isOfflineMock, saving, savedAt, onPrimary, primaryDisabled }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPopoverOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [popoverOpen]);

  const savedLabel = (() => {
    if (saving) return '…';
    if (!savedAt) return '';
    const s = Math.floor((Date.now() - savedAt) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  })();

  return (
    <header className="rf-topbar">
      <div className="rf-topbar-left">
        <div className="rf-logo">R</div>
        <span className="rf-wordmark">Reframe</span>
        <span className="rf-tagline">{t('topbar.tagline', r)}</span>
      </div>

      <div className="rf-topbar-mid">
        <span className={`rf-status ${isOfflineMock ? 'offline' : 'online'}`}>
          <span className="rf-status-dot" />
          {isOfflineMock ? t('topbar.serverOffline', r) : t('topbar.serverOnline', r)}
        </span>

        {data && (
          <div className="rf-runinfo" ref={popRef}>
            <button
              className="rf-runinfo-button"
              onClick={() => setPopoverOpen((o) => !o)}
              aria-expanded={popoverOpen}
              type="button"
            >
              {data.state.projectSlug}
              <span className="rf-runinfo-caret" aria-hidden>▾</span>
            </button>
            {popoverOpen && (
              <div className="rf-runinfo-popover" role="dialog" aria-label={t('topbar.runInfo', r)}>
                <div className="rf-popover-row">
                  <span className="rf-popover-label">Project</span>
                  <span className="rf-popover-value">{data.state.projectSlug}</span>
                </div>
                <div className="rf-popover-row">
                  <span className="rf-popover-label">{t('topbar.runDirLabel', r)}</span>
                  <span className="rf-popover-value rf-mono" title={data.runDir}>{data.runDir}</span>
                </div>
                {data.isGitRepo === false && (
                  <div className="rf-popover-warn">{t('topbar.nonGitWorkspace', r)}</div>
                )}
              </div>
            )}
          </div>
        )}

        {savedAt && (
          <span className="rf-autosaved" title={new Date(savedAt).toLocaleTimeString()}>
            {t('topbar.autosaved', r)} · {savedLabel}
          </span>
        )}
      </div>

      <div className="rf-topbar-right">
        <div className="rf-register-toggle" role="tablist" aria-label={t('topbar.toggleAria', r)}>
          <button
            role="tab"
            aria-selected={r === 'vibe'}
            className={r === 'vibe' ? 'on' : ''}
            onClick={() => dispatch({ type: 'setRegister', value: 'vibe' })}
            type="button"
          >
            {t('topbar.toggleVibe', r)}
          </button>
          <button
            role="tab"
            aria-selected={r === 'technical'}
            className={r === 'technical' ? 'on' : ''}
            onClick={() => dispatch({ type: 'setRegister', value: 'technical' })}
            type="button"
          >
            {t('topbar.toggleTechnical', r)}
          </button>
        </div>

        <button
          className="rf-btn rf-btn-primary"
          onClick={onPrimary}
          disabled={primaryDisabled}
          title={t('topbar.primaryHint', r)}
          type="button"
        >
          {t('topbar.primary', r)}
          <span aria-hidden> ↗</span>
        </button>
      </div>
    </header>
  );
}
