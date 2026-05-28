import { useId } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import type { ScopeData } from '../types';

interface Props {
  scope: ScopeData | null | undefined;
  activeRoute?: string;
}

/** Parallel to BrandPanel. Surfaces data calls + broken contracts for the active route. */
export function ContractPanel({ scope, activeRoute }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  const collapsed = ui.collapsed.contract;
  const panelId = useId();

  const calls = (scope?.dataCalls ?? []).filter((c) => !activeRoute || c.page === activeRoute);
  const broken = (scope?.brokenContracts ?? []).filter((b) => !activeRoute || b.page === activeRoute || !b.page);

  return (
    <section className={`rf-card rf-contract ${collapsed ? 'rf-collapsed' : ''}`}>
      <header className="rf-card-header">
        <button
          className="rf-card-toggle"
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={() => dispatch({ type: 'togglePanel', key: 'contract' })}
          type="button"
        >
          <span className="rf-card-toggle-icon" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <h2 className="rf-card-title">{t('contract.heading', r)}</h2>
        </button>
      </header>

      {!collapsed && (
        <div id={panelId} className="rf-contract-body">
          <div className="rf-contract-section">
            <h3 className="rf-brand-sub">{t('contract.callsHeading', r)}</h3>
            {calls.length === 0 ? (
              <p className="rf-empty">{t('contract.noCalls', r)}</p>
            ) : (
              <table className="rf-table">
                <thead><tr><th>Route</th><th>Kind</th><th>Target</th></tr></thead>
                <tbody>
                  {calls.map((c, i) => (
                    <tr key={i}>
                      <td className="rf-mono">{c.page}</td>
                      <td><span className={`rf-chip rf-chip-${c.kind === 'mutation' ? 'high' : 'info'}`}>{c.kind}</span></td>
                      <td className="rf-mono">{c.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="rf-contract-section">
            <h3 className="rf-brand-sub">{t('contract.brokenHeading', r)}</h3>
            {broken.length === 0 ? (
              <p className="rf-empty">{t('contract.noBroken', r)}</p>
            ) : (
              <ul className="rf-broken-list">
                {broken.map((b, i) => (
                  <li key={i} className="rf-broken">
                    <span className="rf-mono rf-broken-loc">
                      {b.file ?? '(unknown file)'}{b.line ? `:${b.line}` : ''}
                    </span>
                    <p>{b.description || b.details}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {scope && (
            <details className="rf-bible-details">
              <summary>Show raw scope data</summary>
              <pre className="rf-mono rf-pre">{JSON.stringify({ dataCalls: scope.dataCalls, brokenContracts: scope.brokenContracts, dbTables: scope.dbTables }, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
