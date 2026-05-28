import { useUi } from '../store';
import { t } from '../copy';
import type { RunData } from '../types';
import type { TelemetryData } from '../App';

interface Props {
  data: RunData | null;
  telemetry?: TelemetryData | null;
}

/**
 * Slide-in drawer. Hidden by default. Houses run internals — raw state, the
 * approvals ledger, and (when present) cross-run pattern insights from
 * /api/telemetry ("you've skipped 14/17 low-severity a11y findings — hide
 * by default?"). Fails open: telemetry section just doesn't render when
 * the endpoint is offline.
 */
export function EngineDrawer({ data, telemetry }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  if (!ui.engineDrawer) return null;

  return (
    <div className="rf-drawer-scrim" onClick={() => dispatch({ type: 'setEngineDrawer', open: false })}>
      <aside className="rf-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('sidebar.engineDrawer', r)}>
        <header className="rf-drawer-header">
          <h2>{t('sidebar.engineDrawer', r)}</h2>
          <button
            className="rf-btn rf-btn-ghost rf-btn-sm"
            onClick={() => dispatch({ type: 'setEngineDrawer', open: false })}
            type="button"
          >
            {t('common.close', r)}
          </button>
        </header>
        <div className="rf-drawer-body">
          {telemetry && telemetry.insights.length > 0 && (
            <section className="rf-brand-section">
              <h3 className="rf-brand-sub">
                Cross-run patterns · scanned {telemetry.scannedRuns} runs · {telemetry.totalDecisions} decisions
              </h3>
              <ul className="rf-insight-list">
                {telemetry.insights.map((i) => (
                  <li key={`${i.axis}:${i.value}`} className="rf-insight">
                    <span className="rf-insight-rate">{Math.round(i.skipRate * 100)}%</span>
                    <div className="rf-insight-body">
                      <div className="rf-insight-headline">{i.headline}</div>
                      <div className="rf-insight-meta">
                        {i.axis} · <span className="rf-mono">{i.value}</span> · {i.applies} kept · {i.skips} skipped
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data ? (
            <>
              <h3 className="rf-brand-sub">Run state</h3>
              <pre className="rf-mono rf-pre">{JSON.stringify(data.state, null, 2)}</pre>
              <h3 className="rf-brand-sub">Approvals ledger</h3>
              <pre className="rf-mono rf-pre">{JSON.stringify(data.approvals, null, 2)}</pre>
            </>
          ) : (
            <p className="rf-empty">No run data loaded.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
