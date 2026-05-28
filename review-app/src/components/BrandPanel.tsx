import { useId, useState } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import type { BrandTokens } from '../types';

interface Props {
  brand: BrandTokens | null | undefined;
}

const COLOR_ORDER = ['primary', 'background', 'surface', 'border', 'text', 'muted', 'success', 'danger', 'error', 'warning'];

/** Visual brand panel — swatches, type ladder, voice chips, raw JSON in details. */
export function BrandPanel({ brand }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  const [copied, setCopied] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [verifyLog, setVerifyLog] = useState<string>('');
  const panelId = useId();

  const collapsed = ui.collapsed.brand;

  if (!brand) {
    return (
      <section className="rf-card rf-brand">
        <header className="rf-card-header">
          <h2 className="rf-card-title">{t('brand.heading', r)}</h2>
        </header>
        <p className="rf-empty">No brand tokens detected for this run.</p>
      </section>
    );
  }

  const copyHex = async (name: string, hex: string) => {
    try { await navigator.clipboard.writeText(hex); } catch {}
    setCopied(name);
    window.setTimeout(() => setCopied(null), 1500);
  };

  const colors = brand.colors ?? {};
  const sortedColors = [
    ...COLOR_ORDER.filter((k) => k in colors),
    ...Object.keys(colors).filter((k) => !COLOR_ORDER.includes(k)),
  ].map((k) => [k, colors[k]] as const);

  // Split brand.voice into short chip-sized descriptors. We split on
  // sentence terminators only (`.`, `;`) — splitting on commas chopped
  // single sentences into orphan fragments ("precise" / "and system-
  // oriented" from "functional, precise, and system-oriented"). Now: one
  // sentence → one chip, then drop empty/long/orphan ones.
  const voiceDescriptors = (brand.voice || '')
    .split(/[.;]/)
    .map((s) => s.trim().replace(/^and\s+/i, ''))
    .filter((s) => s.length > 4 && s.length < 80)
    .slice(0, 4);

  return (
    <section className={`rf-card rf-brand ${collapsed ? 'rf-collapsed' : ''}`}>
      <header className="rf-card-header">
        <button
          className="rf-card-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={() => dispatch({ type: 'togglePanel', key: 'brand' })}
          type="button"
        >
          <span className="rf-card-toggle-icon" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <h2 className="rf-card-title">{t('brand.heading', r)}{brand.name ? ` · ${brand.name}` : ''}</h2>
        </button>
      </header>

      {!collapsed && (
        <div id={panelId} className="rf-brand-body">
          {sortedColors.length > 0 && (
            <div className="rf-brand-section">
              <h3 className="rf-brand-sub">{t('brand.colors', r)}</h3>
              <p className="rf-brand-hint">{t('brand.copyHex', r)}</p>
              <div className="rf-swatch-grid">
                {sortedColors.map(([name, hex]) => (
                  <button key={name} className="rf-swatch" onClick={() => copyHex(name, hex)} type="button">
                    <span className="rf-swatch-chip" style={{ background: hex }} aria-hidden />
                    <span className="rf-swatch-name">{name}</span>
                    <span className="rf-swatch-hex">{copied === name ? t('brand.copied', r) : hex}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rf-brand-section">
            <h3 className="rf-brand-sub">{t('brand.type', r)}</h3>
            <div className="rf-type-ladder">
              <div className="rf-type-row" style={{ fontSize: 32, lineHeight: 1.1, fontFamily: 'var(--rf-font-display)' }}>Display · 32</div>
              <div className="rf-type-row" style={{ fontSize: 24, lineHeight: 1.2, fontFamily: 'var(--rf-font-display)' }}>Heading · 24</div>
              <div className="rf-type-row" style={{ fontSize: 18, lineHeight: 1.4 }}>Subhead · 18</div>
              <div className="rf-type-row" style={{ fontSize: 16, lineHeight: 1.5 }}>Body · 16</div>
              <div className="rf-type-row" style={{ fontSize: 13, lineHeight: 1.4, color: 'var(--rf-muted)' }}>Caption · 13</div>
            </div>
          </div>

          {voiceDescriptors.length > 0 && (
            <div className="rf-brand-section">
              <h3 className="rf-brand-sub">{t('brand.voice', r)}</h3>
              <div className="rf-voice-chips">
                {voiceDescriptors.map((v, i) => (
                  <span key={i} className="rf-voice-chip">{v}</span>
                ))}
              </div>
            </div>
          )}

          <details className="rf-bible-details">
            <summary>{t('brand.bibleOpen', r)}</summary>
            <pre className="rf-mono rf-pre">{JSON.stringify(brand, null, 2)}</pre>
          </details>

          <div className="rf-brand-rerun">
            <button
              className="rf-btn rf-btn-ghost rf-btn-sm"
              onClick={async () => {
                if (verifyState === 'running') return;
                setVerifyState('running');
                setVerifyLog('');
                try {
                  const r0 = await fetch('/api/verify', { method: 'POST' });
                  if (!r0.ok) throw new Error(`verify trigger failed (${r0.status})`);
                  // Poll status every 1.5s until done.
                  const startedAt = Date.now();
                  const tick = async () => {
                    try {
                      const s = await fetch('/api/verify/status');
                      const j = await s.json();
                      setVerifyLog((j.log as string) || '');
                      if (!j.running) {
                        setVerifyState('done');
                        return;
                      }
                    } catch { /* keep polling */ }
                    if (Date.now() - startedAt > 5 * 60_000) {
                      setVerifyState('error');
                      return;
                    }
                    window.setTimeout(tick, 1500);
                  };
                  window.setTimeout(tick, 1000);
                } catch {
                  setVerifyState('error');
                }
              }}
              disabled={verifyState === 'running'}
              type="button"
            >
              {verifyState === 'running' ? 'Re-verifying…' : `Re-verify this run ↗`}
            </button>
            <p className="rf-brand-hint">
              Re-runs Agent 5 (verify) against this run dir. To edit the brand bible, open <span className="rf-mono">brand.resolved.json</span> in this run dir and re-trigger.
            </p>
            {verifyState !== 'idle' && verifyLog && (
              <details open className="rf-bible-details">
                <summary>{verifyState === 'done' ? 'Verify finished' : verifyState === 'error' ? 'Verify failed' : 'Verify log'}</summary>
                <pre className="rf-mono rf-pre">{verifyLog}</pre>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
