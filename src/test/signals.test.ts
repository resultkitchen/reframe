/**
 * Signal-count confidence primitives — ADR-0001 slice 1.
 *
 * These tests pin the mechanical contract that every producer + consumer
 * codes against. If the thresholds shift (e.g. tier 2 starts at 3 signals
 * instead of 2), the change shows up here first.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  confidenceFromCount,
  confidenceFromSignals,
  KNOWN_SIGNALS,
  normaliseSignals,
  tierFor,
  type FindingSignal,
} from '../findings/signals';

describe('tierFor()', () => {
  it('zero signals → low', () => assert.equal(tierFor([]), 'low'));
  it('one signal  → low', () => assert.equal(tierFor(['severity-critical']), 'low'));
  it('two signals → medium', () =>
    assert.equal(tierFor(['severity-critical', 'browser-evidence']), 'medium'));
  it('three signals → high', () =>
    assert.equal(
      tierFor(['severity-critical', 'browser-evidence', 'broken-contract']),
      'high',
    ));
  it('five signals → high (no extra tier above)', () =>
    assert.equal(
      tierFor([
        'severity-critical',
        'browser-evidence',
        'broken-contract',
        'a11y-rule-violation',
        'cross-agent-agreement',
      ]),
      'high',
    ));
});

describe('confidenceFromSignals() back-fill', () => {
  it('zero signals → 0.35 (legacy default-low)', () =>
    assert.equal(confidenceFromSignals([]), 0.35));
  it('one signal → 0.5', () =>
    assert.equal(confidenceFromSignals(['severity-critical']), 0.5));
  it('two signals → 0.65 (medium)', () =>
    assert.equal(confidenceFromSignals(['severity-critical', 'browser-evidence']), 0.65));
  it('three signals → 0.9 (high)', () =>
    assert.equal(
      confidenceFromSignals([
        'severity-critical',
        'browser-evidence',
        'broken-contract',
      ]),
      0.9,
    ));
  it('five+ signals → 0.95 (saturates)', () =>
    assert.equal(
      confidenceFromSignals([
        'severity-critical',
        'browser-evidence',
        'broken-contract',
        'a11y-rule-violation',
        'cross-agent-agreement',
      ]),
      0.95,
    ));
});

describe('confidenceFromCount() matches confidenceFromSignals()', () => {
  // Sanity: the count-based helper agrees with the array-based one. Same
  // table, same buckets. Catches a future refactor that diverges them.
  for (let n = 0; n <= 6; n++) {
    it(`count=${n}`, () => {
      const signals = KNOWN_SIGNALS.slice(0, n) as FindingSignal[];
      assert.equal(confidenceFromCount(n), confidenceFromSignals(signals));
    });
  }
});

describe('normaliseSignals()', () => {
  it('returns [] for non-array input', () => {
    assert.deepEqual(normaliseSignals(undefined), []);
    assert.deepEqual(normaliseSignals(null as unknown as unknown[]), []);
    assert.deepEqual(normaliseSignals('not-an-array' as unknown as unknown[]), []);
  });

  it('drops unknown signal strings', () => {
    assert.deepEqual(
      normaliseSignals(['severity-critical', 'not-a-real-signal', 'browser-evidence']),
      ['severity-critical', 'browser-evidence'],
    );
  });

  it('drops non-string entries', () => {
    assert.deepEqual(
      normaliseSignals(['severity-critical', 42, null, 'browser-evidence']),
      ['severity-critical', 'browser-evidence'],
    );
  });

  it('de-duplicates while preserving order', () => {
    assert.deepEqual(
      normaliseSignals([
        'broken-contract',
        'severity-critical',
        'broken-contract', // dup
        'browser-evidence',
        'severity-critical', // dup
      ]),
      ['broken-contract', 'severity-critical', 'browser-evidence'],
    );
  });
});
