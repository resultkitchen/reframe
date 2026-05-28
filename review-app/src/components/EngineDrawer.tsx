import { useUi } from '../store';
import { t } from '../copy';
import type { RunData } from '../types';

interface Props {
  data: RunData | null;
}

/** Slide-in drawer. Hidden by default. Houses run internals + telemetry/raw JSON. */
export function EngineDrawer({ data }: Props) {
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
          {data ? (
            <>
              <h3 className="rf-brand-sub">State</h3>
              <pre className="rf-mono rf-pre">{JSON.stringify(data.state, null, 2)}</pre>
              <h3 className="rf-brand-sub">Approvals</h3>
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
