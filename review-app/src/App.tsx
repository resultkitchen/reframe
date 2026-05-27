import React, { useState, useEffect } from 'react';

interface Gap {
  id: string;
  category: 'functional' | 'ux';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  recommendation: string;
}

interface Finding {
  ruleId: string;
  domain: string;
  severity: string;
  location: string;
  problem: string;
  requiredFix: string;
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
    setCurrentApproval({
      ...currentApproval,
      decision,
    });
  };

  // Toggle individual gap decision (Apply vs Skip)
  const handleGapToggle = (gapId: string) => {
    if (!currentApproval) return;
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
        alert('Approvals saved successfully!');
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

                    {/* Decision badge */}
                    {approval ? (
                      approval.decision === 'apply' ? (
                        <span className="badge badge-apply">Apply</span>
                      ) : (
                        <span className="badge badge-skip">Skip</span>
                      )
                    ) : null}
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

          {activePage && currentApproval ? (
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
                    <>
                      {/* Redesigned grid flow: ELEVATED TWO-COLUMN HORIZONTAL DASHBOARD FLOW */}
                      <div className="horizontal-dashboard">
                        
                        {/* Column 1 (Left 60%): Selective Code Upgrades (Checking applies fixes to git) */}
                        <div className="card dashboard-card">
                          <div className="card-header compact-header">
                            <h3 className="card-title text-green">🛠️ Selective Code Upgrades (Prioritize fixes for next commit)</h3>
                            {activePage.audit && activePage.audit.gaps.length > 0 && (
                              <button 
                                onClick={handleToggleAllGaps} 
                                className="btn-text-action"
                              >
                                🔄 Toggle All ({activePage.audit.gaps.every(g => currentApproval.gaps?.[g.id] !== 'skip') ? 'Skip All' : 'Apply All'})
                              </button>
                            )}
                          </div>
                          <div className="card-body compact-body scroll-vertical-240">
                            {activePage.audit && activePage.audit.gaps.length > 0 ? (
                              <div className="gaps-list compact-gaps">
                                {activePage.audit.gaps.map((gap) => {
                                  const isSkipped = currentApproval.gaps?.[gap.id] === 'skip';

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
                                          onChange={() => {}} // toggled by row click
                                        />
                                      </div>
                                      <div className="gap-row-content">
                                        <div className="gap-row-header">
                                          <span className={`gap-row-tag tag-${gap.severity}`}>{gap.severity}</span>
                                          <span className="gap-row-category">{gap.category}</span>
                                          <span className={`gap-row-pill ${!isSkipped ? 'pill-green' : 'pill-orange'}`}>
                                            {!isSkipped ? '🟢 WILL APPLY FIX' : '🟡 WILL SKIP FIX'}
                                          </span>
                                        </div>
                                        <p className="gap-row-desc">{gap.description}</p>
                                        {gap.recommendation && (
                                          <p className="gap-row-rec"><strong>Fix Strategy:</strong> {gap.recommendation}</p>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <p className="no-gaps-placeholder">🎉 No visual or functional blockers detected on this screen!</p>
                            )}
                          </div>
                        </div>

                        {/* Column 2 (Right 40%): Approvals Scoping & Interactive Guides */}
                        <div className="card dashboard-card">
                          <div className="card-header compact-header" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'stretch' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <h3 className="card-title text-blue">⚡ Workspace & scoping</h3>
                            </div>
                            
                            {/* Segmented Tab Strip */}
                            <div className="segmented-control" style={{ width: '100%' }}>
                              <button 
                                className={`control-btn ${activeRightTab === 'decisions' ? 'active' : ''}`}
                                onClick={() => setActiveRightTab('decisions')}
                                style={{ flex: 1, textAlign: 'center' }}
                              >
                                📋 Decisions
                              </button>
                              <button 
                                className={`control-btn ${activeRightTab === 'guide' ? 'active' : ''}`}
                                onClick={() => setActiveRightTab('guide')}
                                style={{ flex: 1, textAlign: 'center' }}
                              >
                                🧭 Guide
                              </button>
                              <button 
                                className={`control-btn ${activeRightTab === 'downloads' ? 'active' : ''}`}
                                onClick={() => setActiveRightTab('downloads')}
                                style={{ flex: 1, textAlign: 'center' }}
                              >
                                📥 Downloads
                              </button>
                              <button 
                                className={`control-btn ${activeRightTab === 'architecture' ? 'active' : ''}`}
                                onClick={() => setActiveRightTab('architecture')}
                                style={{ flex: 1, textAlign: 'center' }}
                              >
                                📖 Architecture
                              </button>
                            </div>
                          </div>
                          <div className="card-body compact-body flex-col-layout">
                            {activeRightTab === 'decisions' && (
                              /* ────────────────────────── DECISIONS TAB ────────────────────────── */
                              <>
                                <div className="scoping-action-card">
                                  <div className="approval-choices-row">
                                    <button
                                      className={`btn-choice-pill-compact choice-apply ${currentApproval.decision === 'apply' ? 'selected' : ''}`}
                                      onClick={() => handleDecisionToggle('apply')}
                                    >
                                      🟢 APPLY UPGRADES
                                    </button>
                                    <button
                                      className={`btn-choice-pill-compact choice-skip ${currentApproval.decision === 'skip' ? 'selected' : ''}`}
                                      onClick={() => handleDecisionToggle('skip')}
                                    >
                                      🟡 BYPASS SCREEN
                                    </button>
                                  </div>

                                  <div className="approvals-explain-box">
                                    <p className="explain-text">
                                      <strong>Scoping Decisions:</strong> Choose whether to refactor this screen. Use the checkbox list on the left to prioritize specific fixes.
                                    </p>
                                  </div>

                                  {data && !data.isGitRepo && currentApproval.decision === 'apply' && (
                                    <div className="prompt-integration-card">
                                      <div className="prompt-integration-header">
                                        <span style={{ fontSize: '1.25rem' }}>🤖</span>
                                        <h5 className="prompt-integration-title">Resilient AI Refactoring Prompt</h5>
                                      </div>
                                      <p style={{ fontSize: '0.75rem', color: '#475569', margin: 0, lineHeight: 1.4 }}>
                                        This is a non-Git workspace. Direct auto-commits are disabled. Instead, copy or download the dynamic instruction prompt below to apply the refactor directly in your editor co-pilot!
                                      </p>
                                      <div className="prompt-actions-row">
                                        <button
                                          onClick={() => {
                                            navigator.clipboard.writeText(generateAiPrompt());
                                            alert('⚡ AI Refactoring Prompt copied to clipboard!\n\nPaste this into your local AI coding assistant (Claude Code, Cursor, Antigravity, etc.) to immediately apply the approved upgrades!');
                                          }}
                                          className="btn-primary"
                                          style={{ fontSize: '0.8rem', padding: '0.5rem 0.75rem', justifyContent: 'center' }}
                                        >
                                          📋 Copy prompt
                                        </button>
                                        <a
                                          href={`/api/download-prompt/${activePage.slug}`}
                                          className="download-prompt-btn"
                                        >
                                          📥 Download .md
                                        </a>
                                      </div>
                                      <ul className="prompt-usage-list">
                                        <li>Open target project in Cursor or Claude Code.</li>
                                        <li>Feed this prompt to the AI to merge style & visual gaps.</li>
                                        <li>Maintains brand consistency without strict patch rigidity!</li>
                                      </ul>
                                    </div>
                                  )}
                                </div>

                                <div className="form-group compact-group">
                                  <label className="form-label compact-label">PM / Client Refinement Instructions</label>
                                  <textarea
                                    rows={2}
                                    className="input-text compact-textarea"
                                    placeholder="Add refactoring adjustments, hex overrides, or notes..."
                                    value={currentApproval.note ?? ''}
                                    onChange={(e) => setCurrentApproval({ ...currentApproval, note: e.target.value })}
                                  />
                                </div>

                                <div className="comments-timeline compact-timeline-overhauled">
                                  {currentApproval.comments && currentApproval.comments.length > 0 ? (
                                    currentApproval.comments.map((c, i) => (
                                      <div key={i} className="comment-bubble compact-bubble">
                                        <div className="comment-bubble-author">Collaborator</div>
                                        <div className="comment-bubble-text">{c}</div>
                                      </div>
                                    ))
                                  ) : (
                                    <p className="no-comments-placeholder">No collaborator threads started.</p>
                                  )}
                                </div>

                                <form onSubmit={handleAddComment} className="comments-input-row compact-row">
                                  <input
                                    type="text"
                                    className="input-text compact-input"
                                    placeholder="Reply thread..."
                                    value={newComment}
                                    onChange={(e) => setNewComment(e.target.value)}
                                  />
                                  <button type="submit" className="input-btn compact-btn">Send</button>
                                </form>
                              </>
                            )}

                            {activeRightTab === 'guide' && (
                              /* ────────────────────────── GUIDE TAB ────────────────────────── */
                              <div className="guide-tab scroll-vertical-240">
                                <div className="guide-stepper">
                                  <div className="stepper-item">
                                    <span className="stepper-badge">Step 1</span>
                                    <p className="stepper-text">Review and select selective upgrades on the left.</p>
                                  </div>
                                  <div className="stepper-item">
                                    <span className="stepper-badge">Step 2</span>
                                    <p className="stepper-text">Add any PM notes or hex overrides in the textbox above.</p>
                                  </div>
                                  <div className="stepper-item">
                                    <span className="stepper-badge">Step 3</span>
                                    <p className="stepper-text">Toggle target scoping (Apply vs Bypass) and hit "Save Selections".</p>
                                  </div>
                                </div>

                                <div className="guide-ledger-box">
                                  <h4>💾 Local approvals database path:</h4>
                                  <p className="guide-meta-desc">Your selections are stored in a standard JSON format that is instantly referenceable by other local agents (Claude Code, Antigravity, Codex):</p>
                                  <code className="guide-path-code" title="Click to copy" onClick={(e) => {
                                    navigator.clipboard.writeText(`${data.runDir}\\approvals.json`);
                                    alert('Ledger path copied to clipboard!');
                                  }}>
                                    {`${data.runDir.substring(0, 45)}...\\approvals.json`}
                                  </code>
                                </div>
                              </div>
                            )}

                            {activeRightTab === 'architecture' && (
                              /* ────────────────────────── ENGINE ARCHITECTURE & CHECKPOINTS TAB ────────────────────────── */
                              <div className="architecture-tab scroll-vertical-240" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                                <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '0.75rem', fontSize: '0.8rem', color: '#1e40af' }}>
                                  <strong>1-Mapper + 6-Agent Fan-Out Engine:</strong> Reframe runs a multi-agent pipeline to map routes, audit code/UX, rewrite files, and verify results. Override gates below to steer the pipeline direction.
                                </div>

                                <div className="architecture-stepper">
                                  {/* Checkpoint 1 */}
                                  <div className={`checkpoint-step ${gateOverrides.cataloging ? 'pass' : 'fail'}`}>
                                    <span className="checkpoint-marker-circle">1</span>
                                    <div className="checkpoint-details">
                                      <div className="checkpoint-meta">
                                        <span className="checkpoint-name">Stage 0: Page Mapping</span>
                                        <span className={`checkpoint-badge ${gateOverrides.cataloging ? 'checkpoint-badge-pass' : 'checkpoint-badge-fail'}`}>
                                          {gateOverrides.cataloging ? 'Passed' : 'Bypassed'}
                                        </span>
                                      </div>
                                      <p className="checkpoint-desc">Maps absolute routes, gates, and brand tokens.</p>
                                      <div className="checkpoint-override-action">
                                        <span className="override-label">Enforce strict mapping path</span>
                                        <label className="switch-container">
                                          <input 
                                            type="checkbox" 
                                            className="switch-input" 
                                            checked={gateOverrides.cataloging}
                                            onChange={() => setGateOverrides(prev => ({ ...prev, cataloging: !prev.cataloging }))}
                                          />
                                          <span className="switch-track"><span className="switch-thumb"></span></span>
                                        </label>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Checkpoint 2 */}
                                  <div className={`checkpoint-step ${gateOverrides.visualReview ? 'pass' : 'fail'}`}>
                                    <span className="checkpoint-marker-circle">2</span>
                                    <div className="checkpoint-details">
                                      <div className="checkpoint-meta">
                                        <span className="checkpoint-name">Stage 1-4: Visual & UX Review</span>
                                        <span className={`checkpoint-badge ${gateOverrides.visualReview ? 'checkpoint-badge-pass' : 'checkpoint-badge-fail'}`}>
                                          {gateOverrides.visualReview ? 'Enforced' : 'Yolo mode'}
                                        </span>
                                      </div>
                                      <p className="checkpoint-desc">Audits responsiveness, styling contrast, accessibility, and brand specs.</p>
                                      <div className="checkpoint-override-action">
                                        <span className="override-label">Enforce compliance criteria</span>
                                        <label className="switch-container">
                                          <input 
                                            type="checkbox" 
                                            className="switch-input" 
                                            checked={gateOverrides.visualReview}
                                            onChange={() => setGateOverrides(prev => ({ ...prev, visualReview: !prev.visualReview }))}
                                          />
                                          <span className="switch-track"><span className="switch-thumb"></span></span>
                                        </label>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Checkpoint 3 */}
                                  <div className={`checkpoint-step ${gateOverrides.refactoringPrompt ? 'pass' : 'fail'}`}>
                                    <span className="checkpoint-marker-circle">3</span>
                                    <div className="checkpoint-details">
                                      <div className="checkpoint-meta">
                                        <span className="checkpoint-name">Stage 5: Code Refactoring</span>
                                        <span className={`checkpoint-badge ${gateOverrides.refactoringPrompt ? 'checkpoint-badge-pass' : 'checkpoint-badge-fail'}`}>
                                          {gateOverrides.refactoringPrompt ? 'Resilient Prompt' : 'Rigid Git Patch'}
                                        </span>
                                      </div>
                                      <p className="checkpoint-desc">Generates code upgrades based on review recommendations.</p>
                                      <div className="checkpoint-override-action">
                                        <span className="override-label">Use Resilient AI Prompt instead of Patch</span>
                                        <label className="switch-container">
                                          <input 
                                            type="checkbox" 
                                            className="switch-input" 
                                            checked={gateOverrides.refactoringPrompt}
                                            onChange={() => setGateOverrides(prev => ({ ...prev, refactoringPrompt: !prev.refactoringPrompt }))}
                                          />
                                          <span className="switch-track"><span className="switch-thumb"></span></span>
                                        </label>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Checkpoint 4 */}
                                  <div className={`checkpoint-step ${gateOverrides.playwrightVerify ? 'pass' : 'fail'}`}>
                                    <span className="checkpoint-marker-circle">4</span>
                                    <div className="checkpoint-details">
                                      <div className="checkpoint-meta">
                                        <span className="checkpoint-name">Stage 6: Playwright Verification</span>
                                        <span className={`checkpoint-badge ${gateOverrides.playwrightVerify ? 'checkpoint-badge-pass' : 'checkpoint-badge-fail'}`}>
                                          {gateOverrides.playwrightVerify ? 'Strict' : 'Flexible'}
                                        </span>
                                      </div>
                                      <p className="checkpoint-desc">Runs automated build tests and records visual screen health.</p>
                                      <div className="checkpoint-override-action">
                                        <span className="override-label">Halt entire run on verification error</span>
                                        <label className="switch-container">
                                          <input 
                                            type="checkbox" 
                                            className="switch-input" 
                                            checked={gateOverrides.playwrightVerify}
                                            onChange={() => setGateOverrides(prev => ({ ...prev, playwrightVerify: !prev.playwrightVerify }))}
                                          />
                                          <span className="switch-track"><span className="switch-thumb"></span></span>
                                        </label>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )}
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

                          <div className="preview-viewport-scroll fit-scroll">
                            {previewMode === 'iframe' && activePage.hasHtml ? (
                              <iframe
                                src={`/api/html/${activePage.slug}`}
                                sandbox="allow-scripts"
                                title={`Static preview of ${activePage.slug}`}
                                className="preview-iframe-snapshot"
                                style={{ height: '800px' }}
                              />
                            ) : activePage.hasScreenshot ? (
                              <img
                                className="screenshot-img-refactored"
                                src={`/api/screenshot/${activePage.slug}`}
                                alt={`Rendered screenshot of ${activePage.slug}`}
                                onError={(e) => {
                                  // gracefull fallback for missing image (e.g. mock slug mismatch)
                                  e.currentTarget.style.display = 'none';
                                  const parent = e.currentTarget.parentElement;
                                  if (parent) {
                                    const placeholder = document.createElement('div');
                                    placeholder.className = 'screenshot-placeholder-mock';
                                    placeholder.innerHTML = '🖼️ Mock Preview Asset Loaded';
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
    </div>
  );
}
