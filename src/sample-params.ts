/**
 * A small deterministic helper for dynamic Next.js route segments.
 */

export const DEFAULT_SAMPLE_PARAM = '1';

/**
 * Returns true when the route contains a dynamic segment.
 */
export function isDynamicRoute(route: string): boolean {
  return route.includes('[');
}

/**
 * Replaces each dynamic segment with a concrete value.
 *   [param]         -> sampleParams[param] ?? DEFAULT_SAMPLE_PARAM
 *   [...param]      -> same lookup on 'param'
 *   [[...param]]    -> same lookup on 'param'
 * Non-dynamic segments are unchanged. Preserves the leading slash.
 */
export function resolveRoutePath(route: string, sampleParams: Record<string, string>): string {
  return route
    .split('/')
    .map((segment) => {
      if (segment.startsWith('[') && segment.endsWith(']')) {
        const content = segment.replace(/^\[+/, '').replace(/\]+$/, '');
        const paramName = content.startsWith('...') ? content.slice(3) : content;
        return sampleParams[paramName] ?? DEFAULT_SAMPLE_PARAM;
      }
      return segment;
    })
    .join('/');
}
