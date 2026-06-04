import type { PageScope } from './types';

function normalizeRoute(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withoutQuery = trimmed.split(/[?#]/)[0] || '';
  const withSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  const normalized = withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
  return normalized.toLowerCase();
}

function normalizeSlug(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

function singularize(token: string): string {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

function tokenize(value: string): string[] {
  return value
    .trim()
    .split(/[?#]/)[0]
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize);
}

function tokensEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function tokensStartWith(tokens: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.every((token, index) => tokens[index] === token);
}

function pageTokens(page: PageScope): string[][] {
  return [
    tokenize(page.route),
    tokenize(page.slug),
    tokenize(page.filePath.replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? ''),
  ].filter(tokens => tokens.length > 0);
}

export function routePatternMatches(page: PageScope, pattern: string): boolean {
  const normalizedPattern = normalizeRoute(pattern);
  if (!normalizedPattern) return false;

  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2);
    const route = normalizeRoute(page.route);
    const prefixTokens = tokenize(prefix);
    return (
      route === prefix ||
      route.startsWith(`${prefix}/`) ||
      pageTokens(page).some(tokens => tokensStartWith(tokens, prefixTokens))
    );
  }

  if (normalizeRoute(page.route) === normalizedPattern) return true;
  if (normalizeSlug(page.slug) === normalizeSlug(pattern)) return true;

  const patternTokens = tokenize(pattern);
  return pageTokens(page).some(tokens => tokensEqual(tokens, patternTokens));
}

export function filterPagesByRoutes(
  pages: PageScope[],
  routePatterns?: string[],
): PageScope[] {
  const patterns = (routePatterns ?? [])
    .map(pattern => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) return pages;
  return pages.filter(page =>
    patterns.some(pattern => routePatternMatches(page, pattern)),
  );
}
