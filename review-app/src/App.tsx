import React, { useState, useEffect, useMemo } from 'react';

/**
 * Dual-register fields emitted by every engine v0.2+ finding:
 * `plain`         — same issue, written for a non-technical reader
 * `whyItMatters`  — concrete user-facing consequence if shipped
 * `confidence`    — 0..1, agent confidence the issue is real
 * `dimension`     — finer-grained classification for filter chips
 */
interface Gap {
  id: string;
  category: 'functional' | 'ux';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  recommendation: string;
  plain?: string;
  whyItMatters?: string;
  confidence?: number;
  dimension?: string;
}

interface Finding {
  ruleId: string;
  domain: string;
  severity: string;
  location: string;
  problem: string;
  requiredFix: string;
  plain?: string;
  whyItMatters?: string;
  confidence?: number;
  dimension?: string;
}

interface PageData {
  slug: string;
  route: string;
  hasScreenshot: boolean;
  hasHtml?: boolean;
  audit?: {
    gaps: Gap[];
    health?: {
      healthy: boolean;
      status: string;
      detail: string;
    };
    /**
     * Per-breakpoint screenshot file map written by Agent 1 alongside
     * `audit.png`. Keys match the names in DEFAULT_BREAKPOINTS on the
     * engine side: typically `mobile`, `tablet`, `desktop`.
     */
    breakpointScreenshots?: Record<string, string>;
  };
  ux?: {
    asciiWireframe: string;
    functionalSpec: string;
  };
  design?: {
    spec: string;
    brandTokensUsed: string[];
  };
  compliance?: {
    findings: Finding[];
    clean: boolean;
  };
  code?: {
    filesChanged: string[];
    notes: string;
  };
  codeDiff?: string;
}

interface PageApproval {
  decision: 'apply' | 'skip';
  gaps?: Record<string, 'apply' | 'skip'>;
  /**
   * Per-compliance-finding decisions, keyed `${ruleId}::${location}`.
   * Mirrors the engine's PageApproval shape (see src/types.ts).
   */
  complianceFindings?: Record<string, 'apply' | 'skip'>;
  note?: string;
  comments?: string[];
}

interface RunData {
  runDir: string;
  isGitRepo?: boolean;
  state: {
    projectSlug: string;
    startedAt: string;
  };
  approvals: {
    pages: Record<string, PageApproval>;
  };
  pages: PageData[];
}

