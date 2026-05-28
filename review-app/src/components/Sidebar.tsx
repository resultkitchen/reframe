import { useUi } from '../store';
import { t } from '../copy';
import type { RunData } from '../types';

interface Props {
  data: RunData;
  activeSlug: string | null;
  overviewSlug: string;
  onSelect: (slug: string) => void;
  overview: { findings: number; pagesWithFindings: number; totalPages: number; critical: number; high: number };
}

/** Left-side screen list. Collapsible. Shows live approval/health state. */
export function Sidebar({ data, activeSlug, overviewSlug, onSelect, overview }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;

  if (!ui.sidebar) {
    return (
      <aside className="rf-sidebar rf-sidebar-collapsed">
        <button
          className="rf-sidebar-expand"
          onClick={() => dispatch({ type: 'toggleSidebar' })}
          aria-label={t('sidebar.expand', r)}
          title={t('sidebar.expand', r)}
          type="button"
        >
          ›
        </button>
      </aside>
    );
  }

  return (
    <aside className="rf-sidebar">
      <div className="rf-sidebar-header">
        <h2 className="rf-sidebar-title">{t('sidebar.heading', r)}</h2>
        <button
          className="rf-sidebar-collapse"
          onClick={() => dispatch({ type: 'toggleSidebar' })}
          aria-label={t('sidebar.collapse', r)}
          title={t('sidebar.collapse', r)}
          type="button"
        >
          ‹
        </button>
      </div>

      {data.pages.length > 0 && (
        <button
          className={`rf-page-item rf-overview ${activeSlug === overviewSlug ? 'active' : ''}`}
          onClick={() => onSelect(overviewSlug)}
          type="button"
        >
          <span className="rf-page-title">{t('sidebar.overview', r)}</span>
          <span className="rf-page-sub">
            {overview.findings} {overview.findings === 1 ? 'finding' : 'findings'} · {overview.pagesWithFindings}/{overview.totalPages} screens
          </span>
          <span className="rf-badge-row">
            {overview.critical > 0 && <span className="rf-chip rf-chip-critical">{overview.critical} critical</span>}
            {overview.high > 0 && <span className="rf-chip rf-chip-high">{overview.high} high</span>}
          </span>
        </button>
      )}

      <div className="rf-sidebar-list">
        {data.pages.map((p) => {
          const approval = data.approvals.pages[p.slug];
          const health = p.audit?.health?.status ?? 'pending';
          const gaps = p.audit?.gaps?.length ?? 0;
          return (
            <button
              key={p.slug}
              className={`rf-page-item ${p.slug === activeSlug ? 'active' : ''}`}
              onClick={() => onSelect(p.slug)}
              type="button"
            >
              <span className="rf-page-title">{p.slug}</span>
              <span className="rf-page-sub">{p.route || '/'}</span>
              <span className="rf-badge-row">
                {health === 'ok'
                  ? <span className="rf-chip rf-chip-ok">Loads</span>
                  : health === 'pending'
                    ? <span className="rf-chip rf-chip-muted">Pending</span>
                    : <span className="rf-chip rf-chip-critical">{health}</span>}
                {gaps > 0 && <span className="rf-chip rf-chip-info">{gaps} {gaps === 1 ? 'finding' : 'findings'}</span>}
                {approval && (approval.decision === 'apply'
                  ? <span className="rf-chip rf-chip-ok">Approved</span>
                  : <span className="rf-chip rf-chip-muted">Skipped</span>)}
              </span>
            </button>
          );
        })}
      </div>

      <button
        className="rf-sidebar-engine"
        onClick={() => dispatch({ type: 'setEngineDrawer', open: true })}
        type="button"
      >
        {t('sidebar.engineDrawer', r)} ›
      </button>
    </aside>
  );
}
