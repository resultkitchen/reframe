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
      const page = data.pages.find(p => p.slug === activeSlug);
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
          <span className="logo-sub">Visual Review</span>
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
                  <span className="page-item-subtitle">{p.route}</span>

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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h1 style={{ fontSize: '1.75rem', marginBottom: '0.25rem' }}>{activePage.slug}</h1>
                  <p style={{ color: '#64748b', fontSize: '0.95rem' }}>Route: <code style={{ color: '#0f172a' }}>{activePage.route}</code></p>
                </div>

                <button 
                  onClick={handleSaveApproval} 
                  className="btn-primary glow-btn"
                  disabled={saving}
                >
                  {saving ? 'Saving...' : '💾 Save Page Ledger'}
                </button>
              </div>

              {/* Side-by-Side visual workspace */}
              <div className="workspace-grid">
                
                {/* LEFT COLUMN: Visual mockup preview */}
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">📱 Headless Browser Screen Capture</h3>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="btn-secondary"
                        style={{
                          padding: '0.25rem 0.65rem',
                          fontSize: '0.75rem',
                          borderRadius: '6px',
                          background: zoomMode === 'fit' ? '#eff6ff' : '#ffffff',
                          borderColor: zoomMode === 'fit' ? '#3b82f6' : '#cbd5e1',
                          color: zoomMode === 'fit' ? '#1d4ed8' : '#475569',
                          fontWeight: 600,
                        }}
                        onClick={() => setZoomMode('fit')}
                      >
                        📺 Fit to Panel
                      </button>
                      <button
                        className="btn-secondary"
                        style={{
                          padding: '0.25rem 0.65rem',
                          fontSize: '0.75rem',
                          borderRadius: '6px',
                          background: zoomMode === 'native' ? '#eff6ff' : '#ffffff',
                          borderColor: zoomMode === 'native' ? '#3b82f6' : '#cbd5e1',
                          color: zoomMode === 'native' ? '#1d4ed8' : '#475569',
                          fontWeight: 600,
                        }}
                        onClick={() => setZoomMode('native')}
                      >
                        🔍 100% Size
                      </button>
                    </div>
                  </div>
                  <div className="card-body" style={{ padding: zoomMode === 'native' ? 0 : '1.5rem' }}>
                    <div
                      className="screenshot-container"
                      style={
                        zoomMode === 'native'
                          ? { overflow: 'auto', maxHeight: '700px', minHeight: '400px', display: 'block', padding: '1rem', background: '#f1f5f9' }
                          : {}
                      }
                    >
                      {activePage.hasScreenshot ? (
                        <img
                          className="screenshot-img"
                          style={
                            zoomMode === 'native'
                              ? { width: 'auto', maxWidth: 'none', height: 'auto', display: 'block', margin: '0 auto', borderRadius: '8px', boxShadow: '0 10px 30px rgba(15,23,42,0.15)' }
                              : {}
                          }
                          src={`/api/screenshot/${activePage.slug}`}
                          alt={`Rendered screenshot of ${activePage.slug}`}
                        />
                      ) : (
                        <div className="no-screenshot">
                          <span style={{ fontSize: '2.5rem' }}>🖼️</span>
                          <p>No visual screenshot captured for this run.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* RIGHT COLUMN: Reviewer workspace & checklists */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
                  
                  {/* Approvals ledger control */}
                  <div className="card">
                    <div className="card-header">
                      <h3 className="card-title">🟢 Client & Visual Approvals</h3>
                    </div>
                    <div className="card-body">
                      <div className="approval-actions">
                        <button
                          className={`btn-choice smooth-all ${currentApproval.decision === 'apply' ? 'selected-apply' : ''}`}
                          onClick={() => handleDecisionToggle('apply')}
                        >
                          <span className="btn-choice-emoji">🟢</span>
                          <span className="btn-choice-title">Apply Rebuilds</span>
                          <span className="btn-choice-sub">Approve design changes and apply code upgrades.</span>
                        </button>

                        <button
                          className={`btn-choice smooth-all ${currentApproval.decision === 'skip' ? 'selected-skip' : ''}`}
                          onClick={() => handleDecisionToggle('skip')}
                        >
                          <span className="btn-choice-emoji">🟡</span>
                          <span className="btn-choice-title">Skip Rebuilds</span>
                          <span className="btn-choice-sub">Bypass coding, reviews, and git commits.</span>
                        </button>
                      </div>

                      {/* Review note textarea */}
                      <div className="form-group">
                        <label className="form-label">Review Overall Note (PM / Client instructions)</label>
                        <textarea
                          rows={3}
                          className="input-text"
                          placeholder="e.g. Approved button colors and slate tokens. Tweak title typography contrast."
                          value={currentApproval.note ?? ''}
                          onChange={(e) => setCurrentApproval({ ...currentApproval, note: e.target.value })}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Threaded collaborator comments */}
                  <div className="card">
                    <div className="card-header">
                      <h3 className="card-title">💬 Threaded Designer/PM Feedback</h3>
                    </div>
                    <div className="card-body">
                      <div className="comments-timeline">
                        {currentApproval.comments && currentApproval.comments.length > 0 ? (
                          currentApproval.comments.map((c, i) => (
                            <div key={i} className="comment-bubble">
                              <div className="comment-bubble-author">Collaborator</div>
                              <div className="comment-bubble-text">{c}</div>
                            </div>
                          ))
                        ) : (
                          <p style={{ color: '#94a3b8', fontSize: '0.85rem', fontStyle: 'italic', padding: '1rem 0' }}>
                            No feedback threads registered. Type below to kickstart one.
                          </p>
                        )}
                      </div>

                      <form onSubmit={handleAddComment} className="comments-input-row">
                        <input
                          type="text"
                          className="input-text"
                          placeholder="Add visual refinement instructions..."
                          value={newComment}
                          onChange={(e) => setNewComment(e.target.value)}
                        />
                        <button type="submit" className="input-btn">Send</button>
                      </form>
                    </div>
                  </div>

                </div>
              </div>

              {/* Gaps exclusion checklist */}
              {activePage.audit && activePage.audit.gaps.length > 0 && (
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">✅ Selective Gaps Checklist</h3>
                  </div>
                  <div className="card-body">
                    <div className="gaps-list">
                      {activePage.audit.gaps.map((gap) => {
                        const isSkipped = currentApproval.gaps?.[gap.id] === 'skip';

                        return (
                          <div key={gap.id} className="gap-item smooth-all">
                            <input
                              type="checkbox"
                              className="gap-checkbox"
                              checked={!isSkipped}
                              onChange={() => handleGapToggle(gap.id)}
                            />
                            <div className="gap-info">
                              <div className="gap-header-row">
                                <span className={`gap-tag gap-tag-${gap.severity}`}>{gap.severity}</span>
                                <span style={{ fontSize: '0.8rem', color: '#64748b', fontWeight: 600 }}>{gap.category}</span>
                              </div>
                              <p className="gap-desc">{gap.description}</p>
                              {gap.recommendation && (
                                <p className="gap-rec"><strong>Recommendation:</strong> {gap.recommendation}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Code Diffs Proposed changes */}
              {activePage.codeDiff && (
                <div className="card">
                  <div className="card-header">
                    <h3 className="card-title">📝 Proposed Architectural Diffs</h3>
                  </div>
                  <div className="card-body" style={{ padding: 0 }}>
                    <div className="diff-panel">
                      <div className="diff-header">
                        <span className="diff-title">Architectural verification proposal</span>
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
