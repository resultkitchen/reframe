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

  // Local state changes before saving to disk
  const [currentApproval, setCurrentApproval] = useState<PageApproval | null>(null);

  // Zoom mode for visual preview: 'fit' or 'native'
  const [zoomMode, setZoomMode] = useState<'fit' | 'native'>('fit');

  // View layout format: 'split' (side-by-side) or 'full' (stacked full-width visual)
  const [viewLayout, setViewLayout] = useState<'split' | 'full'>('full');

  // Preview mode: 'iframe' or 'screenshot'
  const [previewMode, setPreviewMode] = useState<'iframe' | 'screenshot'>('iframe');

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
      
      // Auto-select first page if none selected
      if (json.pages && json.pages.length > 0 && !activeSlug) {
        setActiveSlug(json.pages[0].slug);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Sync current selection when active page changes
  useEffect(() => {
    if (!data || !activeSlug) return;
    
    const page = data.pages.find(p => p.slug === activeSlug);
    if (page) {
      setPreviewMode(page.hasHtml ? 'iframe' : 'screenshot');
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
          {activePage && currentApproval ? (
            <>
              {/* Header details */}
              <div className="detail-pane-header">
                <div>
                  <h1 className="active-page-title">{activePage.slug}</h1>
                  <p style={{ color: '#64748b', fontSize: '0.95rem' }}>
                    Route: <code className="active-route-code">{activePage.route || '/' + activePage.slug.replace(/-/g, '/')}</code>
                  </p>
                </div>

                <div className="header-actions">
                  <button 
                    onClick={handleSaveApproval} 
                    className="btn-primary glow-btn"
                    disabled={saving}
                  >
                    {saving ? 'Saving...' : '💾 Save Page Ledger'}
                  </button>
                </div>
              </div>

              {/* Redesigned grid flow: ELEVATED HORIZONTAL DASHBOARD FLOW */}
              <div className="horizontal-dashboard">
                
                {/* Column 1: Page Summary Card & Approvals */}
                <div className="card dashboard-card">
                  <div className="card-header compact-header">
                    <h3 className="card-title text-blue">📋 Page Summary & Approvals</h3>
                  </div>
                  <div className="card-body compact-body">
                    <div className="scoping-info">
                      <span className="info-label">Role Scope:</span>
                      <p className="info-desc">
                        {
                          (activePage.route || '').startsWith('/admin')
                            ? '🛡️ Restricted Admin Control (Audited with Admin credentials)'
                            : (activePage.route || '').startsWith('/media-buyer')
                              ? '📊 Media Buyer Portal (Audited with Campaign credentials)'
                              : (activePage.route || '').startsWith('/dashboard')
                                ? '⚖️ Attorney Tracking Dashboard (Audited with Lead credentials)'
                                : '🌐 Public Marketing Screen / Public Guest Funnel'
                        }
                      </p>
                    </div>

                    <div className="approval-choices">
                      <button
                        className={`btn-choice-pill smooth-all choice-apply ${currentApproval.decision === 'apply' ? 'selected' : ''}`}
                        onClick={() => handleDecisionToggle('apply')}
                      >
                        🟢 WILL APPLY REBUILDS
                      </button>
                      <button
                        className={`btn-choice-pill smooth-all choice-skip ${currentApproval.decision === 'skip' ? 'selected' : ''}`}
                        onClick={() => handleDecisionToggle('skip')}
                      >
                        🟡 SKIP ALL REBUILDS
                      </button>
                    </div>

                    <div className="form-group compact-group">
                      <label className="form-label compact-label">PM / Client Refinement Instructions</label>
                      <textarea
                        rows={2}
                        className="input-text compact-textarea"
                        placeholder="Refinement instructions..."
                        value={currentApproval.note ?? ''}
                        onChange={(e) => setCurrentApproval({ ...currentApproval, note: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                {/* Column 2: Threaded Designer/PM Feedback */}
                <div className="card dashboard-card">
                  <div className="card-header compact-header">
                    <h3 className="card-title text-indigo">💬 Refinement Comments</h3>
                  </div>
                  <div className="card-body compact-body flex-col-layout">
                    <div className="comments-timeline compact-timeline">
                      {currentApproval.comments && currentApproval.comments.length > 0 ? (
                        currentApproval.comments.map((c, i) => (
                          <div key={i} className="comment-bubble compact-bubble">
                            <div className="comment-bubble-author">Collaborator</div>
                            <div className="comment-bubble-text">{c}</div>
                          </div>
                        ))
                      ) : (
                        <p className="no-comments-placeholder">
                          No feedback comments. Type below to add.
                        </p>
                      )}
                    </div>

                    <form onSubmit={handleAddComment} className="comments-input-row compact-row">
                      <input
                        type="text"
                        className="input-text compact-input"
                        placeholder="Add comment..."
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                      />
                      <button type="submit" className="input-btn compact-btn">Send</button>
                    </form>
                  </div>
                </div>

                {/* Column 3: Selective Upgrades Checklist */}
                <div className="card dashboard-card flex-double">
                  <div className="card-header compact-header">
                    <h3 className="card-title text-green">🛠️ Selective Code Upgrades</h3>
                    {activePage.audit && activePage.audit.gaps.length > 0 && (
                      <button 
                        onClick={handleToggleAllGaps} 
                        className="btn-text-action"
                      >
                        🔄 Toggle All ({activePage.audit.gaps.every(g => currentApproval.gaps?.[g.id] !== 'skip') ? 'Skip All' : 'Apply All'})
                      </button>
                    )}
                  </div>
                  <div className="card-body compact-body scroll-vertical-180">
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
                                <span className={`status-dot ${!isSkipped ? 'dot-green' : 'dot-orange'}`}></span>
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
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="no-gaps-placeholder">🎉 No architectural or visual gaps detected on this page!</p>
                    )}
                  </div>
                </div>

              </div>

              {/* Consolidated Workspace Toolbar */}
              <div className="workspace-toolbar">
                <div className="toolbar-left">
                  <span className="toolbar-section-label">👀 PREVIEW ENGINE</span>
                  <div className="segmented-control">
                    <button
                      className={`control-btn ${previewMode === 'iframe' ? 'active' : ''}`}
                      disabled={!activePage.hasHtml}
                      onClick={() => setPreviewMode('iframe')}
                      title={activePage.hasHtml ? "View live sandboxed HTML preview" : "HTML snapshot not available"}
                    >
                      🖥️ Live HTML {activePage.hasHtml ? '🟢' : '⚪'}
                    </button>
                    <button
                      className={`control-btn ${previewMode === 'screenshot' ? 'active' : ''}`}
                      onClick={() => setPreviewMode('screenshot')}
                      title="View static image screenshot"
                    >
                      🖼️ Screenshot 🟢
                    </button>
                  </div>
                </div>

                <div className="toolbar-center">
                  <span className="toolbar-section-label">📐 VIEWPORT SIZE</span>
                  <div className="segmented-control">
                    <button
                      className={`control-btn ${zoomMode === 'fit' ? 'active' : ''}`}
                      onClick={() => setZoomMode('fit')}
                    >
                      📺 Fit viewport
                    </button>
                    <button
                      className={`control-btn ${zoomMode === 'native' ? 'active' : ''}`}
                      onClick={() => setZoomMode('native')}
                    >
                      🔍 100% Native
                    </button>
                  </div>
                </div>

                <div className="toolbar-right">
                  <span className="toolbar-section-label">📂 WORKSPACE LAYOUT</span>
                  <div className="segmented-control">
                    <button
                      className={`control-btn ${viewLayout === 'split' ? 'active' : ''}`}
                      onClick={() => setViewLayout('split')}
                    >
                      📂 Split view
                    </button>
                    <button
                      className={`control-btn ${viewLayout === 'full' ? 'active' : ''}`}
                      onClick={() => setViewLayout('full')}
                    >
                      🖥️ Full-width
                    </button>
                  </div>
                </div>
              </div>

              {/* Sandboxed, scrollable and premium preview pane */}
              <div className={`workspace-preview-area ${viewLayout === 'split' ? 'split-layout' : 'full-layout'}`}>
                
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
                    <div className="browser-engine-badge">
                      {previewMode === 'iframe' ? 'Sandboxed HTML5' : 'Static PNG'}
                    </div>
                  </div>

                  <div className={`preview-viewport-scroll ${zoomMode === 'native' ? 'native-scroll' : 'fit-scroll'}`}>
                    {previewMode === 'iframe' && activePage.hasHtml ? (
                      <iframe
                        src={`/api/html/${activePage.slug}`}
                        sandbox="allow-scripts"
                        title={`Static preview of ${activePage.slug}`}
                        className="preview-iframe-snapshot"
                        style={zoomMode === 'native' ? { height: '1500px' } : { height: '800px' }}
                      />
                    ) : activePage.hasScreenshot ? (
                      <img
                        className="screenshot-img-refactored"
                        src={`/api/screenshot/${activePage.slug}`}
                        alt={`Rendered screenshot of ${activePage.slug}`}
                      />
                    ) : (
                      <div className="no-screenshot">
                        <span style={{ fontSize: '2.5rem' }}>🖼️</span>
                        <p>No preview asset available for this page.</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Split view spec panel if viewLayout === 'split' */}
                {viewLayout === 'split' && (
                  <div className="split-specs-container">
                    
                    {/* ASCII wireframe or specs if available */}
                    {activePage.ux && (
                      <div className="card compact-spec-card">
                        <div className="card-header spec-header">
                          <h3 className="card-title text-indigo">📐 UX Wireframe Spec</h3>
                        </div>
                        <div className="card-body spec-body font-mono">
                          <pre className="ascii-wireframe">{activePage.ux.asciiWireframe}</pre>
                        </div>
                      </div>
                    )}

                    {activePage.design && (
                      <div className="card compact-spec-card">
                        <div className="card-header spec-header">
                          <h3 className="card-title text-blue">🎨 Design Spec</h3>
                        </div>
                        <div className="card-body spec-body">
                          <pre className="pre-spec">{activePage.design.spec}</pre>
                          <div style={{ marginTop: '1rem' }}>
                            <strong style={{ fontSize: '0.8rem', color: '#64748b' }}>Brand Tokens:</strong>
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
                )}
              </div>

              {/* Code Diffs Proposed changes */}
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
