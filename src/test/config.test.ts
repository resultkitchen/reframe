import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../config';

test('resolveConfig parses route filters from --routes', async () => {
  const config = await resolveConfig([
    'rebuild',
    '.',
    '--routes',
    '/reports,/reports/builder,google-ads',
    '--apply-mode',
    'review',
  ]);

  assert.deepEqual(config.routePatterns, [
    '/reports',
    '/reports/builder',
    'google-ads',
  ]);
});
