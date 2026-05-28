import { useId, useMemo, useState } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import { SEVERITY_ORDER, type Gap, type PageApproval, type PageData, type RunData } from '../types';
import { FindingRow } from './FindingRow';

interface Props {
  page: PageData;
  approval: PageApproval | null;
  onToggleGap: (gapId: string) => void;
  onComment: (gapId: string, text: string) => void;
  onCopyPrompt: (gap: Gap) => void;
  onCopyTerminal: () => void;
  runDir: string;
  isOfflineMock: boolean;
}

type FilterKey = 'all' | 'functional' | 'a11y' | 'brand' | 'compliance';

function classify(gap: Gap): FilterKey {
  const sig = (gap.signals ?? []).join(' ');
  const dim = (gap.dimension || '').toLowerCase();
  if (gap.category === 'functional') return 'functional';
  if (sig.includes('a11y') || dim.includes('a11y') || dim.includes('accessibility')) return 'a11y';
  if (dim.includes('brand') || dim.includes('visual') || dim.includes('design')) return 'brand';
  if (dim.includes('compliance') || dim.includes('legal')) return 'compliance';
  return 'a11y';
}

/** Findings list with filter chips, expandable rows, row-anchored controls. */
export function FindingsPanel({ page, approval, onToggleGap, onComment, onCopyPrompt, onCopyTerminal, runDir, isOfflineMock }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  const [filter, setFilter] = useState<FilterKey>('all');
  const panelId = useId();

  const gaps = useMemo(() => {
    const list = [...(page.audit?.gaps ?? [])];
    list.sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));
    return list;
  }, [page]);

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: gaps.length, functional: 0, a11y: 0, brand: 0, compliance: 0 };
    for (const g of gaps) c[classify(g)] += 1;
    return c;
  }, [gaps]);

  const visible = filter === 'all' ? gaps : gaps.filter((g) => classify(g) === filter);

  const collapsed = ui.collapsed.findings;

  return (
    <section className={`rf-card rf-findings ${collapsed ? 'rf-collapsed' : ''}`}>
      <header className="rf-card-header">
        <button
          className="rf-card-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={() => dispatch({ type: 'togglePanel', key: 'findings' })}
          type="button"
        >
          <span className="rf-card-toggle-icon" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <h2 className="rf-card-title">{t('findings.heading', r)}</h2>
        </button>
        <div className="rf-card-actions">
          <button className="rf-btn rf-btn-ghost" onClick={onCopyTerminal} type="button">
            {t('findings.copyTerminal', r)}
          </button>
        </div>
      </header>

      {!collapsed && (
        <div id={panelId}>
          <div className="rf-filter-chips" role="tablist">
            {(['all', 'functional', 'a11y', 'brand', 'compliance'] as FilterKey[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={filter === k}
                className={`rf-chip-btn ${filter === k ? 'on' : ''}`}
                onClick={() => setFilter(k)}
                type="button"
              >
                {k === 'all' ? t('findings.filter.all', r)
                  : k === 'functional' ? t('findings.filter.func', r)
                  : k === 'a11y' ? t('findings.filter.a11y', r)
                  : k === 'brand' ? t('findings.filter.brand', r)
                  : t('findings.filter.compli', r)}
                <span className="rf-chip-count">{counts[k]}</span>
              </button>
            ))}
          </div>

          {isOfflineMock && (
            <p className="rf-note">Showing demo findings — connect a real run with <span className="rf-mono">npx reframe review &lt;runDir&gt;</span>.</p>
          )}

          {visible.length === 0 ? (
            <p className="rf-empty">{t('findings.empty', r)}</p>
          ) : (
            <ul className="rf-finding-list">
              {visible.map((g) => (
                <FindingRow
                  key={g.id}
                  gap={g}
                  decision={approval?.gaps?.[g.id] ?? 'apply'}
                  onToggle={() => onToggleGap(g.id)}
                  onComment={(text) => onComment(g.id, text)}
                  onCopyPrompt={() => onCopyPrompt(g)}
                  runDir={runDir}
                  pageRoute={page.route}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
