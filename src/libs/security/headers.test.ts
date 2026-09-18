import { describe, expect, it } from 'vitest';
import { buildDenyFramingRouteHeaders } from './headers';

describe('buildDenyFramingRouteHeaders', () => {
  it('denies framing on every route', () => {
    const routes = buildDenyFramingRouteHeaders();
    expect(routes).toHaveLength(1);
    expect(routes[0].source).toBe('/(.*)');
    expect(routes[0].headers).toEqual([
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
      { key: 'X-Frame-Options', value: 'DENY' },
    ]);
  });
});
