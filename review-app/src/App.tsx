import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UiProvider, useUi } from './store';
import { t } from './copy';
import type { Gap, PageApproval, RunData } from './types';
import { SEVERITY_ORDER } from './types';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ProductSummaryCard } from './components/ProductSummaryCard';
import { FindingsPanel } from './components/FindingsPanel';
import { PreviewPane } from './components/PreviewPane';
import { BrandPanel } from './components/BrandPanel';
import { ContractPanel } from './components/ContractPanel';
import { ResizableLayout } from './components/ResizableLayout';
import { EngineDrawer } from './components/EngineDrawer';

const OVERVIEW_SLUG = '__overview__';

let __backendProbe: Promise<RunData | null> | null = null;
function sharedBackendProbe(): Promise<RunData | null> {
  if (__backendProbe) return __backendProbe;
  __backendProbe = (async () => {
    try {
      const r = await fetch('/api/run');
      if (!r.ok) return null;
      return (await r.json()) as RunData;
    } catch {
      return null;
    }
  })();
  return __backendProbe;
}
function resetBackendProbe() { __backendProbe = null; }

function offlineMock(): RunData {
  return {
    runDir: './runs/demo',
    isGitRepo: false,
    state: { projectSlug: 'demo-app', startedAt: new Date().toISOString() },
    approvals: {
      pages: { dashboard: { decision: 'apply', gaps: { g1: 'apply', g2: 'skip', g3: 'apply' }, note: '', comments: [] } },
    },
    pages: [{
      slug: 'dashboard', route: '/dashboard', hasScreenshot: false, hasHtml: false,
      audit: {
        health: { healthy: true, status: 'ok', detail: 'Page loaded successfully.' },
        gaps: [
          { id: 'g1', category: 'functional', severity: 'critical', description: "Export button throws a silent TypeError — the click handler resolves before the data hook settles.", recommendation: 'Await the data hook in the click handler before serialising the payload.', plain: "The Export button doesn't actually export anything.", whyItMatters: 'Users hit Export, see no file, blame the app.', confidenceTier: 'high', signals: ['browser-evidence', 'severity-critical'], dimension: 'functional' },
          { id: 'g2', category: 'ux', severity: 'medium', description: 'Primary CTA fails WCAG 2.2 contrast — slate-400 text on a slate-500 background.', recommendation: 'Move to slate-50 on slate-900 (≥ 4.5:1).', plain: "The main button is hard to read.", whyItMatters: 'Anyone with low vision skips it.', confidenceTier: 'medium', signals: ['a11y-rule-violation'], dimension: 'a11y' },
          { id: 'g3', category: 'ux', severity: 'high', description: 'Search input lacks an associated <label> or aria-label.', recommendation: 'Add aria-label="Search" to the input element.', plain: "Screen readers can't tell what the search box is.", whyItMatters: 'Inaccessible to keyboard + screen-reader users.', confidenceTier: 'high', signals: ['a11y-rule-violation'], dimension: 'a11y' },
        ],
      },
    }],
    brand: {
      name: 'Demo Brand', colors: { primary: '#2563eb', surface: '#ffffff', background: '#f8fafc', text: '#0f172a', muted: '#64748b', success: '#15803d', danger: '#b91c1c', warning: '#92400e', border: '#e2e8f0' },
      voice: 'Direct. Utilitarian. No marketing fluff. Focused on issues and actions.',
    },
    scope: {
      productGoal: 'Demo run. Connect with: npx reframe review <runDir>.',
      dataCalls: [{ page: '/dashboard', kind: 'query', target: '/api/items', description: 'Loads dashboard items.' }],
      brokenContracts: [],
    },
  };
}

function applyBrandTokens(data: RunData | null) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  const colors = data?.brand?.colors;
  if (!colors) return;
  const map: Record<string, string> = {
    primary: '--rf-primary',
    background: '--rf-bg',
    surface: '--rf-surface',
    border: '--rf-border',
    text: '--rf-text',
    muted: '--rf-muted',
    success: '--rf-success',
    danger: '--rf-danger',
    error: '--rf-danger',
    warning: '--rf-warning',
  };
  for (const [k, cssVar] of Object.entries(map)) {
    const v = colors[k];
    if (typeof v === 'string' && v) root.setProperty(cssVar, v);
  }
}

export interface TelemetryInsight {
  axis: 'dimension' | 'severity';
  value: string;
  applies: number;
  skips: number;
  skipRate: number;
  headline: string;
}

export interface TelemetryData {
  schemaVersion: number;
  scannedRuns: number;
  totalDecisions: number;
  insights: TelemetryInsight[];
}

