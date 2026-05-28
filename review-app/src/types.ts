/**
 * Shared types for the Reframe review SPA.
 *
 * Mirrors the engine's on-disk JSON shape. Do not add fields the engine doesn't
 * write — render-time defaults belong in components, not here.
 */

export type ConfidenceTier = 'low' | 'medium' | 'high';
export type TierFilter = 'all' | 'medium' | 'high';
export type Register = 'vibe' | 'technical';

export interface Gap {
  id: string;
  category: 'functional' | 'ux';
  severity: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  recommendation: string;
  plain?: string;
  whyItMatters?: string;
  confidence?: number;
  confidenceTier?: ConfidenceTier;
  signals?: string[];
  dimension?: string;
}

export interface Finding {
  ruleId: string;
  domain: string;
  severity: string;
  location: string;
  problem: string;
  requiredFix: string;
  plain?: string;
  whyItMatters?: string;
  confidence?: number;
  confidenceTier?: ConfidenceTier;
  signals?: string[];
  dimension?: string;
}

export interface PageHealth {
  healthy: boolean;
  status: string;
  detail: string;
}

export interface PageData {
  slug: string;
  route: string;
  hasScreenshot: boolean;
  hasHtml?: boolean;
  audit?: {
    gaps: Gap[];
    health?: PageHealth;
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

export interface PageApproval {
  decision: 'apply' | 'skip';
  gaps?: Record<string, 'apply' | 'skip'>;
  complianceFindings?: Record<string, 'apply' | 'skip'>;
  note?: string;
  comments?: string[];
}

export interface BrandTokens {
  name?: string;
  colors?: Record<string, string>;
  typeScale?: Record<string, string>;
  spacing?: Record<string, string>;
  radii?: Record<string, string>;
  voice?: string;
  componentStyle?: string;
  pinned?: boolean;
  fonts?: { heading?: string; body?: string };
}

export interface DataCall {
  page: string;
  kind: string;
  target: string;
  description?: string;
}

export interface BrokenContract {
  file?: string;
  line?: number;
  description?: string;
  page?: string;
  details?: string;
}

export interface ScopeData {
  productGoal?: string;
  brokenContracts?: BrokenContract[];
  dataCalls?: DataCall[];
  dbTables?: unknown[];
  bootstrappedBrand?: BrandTokens;
  pages?: Array<{ slug: string; route: string; purpose?: string; libraries?: string[]; role?: string }>;
}

export interface RunData {
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
  scope?: ScopeData;
  brand?: BrandTokens;
}

/** Tier helpers — same fallback the engine uses. */
const TIER_RANK: Record<ConfidenceTier, number> = { low: 1, medium: 2, high: 3 };

export function tierFor(f: { confidenceTier?: ConfidenceTier; confidence?: number }): ConfidenceTier {
  if (f.confidenceTier) return f.confidenceTier;
  const c = typeof f.confidence === 'number' ? f.confidence : 0.35;
  return c >= 0.85 ? 'high' : c >= 0.6 ? 'medium' : 'low';
}

export function passesTierFilter(
  f: { confidenceTier?: ConfidenceTier; confidence?: number },
  filter: TierFilter,
): boolean {
  if (filter === 'all') return true;
  return TIER_RANK[tierFor(f)] >= TIER_RANK[filter];
}

export const SIGNAL_LABELS: Record<string, string> = {
  'browser-evidence':         'browser evidence',
  'broken-contract':          'broken contract',
  'multi-persona-agreement':  'multi-persona',
  'severity-critical':        'severity',
  'persistent-across-runs':   'seen before',
  'cross-agent-agreement':    'cross-agent',
  'auth-or-billing-surface':  'risk surface',
  'a11y-rule-violation':      'a11y rule',
  'explicit-user-feedback':   'user feedback',
};

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};