export default function App() {
  const [data, setData] = useState<RunData | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Track Step 2 approval confirmation
  const [isLedgerLocked, setIsLedgerLocked] = useState<boolean>(false);

  // Toggle slide-out blueprint drawer
  const [isArchDrawerOpen, setIsArchDrawerOpen] = useState<boolean>(false);

  // New comment input per page
  const [newComment, setNewComment] = useState<string>('');

  const [activeRightTab, setActiveRightTab] = useState<'decisions' | 'guide' | 'downloads' | 'architecture'>('decisions');

  // Checkpoint toggles
  const [gateOverrides, setGateOverrides] = useState({
    cataloging: true,
    visualReview: true,
    refactoringPrompt: false,
    playwrightVerify: true,
  });

  // Local state changes before saving to disk
  const [currentApproval, setCurrentApproval] = useState<PageApproval | null>(null);

  // Zoom mode for visual preview: 'fit' or 'native'
  const [zoomMode, setZoomMode] = useState<'fit' | 'native'>('fit');

  // View layout format: 'split' (side-by-side) or 'full' (stacked full-width visual)
  const [viewLayout, setViewLayout] = useState<'split' | 'full'>('full');

  // Preview mode: 'iframe' or 'screenshot'
  const [previewMode, setPreviewMode] = useState<'iframe' | 'screenshot'>('screenshot');

  // Language register for finding text — 'plain' is the default so vibe-coders
  // and non-technical reviewers get readable findings up front; engineers can
  // flip to 'technical' for file:line precision. Either way, BOTH versions are
  // available in the finding card (the other becomes a collapsible).
  const [languageRegister, setLanguageRegister] = useState<'plain' | 'technical'>('plain');

  // Filter chips — applied to the gap/finding list. Empty set = no filter.
  const [severityFilter, setSeverityFilter] = useState<Set<string>>(new Set());
  const [dimensionFilter, setDimensionFilter] = useState<Set<string>>(new Set());
  // Confidence threshold: only show findings with confidence >= this (0..1).
  // 0 = show everything (including findings without a confidence score).
  const [minConfidence, setMinConfidence] = useState<number>(0);

  // Active breakpoint for the preview surface. 'default' uses the engine's
  // canonical audit.png; named keys map to audit-<name>.png served by the
  // /api/screenshot endpoint's ?breakpoint= query param.
  const [activeBreakpoint, setActiveBreakpoint] = useState<string>('default');

  // Connection indicator watchdog state
  const [isOfflineMock, setIsOfflineMock] = useState(false);

  // Load run details on boot
  useEffect(() => {
    fetchRunData();
  }, []);

  const fetchRunData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Relative endpoint, works both in dev mock and served from Node server
      const response = await fetch('/api/run');
      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }
      const json = await response.json() as RunData;
      setData(json);
      setIsOfflineMock(false);
      
      // Auto-select first page if none selected
      if (json.pages && json.pages.length > 0 && !activeSlug) {
        setActiveSlug(json.pages[0].slug);
      }
    } catch (err) {
      console.warn('API fetch failed, falling back to rich mock data:', err);
      setIsOfflineMock(true);
      // High fidelity mock data fallback to prevent the application from breaking when API server is inactive
      const mockData: RunData = {
        runDir: "C:\\projects\\should-i-fight-all-tasks\\casesdaily",
        state: {
          projectSlug: "casesdaily",
          startedAt: new Date().toISOString(),
        },
        approvals: {
          pages: {
            "admin-dashboard": {
              decision: "apply",
              gaps: { "g1": "apply", "g2": "skip", "g3": "apply" },
              note: "Refining admin metrics per PM instructions. Approved slug layout.",
              comments: ["Collaborator: Metrics load perfectly now. Verified CTA contrast."]
            }
          }
        },
        pages: [
          {
            slug: "admin-dashboard",
            route: "/admin/dashboard",
            hasScreenshot: true,
            hasHtml: true,
            audit: {
              health: {
                healthy: true,
                status: "ok",
                detail: "Page loaded successfully with live state."
              },
              gaps: [
                {
                  id: "g1",
                  category: "functional",
                  severity: "critical",
                  description: "Broken lead exporting: clicking the 'Export CSV' button throws a silent console TypeMismatch error.",
                  recommendation: "Update the payload parsing in export-csv.ts to map database integer types to strings."
                },
                {
                  id: "g2",
                  category: "ux",
                  severity: "medium",
                  description: "Interface contrast: CTA 'Add Lead' button uses slate-400 text on slate-500 background, failing WCAG 2.2 color contrast guidelines.",
                  recommendation: "Elevate styling to slate-50 text on slate-900 background for a clean premium appearance."
                },
                {
                  id: "g3",
                  category: "ux",
                  severity: "high",
                  description: "Missing form labels: lead search bar input element lacks a linked HTML <label> or aria-label attribute.",
                  recommendation: "Add aria-label='Search active attorney leads' to the search input element."
                }
              ]
            },
            ux: {
              asciiWireframe: "  +--------------------------------------------+\n  | [🛡️ ADMIN] Leads | Search: [_________] [🔍] |\n  +--------------------------------------------+\n  | ACTIVE LEADS (142)                         |\n  | - John Doe    | personal injury | [EXPORT] |\n  | - Jane Smith  | auto accident   | [EXPORT] |\n  +--------------------------------------------+",
              functionalSpec: "Admin control dashboard for lead tracking."
            },
            design: {
              spec: "Standard clean modern slate visual specs.",
              brandTokensUsed: ["colors.primary", "colors.background", "radii.md"]
            },
            codeDiff: "@@ -12,4 +12,6 @@\n- <button onClick={exportCsv} className=\"btn-slate\">Export CSV</button>\n+ <button onClick={exportCsv} className=\"btn-slate-export\" aria-label=\"Export lead database to CSV\">\n+   💾 Export Lead CSV\n+ </button>"
          }
        ]
      };
      setData(mockData);
      setActiveSlug("admin-dashboard");
    } finally {
      setLoading(false);
    }
  };

  // Sync current selection when active page changes
  useEffect(() => {
    if (!data || !activeSlug) return;

    const page = data.pages.find(p => p.slug === activeSlug);
    if (page) {
      setPreviewMode(page.hasScreenshot ? 'screenshot' : 'iframe');
      // Reset the breakpoint to the default capture when switching pages —
      // a fresh page starts with its primary screenshot showing.
      setActiveBreakpoint('default');
    }

    const existing = data.approvals.pages[activeSlug];
    if (existing) {
      setCurrentApproval({
        decision: existing.decision ?? 'apply',
        gaps: existing.gaps ?? {},
        note: existing.note ?? '',
        comments: existing.comments ?? [],
      });
    } else {
      // Default fallback approval payload
      const gapsDefault: Record<string, 'apply' | 'skip'> = {};
      if (page?.audit?.gaps) {
        page.audit.gaps.forEach(g => {
          gapsDefault[g.id] = 'apply';
        });
      }

      setCurrentApproval({
        decision: 'apply',
        gaps: gapsDefault,
        note: '',
        comments: [],
      });
    }
  }, [activeSlug, data]);

  // Handle decisions toggle (Apply vs Skip)
  const handleDecisionToggle = (decision: 'apply' | 'skip') => {
    if (!currentApproval) return;
    setIsLedgerLocked(false);
    setCurrentApproval({
      ...currentApproval,
      decision,
    });
  };

  // Toggle individual gap decision (Apply vs Skip)
  const handleGapToggle = (gapId: string) => {
    if (!currentApproval) return;
    setIsLedgerLocked(false);
    const currentGaps = { ...currentApproval.gaps };
    currentGaps[gapId] = currentGaps[gapId] === 'skip' ? 'apply' : 'skip';
    
    setCurrentApproval({
      ...currentApproval,
      gaps: currentGaps,
    });
  };

  // Toggle all gaps
  const handleToggleAllGaps = () => {
    if (!currentApproval || !activePage?.audit?.gaps) return;
    setIsLedgerLocked(false);
    const allCurrentlyApply = activePage.audit.gaps.every(g => currentApproval.gaps?.[g.id] !== 'skip');
    const targetStatus: 'apply' | 'skip' = allCurrentlyApply ? 'skip' : 'apply';
    
    const updatedGaps = { ...currentApproval.gaps };
    activePage.audit.gaps.forEach(g => {
      updatedGaps[g.id] = targetStatus;
    });
    
    setCurrentApproval({
      ...currentApproval,
      gaps: updatedGaps,
    });
  };

  // Append new threaded comment
  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentApproval || !newComment.trim()) return;
    setIsLedgerLocked(false);
    
    const commentsList = [...(currentApproval.comments ?? [])];
    commentsList.push(newComment.trim());

    setCurrentApproval({
      ...currentApproval,
      comments: commentsList,
    });
    setNewComment('');
  };

  // Save changes for this page back to disk
  const handleSaveApproval = async () => {
    if (!activeSlug || !currentApproval) return;
    setSaving(true);
    try {
      const response = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: activeSlug,
          approval: currentApproval,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update approvals on disk.');
      }

      const resJson = await response.json();
      if (resJson.success) {
        // Sync local data doc
        setData(prev => {
          if (!prev) return prev;
          const updatedPages = { ...prev.approvals.pages };
          updatedPages[activeSlug] = currentApproval;
          return {
            ...prev,
            approvals: {
              ...prev.approvals,
              pages: updatedPages,
            },
          };
        });
        setIsLedgerLocked(true);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const [applying, setApplying] = useState<boolean>(false);

  const handleApplyRefactor = async () => {
    if (!activeSlug || !currentApproval) return;
    setApplying(true);
    try {
      // First, save the approvals to make sure we use the latest decisions
      const saveResponse = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: activeSlug,
          approval: currentApproval,
        }),
      });

      if (!saveResponse.ok) {
        throw new Error('Failed to save selections before applying.');
      }

      // Sync local state doc
      setData(prev => {
        if (!prev) return prev;
        const updatedPages = { ...prev.approvals.pages };
        updatedPages[activeSlug] = currentApproval;
        return {
          ...prev,
          approvals: {
            ...prev.approvals,
            pages: updatedPages,
          },
        };
      });

      // Then trigger apply
      const applyResponse = await fetch('/api/apply', {
        method: 'POST',
      });

      if (!applyResponse.ok) {
        throw new Error('Failed to trigger background rebuild.');
      }

      const resJson = await applyResponse.json();
      if (resJson.success) {
        alert(`⚡ Git Refactoring Triggered in Background!\n\nThe pipeline is now running in the background to apply your approved upgrades. You can monitor the progress log file at:\n${resJson.logFile}`);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  };

  const generateAiPrompt = () => {
    if (!activePage || !currentApproval) return '';
    
    const approvedGaps = activePage.audit?.gaps.filter(g => currentApproval.gaps?.[g.id] !== 'skip') || [];
    
    let gapsSection = '';
    if (approvedGaps.length > 0) {
      gapsSection = approvedGaps.map(g => {
        return `- **[${g.severity.toUpperCase()}] ${g.category.toUpperCase()}**: ${g.description}\n  *Fix Strategy*: ${g.recommendation}`;
      }).join('\n');
    } else {
      gapsSection = '- Review visual specifications and optimize layout for premium responsive aesthetics.';
    }

    const designSpec = activePage.design?.spec ? `\n### Brand Visual Tokens & Rules:\n${activePage.design.spec}` : '';
    const pmNotes = currentApproval.note ? `\n### PM Adjustments & Instructions:\n${currentApproval.note}` : '';

    return `# Reframe AI Refactoring Instruction Set

You are an expert AI software architect. Please apply the following approved visual and functional refactoring upgrades directly to the target source file.

## Workspace Context
- **Screen**: ${activePage.slug}
- **Route**: ${activePage.route || '/' + activePage.slug.replace(/-/g, '/')}

## Target Upgrades to Apply:
${gapsSection}
${designSpec}
${pmNotes}

## Execution Checklist:
1. Refactor the code changes inside the target page file to resolve all approved gaps.
2. Maintain brand token guidelines and correct any visual contrast or alignment errors.
3. Keep all existing unrelated comments, hooks, and logic intact.
4. Verify changes compile and serve cleanly.`;
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '1rem' }}>
        <div style={{ width: '40px', height: '40px', border: '3px solid #cbd5e1', borderTopColor: '#2563eb', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
        <p style={{ color: '#64748b', fontWeight: 600 }}>Loading visual review app...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', padding: '2rem', textAlign: 'center' }}>
        <p style={{ fontSize: '3rem' }}>⚠️</p>
        <h2 style={{ margin: '1rem 0 0.5rem', color: '#1e293b' }}>Could not load run data</h2>
        <p style={{ color: '#64748b', maxWidth: '500px', marginBottom: '1.5rem' }}>{error}</p>
        <button onClick={fetchRunData} className="btn-primary">Retry Connection</button>
      </div>
    );
  }

  const activePage = data?.pages.find(p => p.slug === activeSlug);

  /**
   * Apply the toolbar filter chips (severity / dimension / confidence
   * threshold) to the active page's gap list. Memoized so changing an
   * unrelated state field doesn't re-filter on every render.
   */
  const filteredGaps = useMemo<Gap[]>(() => {
    const all = activePage?.audit?.gaps ?? [];
    return all.filter(gap => {
      if (severityFilter.size > 0 && !severityFilter.has(gap.severity)) return false;
      if (dimensionFilter.size > 0 && (!gap.dimension || !dimensionFilter.has(gap.dimension))) return false;
      if (minConfidence > 0 && (gap.confidence ?? 1) < minConfidence) return false;
      return true;
    });
  }, [activePage, severityFilter, dimensionFilter, minConfidence]);

  /**
   * Set of dimensions present on the current page — used to render only
   * the chips that would actually do something. Hiding empty chips keeps
   * the toolbar clean per-page.
   */
  const availableDimensions = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const g of activePage?.audit?.gaps ?? []) {
      if (g.dimension) set.add(g.dimension);
    }
    for (const f of activePage?.compliance?.findings ?? []) {
      if (f.dimension) set.add(f.dimension);
    }
    return Array.from(set).sort();
  }, [activePage]);

  /**
   * Top findings across audit + compliance for the active page, ranked
   * by impact = severity_weight × confidence. Powers the Founder Digest
   * at the top of the detail pane — the "fix these first" view that
   * the vibe-coding founder sees before the full list.
   */
  const founderDigest = useMemo(() => {
    if (!activePage) return [] as Array<{
      key: string;
      severity: string;
      headline: string;
      whyItMatters?: string;
      source: 'audit' | 'compliance';
    }>;
    const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const items: Array<{
      key: string;
      severity: string;
      headline: string;
      whyItMatters?: string;
      impact: number;
      source: 'audit' | 'compliance';
    }> = [];
    for (const g of activePage.audit?.gaps ?? []) {
      const sev = SEVERITY_WEIGHT[g.severity] ?? 1;
      const conf = g.confidence ?? 0.8;
      items.push({
        key: `audit-${g.id}`,
        severity: g.severity,
        headline: g.plain || g.description,
        whyItMatters: g.whyItMatters,
        impact: sev * conf,
        source: 'audit',
      });
    }
    for (const f of activePage.compliance?.findings ?? []) {
      const sev = SEVERITY_WEIGHT[f.severity] ?? 1;
      const conf = f.confidence ?? 0.8;
      items.push({
        key: `compliance-${f.ruleId}-${f.location}`,
        severity: f.severity,
        headline: f.plain || f.problem,
        whyItMatters: f.whyItMatters,
        impact: sev * conf,
        source: 'compliance',
      });
    }
    return items
      .sort((a, b) => b.impact - a.impact)
      .slice(0, 5)
      .map(({ impact: _impact, ...rest }) => rest);
  }, [activePage]);

  /** Toggle helper used by severity and dimension chips. */
  const toggleInSet = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  /**
   * Resolve the screenshot URL for the currently active page +
   * breakpoint selection. The 'default' key uses the engine's primary
   * audit.png; named keys (mobile / tablet / desktop) request the
   * corresponding audit-<name>.png via the server's breakpoint query.
   */
  const screenshotUrl = activePage
    ? activeBreakpoint === 'default'
      ? `/api/screenshot/${activePage.slug}`
      : `/api/screenshot/${activePage.slug}?breakpoint=${encodeURIComponent(activeBreakpoint)}`
    : '';

  /**
   * Sentinel slug for the run-level Overview pseudo-page in the sidebar.
   * When activeSlug equals this, the detail pane renders the cross-page
   * "criticals first" view instead of any one page's details.
   */
  const OVERVIEW_SLUG = '__overview__';

  /**
   * Tracks which Overview rows are "in flight" to /api/approvals so the
   * UI can disable the button + show a subtle spinner during the write.
   * Keyed by the same `item.key` the Overview list uses for React keys.
   */
  const [overviewWriting, setOverviewWriting] = useState<Set<string>>(new Set());

  /**
   * Set a finding's apply/skip decision from the Run Overview WITHOUT
   * navigating to its page. Works for both audit gaps and compliance
   * findings — the `target` parameter is a discriminated union that
   * points the decision at the right slot inside PageApproval.
   *
   * Reads the existing approval for that page (or builds a default one),
   * patches just this finding's decision, then POSTs the whole
   * page-approval. The local data state is updated optimistically; a
   * failed POST rolls back so the UI never disagrees with disk.
   */
  const setOverviewFindingDecision = async (
    pageSlug: string,
    target:
      | { kind: 'audit'; gapId: string }
      | { kind: 'compliance'; complianceFindingKey: string },
    decision: 'apply' | 'skip',
    itemKey: string,
  ): Promise<void> => {
    if (!data) return;
    setOverviewWriting((prev) => new Set(prev).add(itemKey));

    const existing = data.approvals.pages[pageSlug];
    const updatedApproval: PageApproval = {
      decision: existing?.decision ?? 'apply',
      gaps:
        target.kind === 'audit'
          ? { ...(existing?.gaps ?? {}), [target.gapId]: decision }
          : existing?.gaps,
      complianceFindings:
        target.kind === 'compliance'
          ? {
              ...(existing?.complianceFindings ?? {}),
              [target.complianceFindingKey]: decision,
            }
          : existing?.complianceFindings,
      note: existing?.note ?? '',
      comments: existing?.comments ?? [],
    };

    // Optimistic local update — instant feedback in the Overview row.
    const priorPages = data.approvals.pages;
    setData((prev) =>
      prev
        ? {
            ...prev,
            approvals: {
              ...prev.approvals,
              pages: { ...prev.approvals.pages, [pageSlug]: updatedApproval },
            },
          }
        : prev,
    );

    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: pageSlug, approval: updatedApproval }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // Sync currentApproval if the user happens to be on this page —
      // keeps the per-page card consistent with the Overview decision.
      if (activeSlug === pageSlug) {
        setCurrentApproval(updatedApproval);
      }
    } catch (err) {
      // Roll back the optimistic local change so the UI never lies.
      setData((prev) =>
        prev ? { ...prev, approvals: { ...prev.approvals, pages: priorPages } } : prev,
      );
      const label =
        target.kind === 'audit'
          ? `${pageSlug}::${target.gapId}`
          : `${pageSlug}::${target.complianceFindingKey}`;
      alert(
        `Could not save decision for ${label}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setOverviewWriting((prev) => {
        const next = new Set(prev);
        next.delete(itemKey);
        return next;
      });
    }
  };

  /**
   * Cross-page run overview: aggregates every finding across every page,
   * ranks by severity × confidence, and bucket-counts by severity. Powers
   * the run-level dashboard the Reviewer queue persona (Priya) asked for —
   * "show me everything critical across all 34 pages, ranked".
   */
  const runOverview = useMemo(() => {
    const SEVERITY_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    type OverviewItem = {
      key: string;
      pageSlug: string;
      pageRoute: string;
      severity: string;
      dimension?: string;
      headline: string;
      whyItMatters?: string;
      confidence?: number;
      impact: number;
      source: 'audit' | 'compliance';
      /**
       * Audit gap id (g1, g2, …). Present only for audit items — used
       * by the per-row Skip/Approve buttons to address the right gap
       * inside the page's approvals.gaps map.
       */
      gapId?: string;
      /**
       * Stable key for compliance findings, `${ruleId}::${location}`.
       * Present only for compliance items — used to address the
       * finding inside approvals.complianceFindings.
       */
      complianceFindingKey?: string;
    };
    const all: OverviewItem[] = [];
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    let pagesWithFindings = 0;
    for (const p of data?.pages ?? []) {
      const gaps = p.audit?.gaps ?? [];
      const findings = p.compliance?.findings ?? [];
      if (gaps.length > 0 || findings.length > 0) pagesWithFindings++;
      for (const g of gaps) {
        counts[g.severity as keyof typeof counts] =
          (counts[g.severity as keyof typeof counts] ?? 0) + 1;
        const sev = SEVERITY_WEIGHT[g.severity] ?? 1;
        const conf = g.confidence ?? 0.8;
        all.push({
          key: `${p.slug}::audit::${g.id}`,
          pageSlug: p.slug,
          pageRoute: p.route,
          severity: g.severity,
          dimension: g.dimension,
          headline: g.plain || g.description,
          whyItMatters: g.whyItMatters,
          confidence: g.confidence,
          impact: sev * conf,
          source: 'audit',
          gapId: g.id,
        });
      }
      for (const f of findings) {
        const sevKey = f.severity as keyof typeof counts;
        if (counts[sevKey] !== undefined) counts[sevKey]++;
        const sev = SEVERITY_WEIGHT[f.severity] ?? 1;
        const conf = f.confidence ?? 0.8;
        const complianceKey = `${f.ruleId}::${f.location}`;
        all.push({
          key: `${p.slug}::compliance::${complianceKey}`,
          pageSlug: p.slug,
          pageRoute: p.route,
          severity: f.severity,
          dimension: f.dimension,
          headline: f.plain || f.problem,
          whyItMatters: f.whyItMatters,
          confidence: f.confidence,
          impact: sev * conf,
          source: 'compliance',
          complianceFindingKey: complianceKey,
        });
      }
    }
    all.sort((a, b) => b.impact - a.impact);
    return { items: all, counts, pagesWithFindings, totalPages: data?.pages.length ?? 0 };
  }, [data]);

  return (
    <div className="app-container">
      {/* ────────────────────────── HEADER ────────────────────────── */}
      <header className="header">
        <div className="logo-group">
          <div className="logo-badge">R</div>
          <span className="logo-text">Reframe</span>
          <span className="logo-sub">Visual Refactoring Workspace</span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <div className="connection-indicator">
            <span className={`connection-dot ${isOfflineMock ? 'offline' : 'online'}`}></span>
            {isOfflineMock ? 'OFFLINE MOCK MODE' : 'LOCAL SERVER ONLINE'}
          </div>

          {data && (
            <div style={{ display: 'flex', gap: '2rem', fontSize: '0.85rem', color: '#64748b' }}>
              <div>
                <strong>Project:</strong> <span style={{ color: '#0f172a', fontWeight: 600 }}>{data.state.projectSlug}</span>
              </div>
              <div>
                <strong>Run Directory:</strong> <span style={{ color: '#0f172a', fontFamily: 'monospace' }}>{data.runDir}</span>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* ────────────────────────── MAIN WORKSPACE ────────────────────────── */}
      <main className="main-content">
        
        {/* ────────────────────────── SIDEBAR ────────────────────────── */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2 className="sidebar-title">Screens fan-out</h2>
          </div>

          {/* Run Overview — the cross-page "criticals first" view. Sits
              above the per-screen list so reviewers land on the
              triage dashboard before they go page-by-page. */}
          {data && data.pages.length > 0 && (
            <ul className="page-list" style={{ marginBottom: '0.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
              <li
                key={OVERVIEW_SLUG}
                className={`page-item smooth-all ${activeSlug === OVERVIEW_SLUG ? 'active' : ''}`}
                onClick={() => setActiveSlug(OVERVIEW_SLUG)}
                style={{
                  background: activeSlug === OVERVIEW_SLUG
                    ? 'linear-gradient(135deg, #faf5ff 0%, #fdf4ff 100%)'
                    : undefined,
                }}
              >
                <span className="page-item-title" style={{ color: '#5b21b6' }}>
                  ✨ Run Overview
                </span>
                <span className="page-item-subtitle" style={{ color: '#7c3aed' }}>
                  {runOverview.items.length} finding{runOverview.items.length === 1 ? '' : 's'}
                  {' '}across {runOverview.pagesWithFindings} of {runOverview.totalPages} screens
                </span>
                <div className="badge-row" style={{ marginTop: '0.35rem' }}>
                  {runOverview.counts.critical > 0 && (
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.45rem', borderRadius: '999px', background: '#fee2e2', color: '#991b1b' }}>
                      {runOverview.counts.critical} critical
                    </span>
                  )}
                  {runOverview.counts.high > 0 && (
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.45rem', borderRadius: '999px', background: '#fed7aa', color: '#9a3412' }}>
                      {runOverview.counts.high} high
                    </span>
                  )}
                </div>
              </li>
            </ul>
          )}

          <ul className="page-list">
            {data?.pages.map((p) => {
              const approval = data.approvals.pages[p.slug];
              const healthStatus = p.audit?.health?.status ?? 'pending';

              return (
                <li
                  key={p.slug}
                  className={`page-item smooth-all ${p.slug === activeSlug ? 'active' : ''}`}
                  onClick={() => setActiveSlug(p.slug)}
                >
                  <span className="page-item-title">{p.slug}</span>
                  <span className="page-item-subtitle">{p.route || '/' + p.slug.replace(/-/g, '/')}</span>

                  <div className="badge-row">
                    {/* Status badge */}
                    {healthStatus === 'ok' ? (
                      <span className="badge badge-pass">Pass</span>
                    ) : healthStatus !== 'pending' ? (
                      <span className="badge badge-fail">{healthStatus}</span>
                    ) : (
                      <span className="badge badge-pending">Pending</span>
                    )}

                    {/* Review Status badge */}
                    {approval ? (
                      approval.decision === 'apply' ? (
                        <span className="badge badge-apply">✓ Approved</span>
                      ) : (
                        <span className="badge badge-skip">⚪ Bypassed</span>
                      )
                    ) : (
                      <span className="badge badge-pending">⏳ Unreviewed</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>

        {/* ────────────────────────── DETAIL PANE ────────────────────────── */}
        <section className="detail-pane">
          {isOfflineMock && (
            <div className="offline-mock-banner">
              <span className="offline-mock-icon">⚠️</span>
              <div className="offline-mock-content">
                <h4 className="offline-mock-title">Dashboard Running in Offline Mock Mode</h4>
                <p className="offline-mock-text">
                  The frontend could not connect to the local Reframe API at <code className="offline-mock-code">http://localhost:3000</code>.
                  To view live run data, review active screenshots, and apply updates, make sure the Node server is running in your terminal:
                </p>
                <div style={{ marginTop: '0.5rem', background: '#ffffff', border: '1px solid #fca5a5', padding: '0.5rem', borderRadius: '6px', fontFamily: 'monospace', fontSize: '0.8rem', color: '#b91c1c', display: 'inline-block' }}>
                  npx reframe review {data?.runDir || './runs/current'} --port 3000
                </div>
              </div>
            </div>
          )}

          {activeSlug === OVERVIEW_SLUG ? (
            /* ────────────────────────── RUN OVERVIEW ──────────────────────────
               Cross-page "criticals first" view. Aggregates findings across
               every audited page; clicking a finding jumps to that page. */
            <div style={{ padding: '1.25rem' }}>
              <div style={{ marginBottom: '1.25rem' }}>
                <h1 className="active-page-title" style={{ background: 'linear-gradient(90deg, #5b21b6, #ec4899)', WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Run Overview
                </h1>
                <p style={{ color: '#64748b', fontSize: '0.95rem', marginTop: '0.25rem' }}>
                  Every finding across {runOverview.totalPages} screen{runOverview.totalPages === 1 ? '' : 's'}, ranked by user impact (severity × confidence). Triage from highest-impact down.
                </p>
              </div>

              {/* Severity bucket bar */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '0.75rem',
                marginBottom: '1.5rem',
              }}>
                {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
                  const tone = sev === 'critical' ? { bg: '#fee2e2', fg: '#991b1b' }
                            : sev === 'high'     ? { bg: '#fed7aa', fg: '#9a3412' }
                            : sev === 'medium'   ? { bg: '#fef3c7', fg: '#854d0e' }
                            :                       { bg: '#e0e7ff', fg: '#3730a3' };
                  return (
                    <div key={sev} style={{
                      padding: '0.85rem 1rem', borderRadius: '10px',
                      background: tone.bg, border: `1px solid ${tone.fg}22`,
                    }}>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: tone.fg }}>{sev}</div>
                      <div style={{ fontSize: '1.75rem', fontWeight: 800, color: tone.fg, lineHeight: 1.1, marginTop: '0.15rem' }}>
                        {runOverview.counts[sev]}
                      </div>
                    </div>
                  );
                })}
              </div>

              {runOverview.items.length === 0 ? (
                <div style={{ padding: '2.5rem', textAlign: 'center', background: '#f0fdf4', border: '1px dashed #86efac', borderRadius: '12px' }}>
                  <span style={{ fontSize: '2.5rem' }}>🎉</span>
                  <p style={{ marginTop: '0.5rem', fontSize: '1.05rem', fontWeight: 600, color: '#166534' }}>
                    Nothing critical to triage.
                  </p>
                  <p style={{ fontSize: '0.85rem', color: '#15803d', margin: '0.25rem 0 0' }}>
                    Every screen passed without findings.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.1em', color: '#64748b', fontWeight: 700 }}>
                    Ranked findings — top {Math.min(runOverview.items.length, 50)} of {runOverview.items.length}
                  </div>
                  {runOverview.items.slice(0, 50).map(item => {
                    const tone = item.severity === 'critical' ? { bg: '#fee2e2', fg: '#991b1b' }
                              : item.severity === 'high'     ? { bg: '#fed7aa', fg: '#9a3412' }
                              : item.severity === 'medium'   ? { bg: '#fef3c7', fg: '#854d0e' }
                              :                                 { bg: '#e0e7ff', fg: '#3730a3' };
                    const confPct = typeof item.confidence === 'number' ? Math.round(item.confidence * 100) : null;
                    // Per-row apply/skip state — works for both audit gaps
                    // (via approvals.gaps[gapId]) and compliance findings
                    // (via approvals.complianceFindings[complianceFindingKey]).
                    // A bypassed page overrides any per-finding decisions.
                    const pageApproval = data?.approvals.pages[item.pageSlug];
                    const pageBypassed = pageApproval?.decision === 'skip';
                    let perItemSkipped = false;
                    if (item.source === 'audit' && item.gapId) {
                      perItemSkipped = pageApproval?.gaps?.[item.gapId] === 'skip';
                    } else if (item.source === 'compliance' && item.complianceFindingKey) {
                      perItemSkipped =
                        pageApproval?.complianceFindings?.[item.complianceFindingKey] === 'skip';
                    }
                    const isSkipped = pageBypassed || perItemSkipped;
                    const canTriage =
                      !pageBypassed &&
                      ((item.source === 'audit' && !!item.gapId) ||
                        (item.source === 'compliance' && !!item.complianceFindingKey));
                    const writing = overviewWriting.has(item.key);
                    return (
                      <div
                        key={item.key}
                        onClick={() => setActiveSlug(item.pageSlug)}
                        style={{
                          padding: '0.85rem 1rem',
                          background: isSkipped ? '#fafafa' : '#fff',
                          border: '1px solid ' + (isSkipped ? '#e2e8f0' : '#e2e8f0'),
                          borderRadius: '10px',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                          display: 'flex',
                          gap: '0.85rem',
                          opacity: isSkipped ? 0.55 : 1,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = '#8B5CF6';
                          e.currentTarget.style.boxShadow = '0 2px 8px rgba(139,92,246,0.12)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = '#e2e8f0';
                          e.currentTarget.style.boxShadow = 'none';
                        }}
                      >
                        <div style={{
                          padding: '0.2rem 0.5rem', borderRadius: '4px',
                          background: tone.bg, color: tone.fg,
                          fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: '0.05em', height: 'fit-content', whiteSpace: 'nowrap',
                        }}>
                          {item.severity}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: '0.85rem', color: '#1e293b', lineHeight: 1.4,
                            textDecoration: isSkipped ? 'line-through' : 'none',
                          }}>
                            {item.headline}
                          </div>
                          <div style={{ marginTop: '0.35rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '0.7rem', color: '#64748b' }}>
                            <span style={{ fontFamily: 'monospace', color: '#475569', fontWeight: 600 }}>
                              {item.pageSlug}
                            </span>
                            {item.dimension && (
                              <span style={{ padding: '0.1rem 0.4rem', borderRadius: '999px', background: '#f3e8ff', color: '#7c3aed', fontSize: '0.65rem', fontWeight: 600 }}>
                                {item.dimension}
                              </span>
                            )}
                            {item.source === 'compliance' && (
                              <span style={{ padding: '0.1rem 0.4rem', borderRadius: '999px', background: '#fef3c7', color: '#854d0e', fontSize: '0.65rem', fontWeight: 600 }}>
                                compliance
                              </span>
                            )}
                            {confPct !== null && (
                              <span style={{ fontFamily: 'monospace', fontSize: '0.65rem' }}>
                                {confPct}%
                              </span>
                            )}
                            {isSkipped && (
                              <span style={{ padding: '0.1rem 0.4rem', borderRadius: '999px', background: '#fef3c7', color: '#854d0e', fontSize: '0.65rem', fontWeight: 700 }}>
                                {pageBypassed ? 'page bypassed' : 'skipped'}
                              </span>
                            )}
                            {item.whyItMatters && (
                              <span style={{ fontStyle: 'italic', color: '#64748b' }}>
                                — {item.whyItMatters.slice(0, 80)}{item.whyItMatters.length > 80 ? '…' : ''}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Per-row Skip / Restore — works for audit gaps AND
                            compliance findings now. Click doesn't propagate
                            to the row (which would jump pages). When the
                            page is wholesale-bypassed, the per-finding
                            button is hidden in favor of the jump arrow,
                            since per-finding decisions are dominated by
                            the page-level bypass anyway. */}
                        {canTriage ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (writing) return;
                              const target =
                                item.source === 'audit'
                                  ? { kind: 'audit' as const, gapId: item.gapId! }
                                  : { kind: 'compliance' as const, complianceFindingKey: item.complianceFindingKey! };
                              setOverviewFindingDecision(
                                item.pageSlug,
                                target,
                                isSkipped ? 'apply' : 'skip',
                                item.key,
                              );
                            }}
                            disabled={writing}
                            style={{
                              alignSelf: 'center', padding: '0.3rem 0.6rem',
                              fontSize: '0.72rem', fontWeight: 600, borderRadius: '6px',
                              cursor: writing ? 'wait' : 'pointer',
                              border: '1px solid ' + (isSkipped ? '#34d399' : '#fda4af'),
                              background: isSkipped ? '#ecfdf5' : '#fff1f2',
                              color: isSkipped ? '#065f46' : '#9f1239',
                              whiteSpace: 'nowrap',
                              opacity: writing ? 0.6 : 1,
                            }}
                            title={isSkipped ? 'Restore this finding to the apply set' : 'Skip this finding without opening the page'}
                          >
                            {writing ? '…' : isSkipped ? '↩ Restore' : '✕ Skip'}
                          </button>
                        ) : (
                          <div style={{ color: '#94a3b8', fontSize: '1rem', alignSelf: 'center' }}>→</div>
                        )}
                      </div>
                    );
                  })}
                  {runOverview.items.length > 50 && (
                    <div style={{ padding: '0.75rem', textAlign: 'center', fontSize: '0.8rem', color: '#64748b' }}>
                      {runOverview.items.length - 50} more findings — open individual screens from the sidebar to see them all.
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : activePage && currentApproval ? (
            (() => {
              const isPageBroken = activePage.audit?.health && !activePage.audit.health.healthy;

              return (
                <>
                  {/* Header details */}
                  <div className="detail-pane-header">
                    <div>
                      <h1 className="active-page-title">{activePage.slug}</h1>
                      <p style={{ color: '#64748b', fontSize: '0.95rem' }}>
                        Route: <code className="active-route-code">{activePage.route || '/' + activePage.slug.replace(/-/g, '/')}</code>
                      </p>
                    </div>

                    <div className="header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                      {data && !data.isGitRepo && (
                        <span className="badge badge-fail" style={{ fontSize: '0.75rem', textTransform: 'none', padding: '0.35rem 0.65rem' }}>
                          ⚠️ Non-Git Workspace
                        </span>
                      )}
                      <button 
                        onClick={handleSaveApproval} 
                        className="btn-secondary"
                        disabled={saving || applying}
                      >
                        {saving ? 'Saving...' : '💾 Save Selections'}
                      </button>
                      <button 
                        onClick={handleApplyRefactor} 
                        className="btn-primary glow-btn"
                        disabled={applying || saving || (data && !data.isGitRepo)}
                        title={data && !data.isGitRepo ? "Git repository not detected. Please use the Downloads tab to apply modifications manually." : "Auto-commit approved upgrades to your Git workspace."}
                      >
                        {applying ? 'Applying...' : '⚡ Apply Upgrades to Git'}
                      </button>
                    </div>
                  </div>

                  {isPageBroken ? (
                    /* ────────────────────────── CRITICAL FAILURE & REFIT FLOW ────────────────────────── */
                    <div className="critical-failure-view">
                      <div className="failure-banner-card">
                        <div className="failure-banner-header">
                          <span className="failure-icon">🚨</span>
                          <div>
                            <h2 className="failure-title">Critical Blocker: This screen failed to boot or load correctly</h2>
                            <p className="failure-subtitle">Headless browser could not render the URL. Direct developer action required.</p>
                          </div>
                        </div>

                        <div className="failure-banner-body">
                          <div className="failure-reason-box">
                            <strong className="reason-header">Why it broke (System Error State):</strong>
                            <code className="reason-details">{activePage.audit.health.detail || 'Connection timed out or dev server wont-start.'}</code>
                          </div>

                          <div className="failure-troubleshooting">
                            <h3>🛠️ Action Plan / How to Fix:</h3>
                            <ol>
                              <li>Ensure your local backend HTTP server is running on the expected port (e.g. port 5173 for Vite, or port 3000 for server API).</li>
                              <li>Check that your environment config matches the database and network credentials in <code>.env.local</code>.</li>
                              <li>Approve the pre-populated quick refactor below to automatically resolve common boot/route crashes in git.</li>
                            </ol>
                          </div>

                          <div className="failure-action-bar">
                            <button 
                              onClick={handleApplyRefactor} 
                              className="btn-primary glow-btn btn-large"
                              disabled={applying || saving}
                            >
                              ⚡ Approve & Apply Quick Refactor to Git
                            </button>
                          </div>
                        </div>
                      </div>

                      {activePage.codeDiff && (
                        <div className="card border-slate" style={{ marginTop: '1.5rem' }}>
                          <div className="card-header compact-header">
                            <h3 className="card-title text-indigo">📝 Pre-Populated Code Refactoring Fix</h3>
                          </div>
                          <div className="card-body" style={{ padding: 0 }}>
                            <div className="diff-panel">
                              <div className="diff-header">
                                <span className="diff-title">Proposed Fix Diff (already populated)</span>
                              </div>
                              <div className="diff-body">
                                <pre className="diff-pre">
                                  {activePage.codeDiff.split('\n').map((line, i) => {
                                    let className = 'diff-line';
                                    if (line.startsWith('+')) className += ' diff-line-add';
                                    else if (line.startsWith('-')) className += ' diff-line-del';
                                    else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) className += ' diff-line-info';

                                    return (
                                      <span key={i} className={className}>
                                        {line}
                                      </span>
                                    );
                                  })}
                                </pre>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* ────────────────────────── NORMAL HEALTHY FLOW ────────────────────────── */
                    (() => {
                      const isBypassed = currentApproval?.decision === 'skip';

                      return (
                        <>
                          {/* ────────────────────────── FOUNDER DIGEST ──────────────────────────
                              The "fix these first" view a non-technical reviewer sees before the
                              full findings list. Ranks findings across audit + compliance by
                              severity × confidence. Empty when the page has no findings. */}
                          {founderDigest.length > 0 && (
                            <div style={{
                              background: 'linear-gradient(135deg, #fdf4ff 0%, #faf5ff 100%)',
                              border: '1px solid #ddd6fe',
                              borderRadius: '12px',
                              padding: '1rem 1.25rem',
                              marginBottom: '1rem',
                              boxShadow: '0 1px 2px rgba(139, 92, 246, 0.04)',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.65rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#5b21b6', margin: 0, letterSpacing: '-0.01em' }}>
                                  ✨ What to fix first
                                </h3>
                                <span style={{ fontSize: '0.7rem', color: '#7c3aed', fontWeight: 500 }}>
                                  Top {founderDigest.length} by user impact &middot; severity × confidence
                                </span>
                              </div>
                              <p style={{ fontSize: '0.8rem', color: '#6b21a8', marginTop: 0, marginBottom: '0.85rem', lineHeight: 1.5 }}>
                                The {founderDigest.length === 1 ? 'one thing' : `${founderDigest.length} things`} most likely to embarrass you when a real user lands here — in plain English, ranked.
                              </p>
                              <ol style={{ margin: 0, paddingLeft: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                                {founderDigest.map(item => (
                                  <li key={item.key} style={{ fontSize: '0.82rem', lineHeight: 1.5, color: '#1e293b' }}>
                                    <span style={{
                                      display: 'inline-block', fontSize: '0.65rem', fontWeight: 700,
                                      textTransform: 'uppercase', letterSpacing: '0.05em',
                                      padding: '0.1rem 0.4rem', borderRadius: '3px', marginRight: '0.4rem',
                                      background:
                                        item.severity === 'critical' ? '#fee2e2' :
                                        item.severity === 'high' ? '#fed7aa' :
                                        item.severity === 'medium' ? '#fef3c7' : '#e0e7ff',
                                      color:
                                        item.severity === 'critical' ? '#991b1b' :
                                        item.severity === 'high' ? '#9a3412' :
                                        item.severity === 'medium' ? '#854d0e' : '#3730a3',
                                    }}>{item.severity}</span>
                                    {item.headline}
                                    {item.whyItMatters && (
                                      <div style={{ marginTop: '0.2rem', fontSize: '0.75rem', color: '#64748b', fontStyle: 'italic' }}>
                                        Why it matters: {item.whyItMatters}
                                      </div>
                                    )}
                                  </li>
                                ))}
                              </ol>
                            </div>
                          )}

                          {/* Redesigned grid flow: ELEVATED TWO-COLUMN HORIZONTAL DASHBOARD FLOW */}
                          <div className="horizontal-dashboard">
                            
                            {/* Column 1 (Left 60%): Selective Code Upgrades (Checking applies fixes to git) */}
                            <div 
                              className="card dashboard-card" 
                              style={{ 
                                opacity: isBypassed ? 0.55 : 1, 
                                pointerEvents: isBypassed ? 'none' : 'auto', 
                                transition: 'all 0.35s ease' 
                              }}
                            >
                              <div className="card-header compact-header">
                                <h3 className="card-title text-green">🛠️ Selective Code Upgrades (Prioritize fixes for next commit)</h3>
                                {activePage.audit && activePage.audit.gaps.length > 0 && !isBypassed && (
                                  <button 
                                    onClick={handleToggleAllGaps} 
                                    className="btn-text-action"
                                  >
                                    🔄 Toggle All ({activePage.audit.gaps.every(g => currentApproval.gaps?.[g.id] !== 'skip') ? 'Skip All' : 'Apply All'})
                                  </button>
                                )}
                              </div>
                              <div className="card-body compact-body scroll-vertical-240">
                                {isBypassed && (
                                  <div className="bypass-warning-banner" style={{ background: '#fffbeb', border: '1px solid #fef3c7', color: '#d97706', padding: '0.5rem 0.75rem', borderRadius: '6px', fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                    <span>💡</span>
                                    <span>This screen is bypassed. Selections will not be committed or processed.</span>
                                  </div>
                                )}
                            {activePage.audit && activePage.audit.gaps.length > 0 ? (
                              <>
                                {/* ─── Toolbar: read register + filter chips ─── */}
                                <div className="findings-toolbar" style={{
                                  display: 'flex', flexDirection: 'column', gap: '0.5rem',
                                  marginBottom: '0.75rem', padding: '0.65rem',
                                  background: '#f8fafc', border: '1px solid #e2e8f0',
                                  borderRadius: '8px',
                                }}>
                                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                    <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', fontWeight: 700 }}>Read as</span>
                                    <div style={{ display: 'inline-flex', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '2px' }}>
                                      <button
                                        onClick={() => setLanguageRegister('plain')}
                                        style={{
                                          padding: '0.3rem 0.65rem', fontSize: '0.75rem', fontWeight: 600,
                                          border: 'none', borderRadius: '4px', cursor: 'pointer',
                                          background: languageRegister === 'plain' ? '#2563eb' : 'transparent',
                                          color: languageRegister === 'plain' ? '#fff' : '#475569',
                                        }}
                                      >Plain English</button>
                                      <button
                                        onClick={() => setLanguageRegister('technical')}
                                        style={{
                                          padding: '0.3rem 0.65rem', fontSize: '0.75rem', fontWeight: 600,
                                          border: 'none', borderRadius: '4px', cursor: 'pointer',
                                          background: languageRegister === 'technical' ? '#2563eb' : 'transparent',
                                          color: languageRegister === 'technical' ? '#fff' : '#475569',
                                        }}
                                      >Technical</button>
                                    </div>

                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', fontWeight: 700 }}>Severity</span>
                                    {(['critical', 'high', 'medium', 'low'] as const).map(sev => {
                                      const active = severityFilter.has(sev);
                                      return (
                                        <button
                                          key={sev}
                                          onClick={() => setSeverityFilter(toggleInSet(severityFilter, sev))}
                                          style={{
                                            padding: '0.25rem 0.55rem', fontSize: '0.7rem', fontWeight: 600,
                                            border: '1px solid ' + (active ? '#2563eb' : '#cbd5e1'),
                                            borderRadius: '999px', cursor: 'pointer',
                                            background: active ? '#dbeafe' : '#fff',
                                            color: active ? '#1e40af' : '#475569',
                                            textTransform: 'capitalize',
                                          }}
                                        >{sev}</button>
                                      );
                                    })}

                                    <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                      Min confidence
                                    </span>
                                    <input
                                      type="range" min={0} max={1} step={0.05}
                                      value={minConfidence}
                                      onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                                      style={{ width: '90px' }}
                                    />
                                    <span style={{ fontSize: '0.75rem', color: '#475569', fontFamily: 'monospace', minWidth: '32px' }}>
                                      {Math.round(minConfidence * 100)}%
                                    </span>
                                  </div>

                                  {availableDimensions.length > 0 && (
                                    <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', fontWeight: 700 }}>Dimension</span>
                                      {availableDimensions.map(dim => {
                                        const active = dimensionFilter.has(dim);
                                        return (
                                          <button
                                            key={dim}
                                            onClick={() => setDimensionFilter(toggleInSet(dimensionFilter, dim))}
                                            style={{
                                              padding: '0.2rem 0.5rem', fontSize: '0.7rem', fontWeight: 500,
                                              border: '1px solid ' + (active ? '#8B5CF6' : '#e2e8f0'),
                                              borderRadius: '999px', cursor: 'pointer',
                                              background: active ? '#ede9fe' : '#fff',
                                              color: active ? '#5b21b6' : '#475569',
                                            }}
                                          >{dim}</button>
                                        );
                                      })}
                                    </div>
                                  )}

                                  {filteredGaps.length !== activePage.audit.gaps.length && (
                                    <div style={{ fontSize: '0.7rem', color: '#64748b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span>Showing {filteredGaps.length} of {activePage.audit.gaps.length} findings.</span>
                                      <button
                                        onClick={() => { setSeverityFilter(new Set()); setDimensionFilter(new Set()); setMinConfidence(0); }}
                                        style={{ background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 600, textDecoration: 'underline' }}
                                      >Clear filters</button>
                                    </div>
                                  )}
                                </div>

                                <div className="gaps-list compact-gaps">
                                  {filteredGaps.length === 0 ? (
                                    <p className="no-gaps-placeholder" style={{ fontSize: '0.85rem' }}>
                                      No findings match the current filters. <button
                                        onClick={() => { setSeverityFilter(new Set()); setDimensionFilter(new Set()); setMinConfidence(0); }}
                                        style={{ background: 'transparent', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline' }}
                                      >Clear filters</button>
                                    </p>
                                  ) : filteredGaps.map((gap) => {
                                    const isSkipped = currentApproval.gaps?.[gap.id] === 'skip';
                                    // Dual-register text resolution: in plain mode prefer the
                                    // plain-English `plain` field, falling back to description
                                    // when the agent didn't emit it. Technical mode shows the
                                    // engineer-facing description, with `plain` as a collapsible.
                                    const mainText = languageRegister === 'plain' && gap.plain
                                      ? gap.plain
                                      : gap.description;
                                    const confPct = typeof gap.confidence === 'number'
                                      ? Math.round(gap.confidence * 100)
                                      : null;
                                    // Color-code the confidence chip: ≥90% = strong (teal),
                                    // 70–90% = moderate (blue), <70% = soft (slate).
                                    const confColor = confPct === null
                                      ? null
                                      : confPct >= 90 ? { bg: '#ccfbf1', fg: '#0f766e' }
                                      : confPct >= 70 ? { bg: '#dbeafe', fg: '#1e40af' }
                                      : { bg: '#f1f5f9', fg: '#475569' };

                                    return (
                                      <div
                                        key={gap.id}
                                        className={`gap-item-row smooth-all ${!isSkipped ? 'gap-apply' : 'gap-skip'}`}
                                        onClick={() => handleGapToggle(gap.id)}
                                      >
                                        <div className="gap-row-check">
                                          <input
                                            type="checkbox"
                                            className="gap-checkbox-tactile"
                                            checked={!isSkipped}
                                            onChange={() => {}}
                                          />
                                        </div>
                                        <div className="gap-row-content">
                                          <div className="gap-row-header" style={{ gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
                                            <span className={`gap-row-tag tag-${gap.severity}`}>{gap.severity}</span>
                                            {gap.dimension ? (
                                              <span style={{
                                                fontSize: '0.65rem', fontWeight: 600, textTransform: 'lowercase',
                                                padding: '0.15rem 0.45rem', borderRadius: '999px',
                                                background: '#f3e8ff', color: '#7c3aed', border: '1px solid #ddd6fe',
                                              }}>{gap.dimension}</span>
                                            ) : (
                                              <span className="gap-row-category">{gap.category}</span>
                                            )}
                                            {confColor && (
                                              <span
                                                title="Agent confidence this finding is real"
                                                style={{
                                                  fontSize: '0.65rem', fontWeight: 700, fontFamily: 'monospace',
                                                  padding: '0.15rem 0.45rem', borderRadius: '4px',
                                                  background: confColor.bg, color: confColor.fg,
                                                }}
                                              >{confPct}%</span>
                                            )}
                                            <span className={`gap-row-pill ${!isSkipped ? 'pill-green' : 'pill-orange'}`}>
                                              {!isSkipped ? '🟢 WILL APPLY FIX' : '🟡 WILL SKIP FIX'}
                                            </span>
                                          </div>
                                          <p className="gap-row-desc">{mainText}</p>
                                          {gap.whyItMatters && languageRegister === 'plain' && (
                                            <p style={{
                                              fontStyle: 'italic', color: '#64748b', fontSize: '0.8rem',
                                              marginTop: '0.35rem', marginBottom: 0,
                                            }}>
                                              <strong style={{ fontStyle: 'normal', color: '#475569' }}>Why it matters:</strong> {gap.whyItMatters}
                                            </p>
                                          )}
                                          {languageRegister === 'technical' && gap.plain && (
                                            <details style={{ marginTop: '0.35rem', fontSize: '0.75rem', color: '#64748b' }}>
                                              <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 600 }}>
                                                Plain-English version
                                              </summary>
                                              <p style={{ marginTop: '0.25rem', marginBottom: 0 }}>{gap.plain}</p>
                                              {gap.whyItMatters && (
                                                <p style={{ marginTop: '0.25rem', marginBottom: 0, fontStyle: 'italic' }}>
                                                  <strong style={{ fontStyle: 'normal' }}>Why it matters:</strong> {gap.whyItMatters}
                                                </p>
                                              )}
                                            </details>
                                          )}
                                          {gap.recommendation && (
                                            <p className="gap-row-rec"><strong>Fix Strategy:</strong> {gap.recommendation}</p>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            ) : (
                              <p className="no-gaps-placeholder">🎉 No visual or functional blockers detected on this screen!</p>
                            )}
                          </div>
                        </div>

                        {/* Column 2 (Right 40%): Approvals Scoping & Zen Stepper Funnel */}
                        <div className="card dashboard-card">
                          <div className="card-header compact-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 className="card-title text-blue">⚡ Workspace scoping</h3>
                            {data && !data.isGitRepo && (
                              <span className="badge badge-fail" style={{ fontSize: '0.7rem', textTransform: 'none', padding: '0.25rem 0.5rem' }}>
                                ⚠️ Non-Git
                              </span>
                            )}
                          </div>
                          <div className="card-body compact-body scroll-vertical-550" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                            <div className="zen-stepper-funnel">
                              
                              {/* Step 1: Scope & Refine */}
                              <div className="zen-step-card active">
                                <div className="zen-step-header">
                                  <span className="zen-step-num">1</span>
                                  <h4 className="zen-step-title">Scope & Refine Screen</h4>
                                </div>
                                <div className="zen-step-body">
                                  <div className="approval-choices-row" style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button
                                      className={`btn-choice-pill-compact choice-apply ${currentApproval.decision === 'apply' ? 'selected' : ''}`}
                                      onClick={() => handleDecisionToggle('apply')}
                                      style={{ flex: 1 }}
                                    >
                                      🟢 APPLY UPGRADES
                                    </button>
                                    <button
                                      className={`btn-choice-pill-compact choice-skip ${currentApproval.decision === 'skip' ? 'selected' : ''}`}
                                      onClick={() => handleDecisionToggle('skip')}
                                      style={{ flex: 1 }}
                                    >
                                      🟡 BYPASS SCREEN
                                    </button>
                                  </div>

                                  <div className="form-group compact-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                    <label className="form-label compact-label" style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>PM / Client Refinement Instructions</label>
                                    <textarea
                                      rows={2}
                                      className="input-text compact-textarea"
                                      placeholder="Add refactoring adjustments, hex overrides, or notes..."
                                      value={currentApproval.note ?? ''}
                                      onChange={(e) => {
                                        setIsLedgerLocked(false);
                                        setCurrentApproval({ ...currentApproval, note: e.target.value });
                                      }}
                                      style={{ resize: 'none', background: '#fafafa', fontSize: '0.8rem', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                                    />
                                  </div>

                                  {/* Threaded Comments Timeline */}
                                  <div className="form-group compact-group" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.25rem' }}>
                                    <label className="form-label compact-label" style={{ fontSize: '0.7rem', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>Collaborative Thread</label>
                                    <div className="comments-timeline compact-timeline-overhauled" style={{ background: '#fafafa', border: '1px solid #f1f5f9', padding: '0.5rem', borderRadius: '6px', maxHeight: '120px', overflowY: 'auto' }}>
                                      {currentApproval.comments && currentApproval.comments.length > 0 ? (
                                        currentApproval.comments.map((c, i) => (
                                          <div key={i} className="comment-bubble compact-bubble" style={{ background: '#f1f5f9', borderRadius: '8px', padding: '0.35rem 0.5rem', marginBottom: '0.35rem', fontSize: '0.75rem' }}>
                                            <div className="comment-bubble-author" style={{ fontWeight: 700, color: '#475569', fontSize: '0.65rem', marginBottom: '0.1rem' }}>Collaborator</div>
                                            <div className="comment-bubble-text" style={{ color: '#1e293b' }}>{c}</div>
                                          </div>
                                        ))
                                      ) : (
                                        <p className="no-comments-placeholder" style={{ color: '#94a3b8', fontSize: '0.75rem', margin: 0, textAlign: 'center', padding: '0.5rem 0' }}>No threads active.</p>
                                      )}
                                    </div>
                                    <form onSubmit={handleAddComment} className="comments-input-row compact-row" style={{ display: 'flex', gap: '0.35rem', marginTop: '0.25rem' }}>
                                      <input
                                        type="text"
                                        className="input-text compact-input"
                                        placeholder="Reply to thread..."
                                        value={newComment}
                                        onChange={(e) => setNewComment(e.target.value)}
                                        style={{ flex: 1, padding: '0.35rem 0.5rem', fontSize: '0.75rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                                      />
                                      <button type="submit" className="input-btn compact-btn" style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', borderRadius: '4px', background: '#2563eb', color: '#ffffff', border: 'none', cursor: 'pointer' }}>Send</button>
                                    </form>
                                  </div>
                                </div>
                              </div>

                              {/* Step 1 to Step 2 Flow Connector */}
                              <div className="zen-step-connector" style={{ display: 'flex', justifyContent: 'center', margin: '0.4rem 0', color: '#94a3b8', fontSize: '1.25rem', fontWeight: 'bold' }}>↓</div>

                              {/* Step 2: Lock Selections */}
                              <div className={`zen-step-card ${currentApproval ? 'active' : 'locked'}`}>
                                <div className="zen-step-header">
                                  <span className="zen-step-num">2</span>
                                  <h4 className="zen-step-title">Lock Screen Approvals</h4>
                                </div>
                                <div className="zen-step-body">
                                  <button
                                    onClick={handleSaveApproval}
                                    disabled={saving}
                                    className={`btn-lock-ledger ${isLedgerLocked ? 'locked-success' : ''}`}
                                  >
                                    {saving ? '🔒 Locking approvals...' : isLedgerLocked ? '✓ Approvals Locked' : '💾 Lock Screen Approvals'}
                                  </button>
                                  <p style={{ fontSize: '0.7rem', color: '#64748b', margin: 0, lineHeight: 1.35 }}>
                                    Locking saves your selections to the local configuration on disk, which is instantly parsed by other AI agents to apply code upgrades.
                                  </p>
                                </div>
                              </div>

                              {/* Step 2 to Step 3 Flow Connector */}
                              <div className="zen-step-connector" style={{ display: 'flex', justifyContent: 'center', margin: '0.4rem 0', color: '#94a3b8', fontSize: '1.25rem', fontWeight: 'bold' }}>↓</div>

                              {/* Step 3: Deploy Upgrades */}
                              <div className={`zen-step-card ${isLedgerLocked ? 'active' : 'locked'}`}>
                                <div className="zen-step-header">
                                  <span className="zen-step-num">3</span>
                                  <h4 className="zen-step-title">Deploy Upgrades</h4>
                                </div>
                                <div className="zen-step-body">
                                  {!isLedgerLocked ? (
                                    <div className="step-locked-placeholder" style={{ padding: '1rem', textAlign: 'center', background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '8px', color: '#64748b' }}>
                                      <span style={{ fontSize: '1.25rem', display: 'block', marginBottom: '0.25rem' }}>🔒 Pathway Locked</span>
                                      <p style={{ fontSize: '0.75rem', margin: 0, lineHeight: 1.4 }}>
                                        Please approve and click <strong>"Lock Screen Approvals"</strong> in Step 2 to generate deploy pathways and download markdown prompts.
                                      </p>
                                    </div>
                                  ) : (
                                    data && data.isGitRepo ? (
                                    /* Git Deployment Flow */
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                      <button
                                        onClick={handleApplyRefactor}
                                        className="btn-primary glow-btn"
                                        disabled={applying || !isLedgerLocked}
                                        style={{ width: '100%', justifyContent: 'center', padding: '0.75rem', fontSize: '0.85rem' }}
                                      >
                                        {applying ? '⚡ Applying...' : '⚡ Apply Auto-Commit to Git'}
                                      </button>
                                      
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0.15rem 0' }}>
                                        <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }}></div>
                                        <span style={{ fontSize: '0.65rem', color: '#94a3b8', fontWeight: 700 }}>or copy LLM instructions</span>
                                        <div style={{ flex: 1, height: '1px', background: '#e2e8f0' }}></div>
                                      </div>

                                      <button
                                        onClick={() => {
                                          navigator.clipboard.writeText(generateAiPrompt());
                                          alert('⚡ AI Refactoring Prompt copied to clipboard!\n\nPaste this into your local AI coding assistant (Claude Code, Cursor, Antigravity, etc.) to immediately apply the approved upgrades!');
                                        }}
                                        className="btn-secondary"
                                        disabled={!isLedgerLocked}
                                        style={{ width: '100%', justifyContent: 'center', padding: '0.65rem', fontSize: '0.8rem', background: '#faf5ff', borderColor: '#ddd6fe', color: '#4f46e5' }}
                                      >
                                        🤖 Copy Resilient IDE Prompt
                                      </button>
                                    </div>
                                  ) : (
                                    /* Non-Git / Custom Integration Flow */
                                    <div className="prompt-integration-card" style={{ marginTop: 0, padding: '0.75rem', background: '#fcfdfe', border: '1px solid #ddd6fe' }}>
                                      <div className="prompt-integration-header" style={{ marginBottom: '0.25rem' }}>
                                        <span style={{ fontSize: '1.1rem' }}>🤖</span>
                                        <h5 className="prompt-integration-title" style={{ fontSize: '0.8rem', color: '#4f46e5' }}>Resilient IDE Prompt</h5>
                                      </div>
                                      <p style={{ fontSize: '0.7rem', color: '#475569', margin: 0, lineHeight: 1.35 }}>
                                        VCS branch committing is disabled for non-Git projects. Use the copier or dynamic download below to steer your editor AI co-pilot directly!
                                      </p>
                                      <div className="prompt-actions-row" style={{ display: 'flex', gap: '0.35rem', marginTop: '0.5rem' }}>
                                        <button
                                          onClick={() => {
                                            navigator.clipboard.writeText(generateAiPrompt());
                                            alert('⚡ AI Refactoring Prompt copied to clipboard!\n\nPaste this into your local AI coding assistant (Claude Code, Cursor, Antigravity, etc.) to immediately apply the approved upgrades!');
                                          }}
                                          className="btn-primary"
                                          disabled={!isLedgerLocked}
                                          style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.65rem', justifyContent: 'center' }}
                                        >
                                          📋 Copy prompt
                                        </button>
                                        <a
                                          href={`/api/download-prompt/${activePage.slug}`}
                                          className="download-prompt-btn"
                                          style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.65rem', justifyContent: 'center', border: '1px solid #ddd6fe', borderRadius: '8px', color: '#4f46e5', background: '#ffffff', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                                        >
                                          📥 Download .md
                                        </a>
                                      </div>
                                      <ul className="prompt-usage-list" style={{ marginTop: '0.5rem', paddingLeft: '1.1rem', fontSize: '0.65rem', color: '#64748b' }}>
                                        <li>Feed this prompt directly to Cursor / Claude Code / Codex.</li>
                                        <li>Leverages dynamic context merging to bypass diff rigidity!</li>
                                      </ul>
                                    </div>
                                  )
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                      </div>

                      {/* Simplified Workspace Preview Pane */}
                      <div className="workspace-preview-area full-layout">

                        {/* Visual Preview Device Container */}
                        <div className="preview-card">
                          <div className="browser-chrome-header">
                            <div className="browser-dots">
                              <span className="b-dot dot-red"></span>
                              <span className="b-dot dot-yellow"></span>
                              <span className="b-dot dot-green"></span>
                            </div>
                            <div className="browser-address-bar">
                              <span className="lock-icon">🔒</span>
                              <span className="address-text">{`http://localhost/${activePage.route || activePage.slug}`}</span>
                            </div>

                            {/* Single simple preview engine toggle */}
                            <div className="segmented-control-compact">
                              <button
                                className={`control-btn-compact ${previewMode === 'iframe' ? 'active' : ''}`}
                                disabled={!activePage.hasHtml}
                                onClick={() => setPreviewMode('iframe')}
                              >
                                🖥️ Live View
                              </button>
                              <button
                                className={`control-btn-compact ${previewMode === 'screenshot' ? 'active' : ''}`}
                                onClick={() => setPreviewMode('screenshot')}
                              >
                                🖼️ Screenshot
                              </button>
                            </div>
                          </div>

                          {/* ─── Breakpoint strip ───────────────────────────────────────
                              When Agent 1 captured multi-viewport screenshots the strip
                              renders a button per viewport. Selecting one rewrites the
                              screenshot URL with a ?breakpoint=<name> query so the same
                              preview surface shows the responsive variant.
                              Hidden when only the default capture is available. */}
                          {(() => {
                            const bps = activePage.audit?.breakpointScreenshots ?? {};
                            const names = Object.keys(bps);
                            if (names.length === 0) return null;
                            // Human-friendly labels for the canonical engine breakpoints.
                            const LABELS: Record<string, { label: string; w: number }> = {
                              mobile:  { label: '📱 iPhone',  w: 390 },
                              tablet:  { label: '📲 iPad',    w: 768 },
                              desktop: { label: '🖥️ Desktop', w: 1440 },
                            };
                            return (
                              <div style={{
                                display: 'flex', gap: '0.4rem', alignItems: 'center',
                                padding: '0.5rem 0.75rem', borderTop: '1px solid #f1f5f9',
                                borderBottom: '1px solid #f1f5f9', background: '#f8fafc',
                                overflowX: 'auto',
                              }}>
                                <span style={{
                                  fontSize: '0.65rem', textTransform: 'uppercase',
                                  letterSpacing: '0.1em', color: '#64748b', fontWeight: 700,
                                  whiteSpace: 'nowrap', marginRight: '0.25rem',
                                }}>Viewport</span>
                                <button
                                  onClick={() => setActiveBreakpoint('default')}
                                  style={{
                                    padding: '0.3rem 0.65rem', fontSize: '0.72rem', fontWeight: 600,
                                    borderRadius: '6px', cursor: 'pointer',
                                    border: '1px solid ' + (activeBreakpoint === 'default' ? '#2563eb' : '#cbd5e1'),
                                    background: activeBreakpoint === 'default' ? '#dbeafe' : '#fff',
                                    color: activeBreakpoint === 'default' ? '#1e40af' : '#475569',
                                    whiteSpace: 'nowrap',
                                  }}
                                >Default</button>
                                {names.map(name => {
                                  const meta = LABELS[name];
                                  const label = meta ? meta.label : name;
                                  const widthHint = meta ? ` · ${meta.w}px` : '';
                                  return (
                                    <button
                                      key={name}
                                      onClick={() => setActiveBreakpoint(name)}
                                      title={`Switch preview to ${name} (${meta?.w ?? '?'}px wide)`}
                                      style={{
                                        padding: '0.3rem 0.65rem', fontSize: '0.72rem', fontWeight: 600,
                                        borderRadius: '6px', cursor: 'pointer',
                                        border: '1px solid ' + (activeBreakpoint === name ? '#2563eb' : '#cbd5e1'),
                                        background: activeBreakpoint === name ? '#dbeafe' : '#fff',
                                        color: activeBreakpoint === name ? '#1e40af' : '#475569',
                                        whiteSpace: 'nowrap',
                                      }}
                                    >{label}{widthHint}</button>
                                  );
                                })}
                                <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                                  Drag the right edge below to resize freely
                                </span>
                              </div>
                            );
                          })()}

                          {/* Resizable preview wrapper — native CSS resize gives the
                              reviewer a draggable right edge to test arbitrary widths.
                              Centered, capped at the full container width. */}
                          <div style={{ display: 'flex', justifyContent: 'center', padding: '0.75rem', background: '#f8fafc' }}>
                            <div
                              className="preview-resize-wrap"
                              style={{
                                resize: 'horizontal',
                                overflow: 'auto',
                                maxWidth: '100%',
                                width: '100%',
                                minWidth: '320px',
                                background: '#fff',
                                border: '2px solid #e2e8f0',
                                borderRadius: '6px',
                                boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
                              }}
                            >
                              <div className="preview-viewport-scroll fit-scroll">
                                {previewMode === 'iframe' && activePage.hasHtml && activeBreakpoint === 'default' ? (
                                  <iframe
                                    src={`/api/html/${activePage.slug}`}
                                    sandbox="allow-scripts"
                                    title={`Static preview of ${activePage.slug}`}
                                    className="preview-iframe-snapshot"
                                    style={{ height: '800px', width: '100%', border: 'none' }}
                                  />
                                ) : activePage.hasScreenshot ? (
                                  <img
                                    className="screenshot-img-refactored"
                                    key={`${activePage.slug}-${activeBreakpoint}`}
                                    src={screenshotUrl}
                                    alt={`Rendered screenshot of ${activePage.slug} at ${activeBreakpoint}`}
                                    style={{ display: 'block', width: '100%', height: 'auto' }}
                                    onError={(e) => {
                                      // Graceful fallback — e.g. the requested breakpoint file
                                      // hasn't been captured for this page, or mock data
                                      // doesn't ship images.
                                      e.currentTarget.style.display = 'none';
                                      const parent = e.currentTarget.parentElement;
                                      if (parent && !parent.querySelector('.screenshot-placeholder-mock')) {
                                        const placeholder = document.createElement('div');
                                        placeholder.className = 'screenshot-placeholder-mock';
                                        placeholder.innerHTML = activeBreakpoint === 'default'
                                          ? '🖼️ Mock Preview Asset Loaded'
                                          : `📐 No ${activeBreakpoint} capture available for this page.`;
                                        parent.appendChild(placeholder);
                                      }
                                    }}
                                  />
                                ) : (
                                  <div className="no-screenshot">
                                    <span style={{ fontSize: '2.5rem' }}>🖼️</span>
                                    <p>No preview asset available for this page.</p>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>

                      </div>
                    </div>

                      {/* UX & Design specs displayed cleanly under the preview card */}
                      <div className="specs-accordions-row">
                        {activePage.ux && (
                          <div className="card spec-card-flat">
                            <div className="card-header spec-header">
                              <h3 className="card-title text-indigo">📐 UX Wireframe Blueprint</h3>
                            </div>
                            <div className="card-body spec-body font-mono">
                              <pre className="ascii-wireframe">{activePage.ux.asciiWireframe}</pre>
                            </div>
                          </div>
                        )}

                        {activePage.design && (
                          <div className="card spec-card-flat">
                            <div className="card-header spec-header">
                              <h3 className="card-title text-blue">🎨 Brand Tokens Inventory</h3>
                            </div>
                            <div className="card-body spec-body">
                              <pre className="pre-spec">{activePage.design.spec}</pre>
                              <div style={{ marginTop: '1rem' }}>
                                <strong style={{ fontSize: '0.8rem', color: '#64748b' }}>Design Tokens:</strong>
                                <div className="badge-row" style={{ marginTop: '0.25rem' }}>
                                  {activePage.design.brandTokensUsed.map((t, idx) => (
                                    <span key={idx} className="badge badge-apply">{t}</span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Proposed Code Refactoring Changes */}
                      {activePage.codeDiff && (
                        <div className="card border-slate">
                          <div className="card-header">
                            <h3 className="card-title">📝 Proposed Refactoring Changes</h3>
                          </div>
                          <div className="card-body" style={{ padding: 0 }}>
                            <div className="diff-panel">
                              <div className="diff-header">
                                <span className="diff-title">Git Code Refactor Verification Proposal (code.diff)</span>
                              </div>
                              <div className="diff-body">
                                <pre className="diff-pre">
                                  {activePage.codeDiff.split('\n').map((line, i) => {
                                    let className = 'diff-line';
                                    if (line.startsWith('+')) className += ' diff-line-add';
                                    else if (line.startsWith('-')) className += ' diff-line-del';
                                    else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++')) className += ' diff-line-info';

                                    return (
                                      <span key={i} className={className}>
                                        {line}
                                      </span>
                                    );
                                  })}
                                </pre>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                        </>
                      );
                    })()
                  )}
                </>
              );
            })()
          ) : (
            <div className="no-selection glass-card">
              <span style={{ fontSize: '3rem' }}>🎯</span>
              <h2>Select a screen to review details</h2>
              <p>Choose any screen from the sidebar to verify visual screenshots, design tokens, audit findings, and code upgrades.</p>
            </div>
          )}
        </section>
      </main>

      {/* Reframe Engine Blueprint Slide-out Drawer */}
      <div 
        className={`architecture-drawer-backdrop ${isArchDrawerOpen ? 'backdrop-visible' : ''}`} 
        onClick={() => setIsArchDrawerOpen(false)}
      ></div>
      
      <div className={`architecture-drawer-overlay ${isArchDrawerOpen ? 'drawer-open' : ''}`}>
        <div className="drawer-header">
          <h3 className="drawer-title">📖 Reframe Engine Blueprint</h3>
          <button className="drawer-close-btn" onClick={() => setIsArchDrawerOpen(false)}>×</button>
        </div>
        <div className="drawer-body">
          <p style={{ fontSize: '0.8rem', color: '#475569', lineHeight: 1.5, margin: 0 }}>
            Reframe orchestrates a 6-agent sequential pipeline to map, audit, refactor, and verify visual and functional states across your workspace.
          </p>

          <div className="blueprint-section" style={{ borderTop: '1px solid #f1f5f9', paddingTop: '1rem', marginTop: '0.5rem' }}>
            <h4 style={{ fontSize: '0.85rem', color: '#1e293b', marginBottom: '0.65rem', fontWeight: 600 }}>🤖 Engine Gate Overrides</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
              {Object.entries(gateOverrides).map(([gate, active]) => (
                <div key={gate} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: '#334155', textTransform: 'capitalize' }}>
                    {gate.replace(/([A-Z])/g, ' $1')}
                  </span>
                  <label className="switch" style={{ display: 'inline-block', width: '32px', height: '18px', position: 'relative' }}>
                    <input 
                      type="checkbox" 
                      checked={active}
                      onChange={() => {
                        setGateOverrides(prev => ({
                          ...prev,
                          [gate]: !active
                        }));
                      }}
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span style={{
                      position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0,
                      backgroundColor: active ? '#2563eb' : '#cbd5e1',
                      borderRadius: '34px', transition: '0.3s'
                    }}>
                      <span style={{
                        position: 'absolute', content: '""', height: '12px', width: '12px', left: '3px', bottom: '3px',
                        backgroundColor: 'white', borderRadius: '50%', transition: '0.3s',
                        transform: active ? 'translateX(14px)' : 'translateX(0)'
                      }} />
                    </span>
                  </label>
                </div>
              ))}
            </div>
          </div>

          <div className="blueprint-section" style={{ borderTop: '1px solid #f1f5f9', paddingTop: '1rem', marginTop: '0.5rem' }}>
            <h4 style={{ fontSize: '0.85rem', color: '#1e293b', marginBottom: '0.5rem', fontWeight: 600 }}>📊 6-Agent Execution Lifecycle</h4>
            <ol style={{ fontSize: '0.7rem', color: '#475569', paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.45rem', lineHeight: 1.4 }}>
              <li><strong>Agent 0 (Map):</strong> Scaffolds the app structure into user-facing page components.</li>
              <li><strong>Agent 1 (Audit):</strong> Opens headless Chromium, checks health, and catalogs UX bugs.</li>
              <li><strong>Agent 2 (UX Design):</strong> Designs wireframe blueprints and structures clean token overrides.</li>
              <li><strong>Agent 3 (Compliance):</strong> Assesses security, legal compliance, and color-contrast benchmarks.</li>
              <li><strong>Agent 4 (Code Refit):</strong> Writes the git-patch diffs or compiles IDE instruction ledger.</li>
              <li><strong>Agent 5 (Verify):</strong> Performs Playwright assertions, exercising inputs to confirm health.</li>
            </ol>
          </div>

          <div style={{ marginTop: '1.25rem', padding: '0.65rem', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', fontSize: '0.7rem', color: '#1e40af', display: 'flex', gap: '0.35rem', lineHeight: 1.35 }}>
            <span>💡</span>
            <span>Manual overrides bypass validation steps in subsequent agent runs. Use with caution.</span>
          </div>
        </div>
      </div>

      {/* Floating Blueprint Trigger Button */}
      <button 
        className="btn-blueprint-trigger"
        onClick={() => setIsArchDrawerOpen(true)}
      >
        📖 Engine Blueprint
      </button>
    </div>
  );
}