function AppInner() {
  const { ui } = useUi();
  const [data, setData] = useState<RunData | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [isOfflineMock, setIsOfflineMock] = useState(false);
  const [, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [currentApproval, setCurrentApproval] = useState<PageApproval | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchRunData = useCallback(async () => {
    setLoading(true);
    try {
      const json = await sharedBackendProbe();
      if (!json) throw new Error('offline');
      setData(json);
      setIsOfflineMock(false);
      if (json.pages.length > 0) setActiveSlug((s) => s ?? json.pages[0].slug);
      applyBrandTokens(json);
    } catch {
      const mock = offlineMock();
      setIsOfflineMock(true);
      setData(mock);
      setActiveSlug('dashboard');
      applyBrandTokens(mock);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRunData(); }, [fetchRunData]);

  // Cross-run telemetry insights. Skipped entirely in offline-mock mode
  // (where /api/run already 503'd) — there's no scenario where /api/telemetry
  // would respond when /api/run didn't, and probing it just adds another
  // 503 to the console for no gain.
  useEffect(() => {
    if (isOfflineMock) return;
    if (!data) return;
    (async () => {
      try {
        const r = await fetch('/api/telemetry');
        if (!r.ok) return;
        const j = await r.json();
        if (j && Array.isArray(j.insights)) setTelemetry(j);
      } catch { /* endpoint absent → leave null */ }
    })();
  }, [isOfflineMock, data]);

  // Sync the local approval draft when the active page changes.
  useEffect(() => {
    if (!data || !activeSlug || activeSlug === OVERVIEW_SLUG) {
      setCurrentApproval(null);
      return;
    }
    const page = data.pages.find((p) => p.slug === activeSlug);
    const existing = data.approvals.pages[activeSlug];
    if (existing) {
      setCurrentApproval({
        decision: existing.decision ?? 'apply',
        gaps: existing.gaps ?? {},
        note: existing.note ?? '',
        comments: existing.comments ?? [],
      });
    } else {
      const gaps: Record<string, 'apply' | 'skip'> = {};
      page?.audit?.gaps?.forEach((g) => { gaps[g.id] = 'apply'; });
      setCurrentApproval({ decision: 'apply', gaps, note: '', comments: [] });
    }
  }, [activeSlug, data]);

  const activePage = useMemo(
    () => (activeSlug && activeSlug !== OVERVIEW_SLUG)
      ? data?.pages.find((p) => p.slug === activeSlug) ?? null
      : null,
    [activeSlug, data],
  );

  const persistApproval = useCallback(async (slug: string, approval: PageApproval) => {
    if (isOfflineMock) {
      setSavedAt(Date.now());
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, approval }),
      });
      if (res.ok) {
        setData((prev) => prev ? { ...prev, approvals: { ...prev.approvals, pages: { ...prev.approvals.pages, [slug]: approval } } } : prev);
        setSavedAt(Date.now());
      }
    } catch { /* swallow — autosave is best-effort */ }
    finally { setSaving(false); }
  }, [isOfflineMock]);

  // Debounced auto-save whenever the draft changes.
  useEffect(() => {
    if (!activeSlug || !currentApproval || activeSlug === OVERVIEW_SLUG) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { persistApproval(activeSlug, currentApproval); }, 600);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [currentApproval, activeSlug, persistApproval]);

  const toggleGap = (gapId: string) => {
    if (!currentApproval) return;
    const nextDecision = currentApproval.gaps?.[gapId] === 'skip' ? 'apply' : 'skip';
    setCurrentApproval({ ...currentApproval, gaps: { ...currentApproval.gaps, [gapId]: nextDecision } });
  };

  /** Bulk-set a decision across many gap ids in one update. */
  const setBulkDecision = (gapIds: string[], decision: 'apply' | 'skip') => {
    if (!currentApproval || gapIds.length === 0) return;
    const next = { ...(currentApproval.gaps ?? {}) };
    for (const id of gapIds) next[id] = decision;
    setCurrentApproval({ ...currentApproval, gaps: next });
  };

  const addComment = (gapId: string, text: string) => {
    if (!currentApproval) return;
    const prefixed = `[${gapId}] ${text}`;
    setCurrentApproval({ ...currentApproval, comments: [...(currentApproval.comments ?? []), prefixed] });
  };

  const overview = useMemo(() => {
    let findings = 0, pagesWithFindings = 0, critical = 0, high = 0;
    if (data) {
      for (const p of data.pages) {
        const n = p.audit?.gaps?.length ?? 0;
        if (n > 0) pagesWithFindings += 1;
        findings += n;
        for (const g of p.audit?.gaps ?? []) {
          if (g.severity === 'critical') critical += 1;
          if (g.severity === 'high') high += 1;
        }
      }
    }
    return { findings, pagesWithFindings, totalPages: data?.pages.length ?? 0, critical, high };
  }, [data]);

  // Best-effort clipboard write. navigator.clipboard.writeText throws
  // synchronously on permission denial (and headless / non-https origins),
  // and the throw would otherwise interrupt the surrounding handler.
  const safeCopy = async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard?.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const onCopyPrompt = (g: Gap) => {
    if (!activePage) return;
    const block = `# Reframe finding\n\nRoute: ${activePage.route}\nSeverity: ${g.severity.toUpperCase()}\n\n## Issue\n${g.plain ?? g.description}\n\n## Why it matters\n${g.whyItMatters ?? '(none stated)'}\n\n## Suggested fix\n${g.recommendation}\n\n## File refs\n(none recorded by the audit)\n\nApply this fix and run \`npx reframe verify ${data?.runDir ?? '<runDir>'}\` when done.`;
    void safeCopy(block);
  };

  const onCopyTerminal = () => {
    if (!data) return;
    const cmd = `npx reframe rebuild --resume "${data.runDir}" --apply-mode pr`;
    void safeCopy(cmd);
  };

  const onPrimary = () => {
    if (!data) return;
    if (ui.register === 'vibe') {
      const lines: string[] = ['# Reframe — approved fixes'];
      for (const p of data.pages) {
        const a = data.approvals.pages[p.slug];
        if (!a) continue;
        const gaps = (p.audit?.gaps ?? []).filter((g) => a.gaps?.[g.id] !== 'skip');
        if (gaps.length === 0) continue;
        lines.push(`\n## ${p.slug}  (${p.route})`);
        for (const g of gaps) {
          lines.push(`- [${g.severity.toUpperCase()}] ${g.plain ?? g.description}`);
          lines.push(`  Fix: ${g.recommendation}`);
        }
      }
      lines.push(`\nResume with: npx reframe rebuild --resume "${data.runDir}" --apply-mode pr`);
      void safeCopy(lines.join('\n'));
      flashToast('Approved fixes + resume command copied. Paste into Claude Code or your terminal.');
    } else {
      const blob = new Blob([JSON.stringify(data.approvals, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'approvals.json';
      a.click();
      URL.revokeObjectURL(url);
      flashToast('approvals.json exported.');
    }
  };

  // Active-page-level finding tallies for the summary card.
  const findingsOnRoute = activePage?.audit?.gaps?.length ?? 0;
  const highOnRoute = (activePage?.audit?.gaps ?? []).filter((g) => SEVERITY_ORDER[g.severity] >= 3).length;

  return (
    <div className="rf-app">
      <TopBar
        data={data}
        isOfflineMock={isOfflineMock}
        saving={saving}
        savedAt={savedAt}
        onPrimary={onPrimary}
        primaryDisabled={!data}
      />

      <main className="rf-main">
        {data && (
          <Sidebar
            data={data}
            activeSlug={activeSlug}
            overviewSlug={OVERVIEW_SLUG}
            onSelect={setActiveSlug}
            overview={overview}
          />
        )}

        <section className="rf-workspace">
          {!data && <p className="rf-loading">Loading run data…</p>}

          {data && activeSlug === OVERVIEW_SLUG && (
            <OverviewView data={data} onPick={setActiveSlug} overview={overview} />
          )}

          {data && activePage && (
            <ResizableLayout
              left={
                <div className="rf-stack">
                  <ProductSummaryCard
                    data={data}
                    activeRoute={activePage.route}
                    findingsOnRoute={findingsOnRoute}
                    highOnRoute={highOnRoute}
                  />
                  <FindingsPanel
                    page={activePage}
                    approval={currentApproval}
                    onToggleGap={toggleGap}
                    onBulkDecision={setBulkDecision}
                    onComment={addComment}
                    onCopyPrompt={onCopyPrompt}
                    onCopyTerminal={onCopyTerminal}
                    runDir={data.runDir}
                    isOfflineMock={isOfflineMock}
                  />
                </div>
              }
              right={
                <div className="rf-stack">
                  <PreviewPane page={activePage} baseUrl={(data.scope as { baseUrl?: string } | undefined)?.baseUrl} />
                  <BrandPanel brand={data.brand} />
                  <ContractPanel scope={data.scope} activeRoute={activePage.route} />
                </div>
              }
            />
          )}
        </section>
      </main>

      <EngineDrawer data={data} telemetry={telemetry} />

      {toast && (
        <div className="rf-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}

      {isOfflineMock && (
        <div className="rf-offline-banner" role="status">
          Showing mock data — no run server reached.{' '}
          <button
            type="button"
            className="rf-btn rf-btn-ghost rf-btn-sm"
            onClick={() => { resetBackendProbe(); fetchRunData(); }}
          >
            {t('common.retry', ui.register)}
          </button>
        </div>
      )}
    </div>
  );
}

interface OverviewProps {
  data: RunData;
  onPick: (slug: string) => void;
  overview: { findings: number; pagesWithFindings: number; totalPages: number; critical: number; high: number };
}

function OverviewView({ data, onPick, overview }: OverviewProps) {
  const { ui } = useUi();
  const r = ui.register;
  const summary = data.scope?.productGoal?.trim() || data.state.projectSlug;

  return (
    <div className="rf-overview-view">
      <section className="rf-card rf-summary">
        <header className="rf-card-header">
          <h2 className="rf-card-title">{t('summary.heading', r)}</h2>
        </header>
        <p className="rf-summary-goal">{summary}</p>
        <div className="rf-summary-stats">
          <div className="rf-stat"><span className="rf-stat-num">{overview.totalPages}</span><span className="rf-stat-label">screens</span></div>
          <div className="rf-stat"><span className="rf-stat-num">{overview.findings}</span><span className="rf-stat-label">findings</span></div>
          {overview.critical > 0 && <div className="rf-stat rf-stat-danger"><span className="rf-stat-num">{overview.critical}</span><span className="rf-stat-label">CRITICAL</span></div>}
          {overview.high > 0 && <div className="rf-stat rf-stat-warn"><span className="rf-stat-num">{overview.high}</span><span className="rf-stat-label">HIGH</span></div>}
        </div>
      </section>

      <section className="rf-card">
        <header className="rf-card-header">
          <h2 className="rf-card-title">Screens</h2>
        </header>
        <ul className="rf-screen-list">
          {data.pages.map((p) => {
            const gaps = p.audit?.gaps ?? [];
            const n = gaps.length;
            const crit = gaps.filter((g) => g.severity === 'critical').length;
            const a = data.approvals.pages[p.slug];
            const approvedCount = gaps.filter((g) => (a?.gaps?.[g.id] ?? 'apply') === 'apply').length;
            const skippedCount = n - approvedCount;
            const commentCount = a?.comments?.length ?? 0;
            return (
              <li key={p.slug}>
                <button className="rf-screen-card" onClick={() => onPick(p.slug)} type="button">
                  <span className="rf-screen-name">{p.slug}</span>
                  <span className="rf-mono rf-screen-route">{p.route}</span>
                  <span className="rf-badge-row">
                    {crit > 0 && <span className="rf-chip rf-chip-critical">{crit} critical</span>}
                    {n > 0 ? <span className="rf-chip rf-chip-info">{n} {n === 1 ? 'finding' : 'findings'}</span>
                            : <span className="rf-chip rf-chip-ok">Clean</span>}
                  </span>
                  {n > 0 && (
                    <span className="rf-screen-progress" aria-label={`${approvedCount} approved, ${skippedCount} skipped, ${commentCount} comments`}>
                      <span className="rf-screen-stat">
                        <span className="rf-screen-stat-num">{approvedCount}</span>
                        <span className="rf-screen-stat-label">will fix</span>
                      </span>
                      {skippedCount > 0 && (
                        <span className="rf-screen-stat">
                          <span className="rf-screen-stat-num">{skippedCount}</span>
                          <span className="rf-screen-stat-label">skipped</span>
                        </span>
                      )}
                      {commentCount > 0 && (
                        <span className="rf-screen-stat">
                          <span className="rf-screen-stat-num">{commentCount}</span>
                          <span className="rf-screen-stat-label">comment{commentCount === 1 ? '' : 's'}</span>
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <AllCommentsSection data={data} onPick={onPick} />
    </div>
  );
}

function AllCommentsSection({ data, onPick }: { data: RunData; onPick: (slug: string) => void }) {
  const items: Array<{ slug: string; route: string; comments: string[] }> = [];
  for (const p of data.pages) {
    const c = data.approvals.pages[p.slug]?.comments ?? [];
    if (c.length > 0) items.push({ slug: p.slug, route: p.route, comments: c });
  }
  if (items.length === 0) return null;
  const total = items.reduce((acc, x) => acc + x.comments.length, 0);
  return (
    <section className="rf-card">
      <header className="rf-card-header">
        <h2 className="rf-card-title">All comments · {total}</h2>
      </header>
      <ul className="rf-comments-feed">
        {items.flatMap((it) =>
          it.comments.map((c, i) => (
            <li key={`${it.slug}-${i}`}>
              <button className="rf-comment-row" onClick={() => onPick(it.slug)} type="button">
                <span className="rf-comment-source">
                  <span className="rf-screen-name">{it.slug}</span>
                  <span className="rf-mono rf-screen-route">{it.route}</span>
                </span>
                <span className="rf-comment-text">{c}</span>
              </button>
            </li>
          )),
        )}
      </ul>
    </section>
  );
}

export default function App() {
  return (
    <UiProvider>
      <AppInner />
    </UiProvider>
  );
}
