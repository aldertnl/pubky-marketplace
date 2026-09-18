/**
 * Clickjacking defence for the Shop deployment.
 *
 * Shop only ever EMBEDS pubky.app's `/session-bridge` (see
 * `src/libs/vibe-session/bridge.ts`); nothing legitimate embeds Shop itself,
 * so every route denies framing. `frame-ancestors 'none'` is the modern CSP
 * directive; `X-Frame-Options: DENY` covers browsers without CSP level 2.
 * Keeping the policy in a pure builder lets the unit test assert the exact
 * header set without booting Next (same pattern as upstream's
 * `buildSessionBridgeRouteHeaders`).
 */
export function buildDenyFramingRouteHeaders() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    },
  ];
}
