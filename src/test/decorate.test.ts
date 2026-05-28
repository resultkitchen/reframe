/**
 * Decorator tests — ADR-0001 slice 2.
 *
 * Locks down the four mechanical signals (severity-critical, browser-evidence,
 * broken-contract, cross-agent-agreement) plus the back-fill rules. These
 * tests intentionally use minimal fixtures so the contract is readable —
 * production AuditResult / ComplianceResult shapes carry many more fields
 * that don't influence decoration.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { decorateAllFindings } from '../findings/decorate';
import type {
  AuditResult,
  BrokenContract,
  ComplianceResult,
  Gap,
  PageScope,
} from '../types';

const page: PageScope = {
  slug: 'intake',
  route: '/intake/new',
  filePath: 'app/intake/new/page.tsx',
  purpose: 'Patient signs up.',
  userFunction: 'Submit contact info.',
  dataDependencies: [],
  libraries: ['react', 'react-hook-form', 'tailwind'],
};

function gap(overrides: Partial<Gap>): Gap {
  return {
    id: overrides.id ?? 'g1',
    category: overrides.category ?? 'ux',
    severity: overrides.severity ?? 'medium',
    description: overrides.description ?? 'gap',
    recommendation: overrides.recommendation ?? 'fix it',
    ...overrides,
  };
}

function audit(gaps: Gap[], consoleErrors: string[] = []): AuditResult {
  return {
    page: page.route,
    consoleErrors,
    interactionsExercised: [],
    gaps,
  };
}

function compliance(findings: ComplianceResult['findings']): ComplianceResult {
  return { page: page.route, findings, clean: false };
}

describe('severity-critical signal', () => {
  it('fires for severity=critical', () => {
    const a = audit([gap({ severity: 'critical' })]);
    decorateAllFindings(page, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('severity-critical'));
  });

  it('fires for severity=high', () => {
    const a = audit([gap({ severity: 'high' })]);
    decorateAllFindings(page, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('severity-critical'));
  });

  it('does not fire for severity=medium', () => {
    const a = audit([gap({ severity: 'medium' })]);
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].signals?.includes('severity-critical'), false);
  });

  it('does not fire for severity=low', () => {
    const a = audit([gap({ severity: 'low' })]);
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].signals?.includes('severity-critical'), false);
  });
});

describe('browser-evidence signal', () => {
  it('fires when consoleErrors carry a [pageerror] and gap is functional', () => {
    const a = audit(
      [gap({ category: 'functional' })],
      ['[pageerror] TypeError: handleSubmit is not a function'],
    );
    decorateAllFindings(page, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('browser-evidence'));
  });

  it('fires when consoleErrors carry a 5xx response', () => {
    const a = audit(
      [gap({ category: 'functional' })],
      ['[console.error] Failed to load resource: the server responded with a status of 503 ()'],
    );
    decorateAllFindings(page, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('browser-evidence'));
  });

  it('does NOT fire for ux-category gaps even when browser noise is present', () => {
    // Browser noise from analytics pixels shouldn't borrow trust for
    // a UX-only finding. Keeps the signal honest.
    const a = audit(
      [gap({ category: 'ux' })],
      ['[pageerror] TypeError: window.gtag is undefined'],
    );
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].signals?.includes('browser-evidence'), false);
  });

  it('does not fire on 4xx responses', () => {
    // 404 from a missing analytics image must not turn every audit into HIGH.
    const a = audit(
      [gap({ category: 'functional' })],
      ['[console.error] Failed to load resource: the server responded with a status of 404 ()'],
    );
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].signals?.includes('browser-evidence'), false);
  });
});

describe('broken-contract signal', () => {
  it('fires when a BrokenContract location string-matches the page file', () => {
    const a = audit([gap({ severity: 'high' })]);
    const bc: BrokenContract = {
      kind: 'missing-column',
      location: 'app/intake/new/page.tsx:42',
      detail: 'column patients.phone_number missing',
      severity: 'high',
    };
    decorateAllFindings(page, a, undefined, [bc]);
    assert.ok(a.gaps[0].signals?.includes('broken-contract'));
  });

  it('matches partial paths in either direction', () => {
    const a = audit([gap({})]);
    const bc: BrokenContract = {
      kind: 'dead-path',
      location: 'intake/new/page.tsx:10',  // shorter than page.filePath
      detail: 'unreachable branch',
      severity: 'medium',
    };
    decorateAllFindings(page, a, undefined, [bc]);
    assert.ok(a.gaps[0].signals?.includes('broken-contract'));
  });

  it('does not fire for unrelated contract locations', () => {
    const a = audit([gap({})]);
    const bc: BrokenContract = {
      kind: 'missing-table',
      location: 'app/admin/page.tsx:1',
      detail: 'admin_settings missing',
      severity: 'high',
    };
    decorateAllFindings(page, a, undefined, [bc]);
    assert.equal(a.gaps[0].signals?.includes('broken-contract'), false);
  });
});

describe('cross-agent-agreement signal', () => {
  it('fires when audit and compliance both touch the same file', () => {
    const a = audit([
      gap({ id: 'g1', evidence: ['app/intake/new/page.tsx:42 — handleSubmit undefined'] }),
    ]);
    const c = compliance([
      {
        ruleId: 'tcpa-001',
        domain: 'TCPA',
        severity: 'high',
        location: 'app/intake/new/page.tsx:55',
        problem: 'missing consent checkbox',
        requiredFix: 'add a TCPA consent checkbox before submission',
      },
    ]);
    decorateAllFindings(page, a, c, []);
    // The compliance finding sees the audit's evidence file → cross-agent.
    assert.ok(c.findings[0].signals?.includes('cross-agent-agreement'));
    // And vice-versa: the audit gap sees the compliance finding's location.
    assert.ok(a.gaps[0].signals?.includes('cross-agent-agreement'));
  });

  it('does NOT fire when audit and compliance touch different files', () => {
    const a = audit([gap({ id: 'g1', evidence: ['app/intake/new/page.tsx:42'] })]);
    const c = compliance([
      {
        ruleId: 'tcpa-001',
        domain: 'TCPA',
        severity: 'high',
        location: 'app/footer/page.tsx:10',
        problem: 'missing privacy link',
        requiredFix: 'link to privacy policy',
      },
    ]);
    decorateAllFindings(page, a, c, []);
    assert.equal(a.gaps[0].signals?.includes('cross-agent-agreement'), false);
    assert.equal(c.findings[0].signals?.includes('cross-agent-agreement'), false);
  });
});

describe('confidenceTier derivation + back-fill', () => {
  it('zero signals → tier low, confidence 0.35', () => {
    const a = audit([gap({ severity: 'medium' })]);
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].confidenceTier, 'low');
    assert.equal(a.gaps[0].confidence, 0.35);
  });

  it('two mechanical signals → tier medium', () => {
    const a = audit(
      [gap({ severity: 'critical', category: 'functional' })],
      ['[pageerror] boom'],
    );
    decorateAllFindings(page, a, undefined, []);
    // severity-critical + browser-evidence = 2 signals
    assert.equal(a.gaps[0].confidenceTier, 'medium');
    assert.equal(a.gaps[0].confidence, 0.65);
  });

  it('three mechanical signals → tier high', () => {
    const a = audit(
      [
        gap({
          severity: 'critical',
          category: 'functional',
          evidence: ['app/intake/new/page.tsx:42'],
        }),
      ],
      ['[pageerror] boom'],
    );
    const c = compliance([
      {
        ruleId: 'tcpa-001',
        domain: 'TCPA',
        severity: 'high',
        location: 'app/intake/new/page.tsx:55',
        problem: 'p',
        requiredFix: 'f',
      },
    ]);
    decorateAllFindings(page, a, c, []);
    // severity-critical + browser-evidence + cross-agent-agreement = 3
    assert.equal(a.gaps[0].confidenceTier, 'high');
    assert.equal(a.gaps[0].confidence, 0.9);
  });

  it('respects an existing numeric confidence the agent already supplied', () => {
    // If the LLM was calibrated and returned 0.42, don't overwrite. Only
    // the tier is mechanically derived; the legacy float is the agent's
    // territory for one release.
    const a = audit([{ ...gap({ severity: 'medium' }), confidence: 0.42 }]);
    decorateAllFindings(page, a, undefined, []);
    assert.equal(a.gaps[0].confidence, 0.42);
    assert.equal(a.gaps[0].confidenceTier, 'low');
  });
});

describe('a11y-rule-violation signal (slice 5)', () => {
  it('fires for an accessibility gap whose text matches a WCAG rule', () => {
    const a = audit([gap({
      dimension: 'accessibility',
      severity: 'high',
      description: 'Search input has no associated label.',
      recommendation: 'Add aria-label="Search active leads".',
    })]);
    decorateAllFindings(page, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('a11y-rule-violation'));
  });

  it('does NOT fire for a non-accessibility gap, even if text matches', () => {
    // brand-voice gap that incidentally mentions "label" should not borrow
    // accessibility trust.
    const a = audit([gap({
      dimension: 'brand-voice',
      severity: 'high',
      description: 'Headline label feels off-brand.',
    })]);
    decorateAllFindings(page, a, undefined, []);
    assert.ok(!a.gaps[0].signals?.includes('a11y-rule-violation'));
  });

  it('does NOT fire for an accessibility gap whose text matches nothing', () => {
    const a = audit([gap({
      dimension: 'accessibility',
      severity: 'medium',
      description: 'Some vague accessibility concern with no WCAG hint.',
    })]);
    decorateAllFindings(page, a, undefined, []);
    assert.ok(!a.gaps[0].signals?.includes('a11y-rule-violation'));
  });

  it('combined with severity-critical lifts an a11y finding to MEDIUM', () => {
    const a = audit([gap({
      dimension: 'accessibility',
      severity: 'high',
      description: 'Icon-only button has no accessible name.',
    })]);
    decorateAllFindings(page, a, undefined, []);
    assert.deepEqual(
      [...(a.gaps[0].signals ?? [])].sort(),
      ['a11y-rule-violation', 'severity-critical'],
    );
    assert.equal(a.gaps[0].confidenceTier, 'medium');
  });
});

describe('auth-or-billing-surface signal (slice 6)', () => {
  const authPage: PageScope = { ...page, filePath: 'app/auth/login/page.tsx', route: '/auth/login' };
  const billingPage: PageScope = { ...page, filePath: 'app/billing/page.tsx', route: '/billing' };
  const checkoutPage: PageScope = { ...page, filePath: 'app/checkout/page.tsx', route: '/checkout' };

  it('fires for an auth/login page on every gap', () => {
    const a = audit([gap({ severity: 'medium' })]);
    decorateAllFindings(authPage, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('auth-or-billing-surface'));
  });

  it('fires for a /billing page', () => {
    const a = audit([gap({ severity: 'low' })]);
    decorateAllFindings(billingPage, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('auth-or-billing-surface'));
  });

  it('fires for /checkout', () => {
    const a = audit([gap({ severity: 'low' })]);
    decorateAllFindings(checkoutPage, a, undefined, []);
    assert.ok(a.gaps[0].signals?.includes('auth-or-billing-surface'));
  });

  it('does NOT fire for an unrelated page', () => {
    const a = audit([gap({ severity: 'medium' })]);
    decorateAllFindings(page, a, undefined, []); // intake page
    assert.ok(!a.gaps[0].signals?.includes('auth-or-billing-surface'));
  });

  it('fires on a compliance finding when finding.location is on a risk surface', () => {
    const c = compliance([{
      ruleId: 'rule-x', domain: 'TCPA', severity: 'high',
      location: 'app/billing/page.tsx:42',
      problem: 'p', requiredFix: 'r',
    }]);
    decorateAllFindings(page, undefined, c, []); // page itself not risky
    assert.ok(c.findings[0].signals?.includes('auth-or-billing-surface'));
  });

  it('combined with severity-critical lifts an auth-surface gap to MEDIUM', () => {
    const a = audit([gap({ severity: 'high', description: 'login form misaligned' })]);
    decorateAllFindings(authPage, a, undefined, []);
    assert.equal(a.gaps[0].confidenceTier, 'medium');
  });
});

describe('decoration is idempotent', () => {
  it('running twice produces the same signals (de-duped)', () => {
    const a = audit(
      [gap({ severity: 'critical', category: 'functional' })],
      ['[pageerror] x'],
    );
    decorateAllFindings(page, a, undefined, []);
    const firstPass = [...(a.gaps[0].signals ?? [])];
    decorateAllFindings(page, a, undefined, []);
    assert.deepEqual(a.gaps[0].signals, firstPass);
  });
});
