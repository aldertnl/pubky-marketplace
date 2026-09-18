import { playwright } from '@vitest/browser-playwright';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Live CROSS-DEVICE PRIVATE WATCHLIST SYNC proof against the REAL staging
 * homeserver (ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy) reached
 * through the public pkarr relays — the exact topology of the deployed app.
 *
 * The journey: identity A watches a listing on "device 1", a wiped IndexedDB
 * plus fresh sign-ins simulate devices 2 and 3 (pull, unwatch-with-tombstone,
 * tombstone propagation), and identity B proves the homeserver refuses reads
 * and listings of A's `/priv/` document (the watchlist privacy boundary the
 * decision memo verified empirically).
 *
 * The staging homeserver requires single-use signup tokens, so this suite is
 * NOT a standing gate: it consumes the tokens you pass in. Generate tokens
 * from the staging admin endpoint (see docs/ecommerce/RUNNING.md — the admin
 * password is NOT committed anywhere in this repo), then:
 *
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_A=XXXX-XXXX-XXXX \
 *   MARKETPLACE_STAGING_SIGNUP_TOKEN_B=YYYY-YYYY-YYYY \
 *   npm run test:marketplace:watchlist
 *
 * If a run fails after signup succeeded (tokens consumed), re-run by signing
 * back in with the identity secrets the harness printed:
 *
 *   MARKETPLACE_STAGING_SECRET_A=<hex> MARKETPLACE_STAGING_SECRET_B=<hex> \
 *   npm run test:marketplace:watchlist
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  define: {
    // The Chromium page has no `process` global (Next.js normally injects it);
    // inline the env the imported app modules read at module scope. NODE_ENV
    // 'test' keeps the runtime config on its lenient parse, which resolves to
    // the canonical staging network defaults.
    'process.env': JSON.stringify({ NODE_ENV: 'test', NEXT_PUBLIC_APP_VERSION: '0.0.0-live' }),
    // Single-use credentials are injected at config-eval time (node side);
    // they never enter the committed source.
    __STAGING_SIGNUP_TOKEN_A__: JSON.stringify(process.env.MARKETPLACE_STAGING_SIGNUP_TOKEN_A ?? ''),
    __STAGING_SIGNUP_TOKEN_B__: JSON.stringify(process.env.MARKETPLACE_STAGING_SIGNUP_TOKEN_B ?? ''),
    __STAGING_SECRET_A__: JSON.stringify(process.env.MARKETPLACE_STAGING_SECRET_A ?? ''),
    __STAGING_SECRET_B__: JSON.stringify(process.env.MARKETPLACE_STAGING_SECRET_B ?? ''),
  },
  test: {
    name: 'marketplace-watchlist-staging-live',
    include: ['src/test/live/marketplace-watchlist-sync.live.browser.ts'],
    env: {
      NEXT_PUBLIC_APP_VERSION: '0.0.0-live',
    },
    testTimeout: 480_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
