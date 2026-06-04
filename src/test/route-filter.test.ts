import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPagesByRoutes, routePatternMatches } from '../route-filter';
import type { PageScope } from '../types';

function page(route: string, slug: string): PageScope {
  return {
    slug,
    route,
    purpose: '',
    userFunction: '',
    filePath: `client/src/pages/${route.replace(/^\/+/, '') || 'index'}.tsx`,
    role: 'user',
    dataDependencies: [],
    libraries: [],
  };
}

test('routePatternMatches supports exact routes, slugs, and prefixes', () => {
  const reports = page('/reports/builder', 'reports-builder');

  assert.equal(routePatternMatches(reports, '/reports/builder'), true);
  assert.equal(routePatternMatches(reports, '/reports/builder?tab=brand'), true);
  assert.equal(routePatternMatches(reports, 'reports-builder'), true);
  assert.equal(routePatternMatches(reports, '/reports/*'), true);
  assert.equal(routePatternMatches(reports, '/google-ads/*'), false);
});

test('routePatternMatches resolves mapper-style camel routes to user-facing filters', () => {
  const builder = page('/ReportBuilder', 'report-builder');

  assert.equal(routePatternMatches(builder, '/reportbuilder'), true);
  assert.equal(routePatternMatches(builder, '/reports/builder'), true);
  assert.equal(routePatternMatches(builder, '/reports/*'), true);
  assert.equal(routePatternMatches(builder, 'report-builder'), true);
});

test('filterPagesByRoutes preserves order and filters to requested pages', () => {
  const pages = [
    page('/account', 'account'),
    page('/Reports', 'reports'),
    page('/ReportBuilder', 'report-builder'),
    page('/google-ads', 'google-ads'),
  ];

  const filtered = filterPagesByRoutes(pages, [
    '/reports/*',
    'google-ads',
  ]);

  assert.deepEqual(filtered.map(p => p.slug), [
    'reports',
    'report-builder',
    'google-ads',
  ]);
});
