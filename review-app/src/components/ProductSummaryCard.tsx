import { useUi } from '../store';
import { t } from '../copy';
import type { RunData } from '../types';

interface Props {
  data: RunData;
  activeRoute?: string;
  findingsOnRoute: number;
  highOnRoute: number;
}

/**
 * 5-second answer: what this app does, how many screens, what's the headline.
 * Generated from scope.productGoal + page counts + finding counts.
 */
export function ProductSummaryCard({ data, activeRoute, findingsOnRoute, highOnRoute }: Props) {
  const { ui } = useUi();
  const r = ui.register;
  const goal = data.scope?.productGoal?.trim() || data.state.projectSlug;
  const totalScreens = data.pages.length;

  return (
    <section className="rf-card rf-summary">
      <header className="rf-card-header">
        <h2 className="rf-card-title">{t('summary.heading', r)}</h2>
        {activeRoute && <span className="rf-route">{activeRoute}</span>}
      </header>
      <p className="rf-summary-goal">{goal}</p>
      <div className="rf-summary-stats">
        <div className="rf-stat">
          <span className="rf-stat-num">{totalScreens}</span>
          <span className="rf-stat-label">{t('summary.screensCount', r)}</span>
        </div>
        <div className="rf-stat">
          <span className="rf-stat-num">{findingsOnRoute}</span>
          <span className="rf-stat-label">{t('summary.findingsCount', r)}</span>
        </div>
        {highOnRoute > 0 && (
          <div className="rf-stat rf-stat-warn">
            <span className="rf-stat-num">{highOnRoute}</span>
            <span className="rf-stat-label">HIGH</span>
          </div>
        )}
      </div>
    </section>
  );
}
