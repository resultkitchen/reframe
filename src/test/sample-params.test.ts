import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoutePath, isDynamicRoute, DEFAULT_SAMPLE_PARAM } from '../sample-params';

test('isDynamicRoute', () => {
  assert.equal(isDynamicRoute('/x/[id]'), true, 'Should detect dynamic route');
  assert.equal(isDynamicRoute('/x/y'), false, 'Should detect static route');
});

test('resolveRoutePath', () => {
  // a static route returned unchanged
  assert.equal(resolveRoutePath('/about', {}), '/about');
  
  // '/leads/[id]' with { id: '7' } -> '/leads/7'
  assert.equal(resolveRoutePath('/leads/[id]', { id: '7' }), '/leads/7');
  
  // a missing param falls back to DEFAULT_SAMPLE_PARAM
  assert.equal(resolveRoutePath('/users/[userId]', {}), `/users/${DEFAULT_SAMPLE_PARAM}`);
  
  // a catch-all '/docs/[...slug]' resolves
  assert.equal(resolveRoutePath('/docs/[...slug]', { slug: 'getting-started' }), '/docs/getting-started');
});
