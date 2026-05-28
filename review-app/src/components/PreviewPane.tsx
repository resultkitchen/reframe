import { useState } from 'react';
import { useUi } from '../store';
import { t } from '../copy';
import type { PageData } from '../types';

interface Props {
  page: PageData;
  baseUrl?: string;
}

type Bp = 'mobile' | 'tablet' | 'desktop';

const FRAME_WIDTH: Record<Bp, number> = { mobile: 390, tablet: 820, desktop: 1280 };

/** Preview pane — Phone · Tablet · Desktop preset toggle, native-res PNG. */
export function PreviewPane({ page, baseUrl }: Props) {
  const { ui, dispatch } = useUi();
  const r = ui.register;
  const [bp, setBp] = useState<Bp>('desktop');

  // Treat the desktop screenshot as a usable fallback for the smaller
  // breakpoints when per-breakpoint captures weren't recorded — the user
  // still gets a sharp render, just not the actual mobile/tablet layout.
  // Previously these tabs sat in a permanently disabled state on runs
  // without breakpoint captures, which the dogfood (2026-05-28T22-03-35
  // g2) flagged as a high-severity dead control.
  const desktopShot = page.hasScreenshot || page.audit?.breakpointScreenshots?.desktop != null;
  const available: Record<Bp, boolean> = {
    mobile:  page.audit?.breakpointScreenshots?.mobile != null || desktopShot,
    tablet:  page.audit?.breakpointScreenshots?.tablet != null || desktopShot,
    desktop: desktopShot,
  };

  const src = `/api/screenshot/${encodeURIComponent(page.slug)}${bp === 'desktop' ? '' : `?breakpoint=${bp}`}`;
  const openUrl = baseUrl ? new URL(page.route || '/', baseUrl).toString() : null;

  const collapsed = ui.collapsed.preview;

  return (
    <section className={`rf-card rf-preview ${collapsed ? 'rf-collapsed' : ''}`}>
      <header className="rf-card-header">
        <button
          className="rf-card-toggle"
          aria-expanded={!collapsed}
          onClick={() => dispatch({ type: 'togglePanel', key: 'preview' })}
          type="button"
        >
          <span className="rf-card-toggle-icon" aria-hidden>{collapsed ? '▸' : '▾'}</span>
          <h2 className="rf-card-title">{t('preview.heading', r)}</h2>
        </button>
        <div className="rf-card-actions">
          <div className="rf-bp-toggle" role="tablist">
            {(['mobile', 'tablet', 'desktop'] as Bp[]).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={bp === k}
                className={`rf-bp ${bp === k ? 'on' : ''}`}
                onClick={() => setBp(k)}
                disabled={!available[k]}
                type="button"
              >
                {k === 'mobile' ? t('preview.phone', r) : k === 'tablet' ? t('preview.tablet', r) : t('preview.desktop', r)}
              </button>
            ))}
          </div>
          {openUrl && (
            <a className="rf-btn rf-btn-ghost rf-btn-sm" href={openUrl} target="_blank" rel="noopener noreferrer">
              {t('preview.openTab', r)} ↗
            </a>
          )}
        </div>
      </header>

      {!collapsed && (
        <div className="rf-preview-frame" style={{ ['--rf-frame-w' as string]: `${FRAME_WIDTH[bp]}px` }}>
          {page.hasScreenshot || page.audit?.breakpointScreenshots ? (
            <div className="rf-preview-scroll">
              <img src={src} alt={`${page.slug} (${bp})`} className="rf-preview-img" />
            </div>
          ) : (
            <p className="rf-empty">{t('preview.noShot', r)}</p>
          )}
        </div>
      )}
    </section>
  );
}
