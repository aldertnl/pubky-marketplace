import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { playwright } from '@vitest/browser-playwright';
import { VRT_VIEWPORT_DESKTOP } from './src/test-utils/vrt.viewports';

// Tests that import the paykit-wasm / locks-sdk-wasm bindings must exercise
// the VENDORED artifacts in this repository, not whatever a shared/linked
// node_modules happens to point at (e.g. worktrees sharing a sibling
// checkout's node_modules, where the file: symlink resolves to the sibling's
// vendor directory). These aliases are INTENTIONALLY PERMANENT, not a
// worktree-local workaround: in a normal checkout they are a no-op (the file:
// dependency links node_modules to this same vendored path), while in
// shared-node_modules worktrees they pin tests to THIS repo's artifacts.
// Vitest projects do NOT inherit top-level resolve, so each project applies
// them via `paykitWasmAlias`.
const paykitWasmAlias = {
  'paykit-wasm': fileURLToPath(new URL('./vendor/paykit-wasm/paykit_wasm.js', import.meta.url)),
  'locks-sdk-wasm': fileURLToPath(new URL('./vendor/locks-sdk-wasm/locks_sdk_wasm.js', import.meta.url)),
};
const assetIncludes = ['**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.otf'];
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const nodeModulesRoot = realpathSync(new URL('./node_modules', import.meta.url));
const fontAssetPattern = /\.(woff2?|ttf|otf)(?:\?.*)?$/;

function fontUrlImportPlugin(): PluginOption {
  return {
    name: 'font-url-import',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!fontAssetPattern.test(url) || !url.includes('import') || !url.includes('url')) {
          next();
          return;
        }

        const [servedPath] = url.split('?');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`export default ${JSON.stringify(servedPath)};`);
      });
    },
    load(id) {
      if (!fontAssetPattern.test(id) || !id.includes('url')) return null;

      const [filePath] = id.split('?');
      const fsPath = filePath.startsWith('/@fs/') ? filePath.slice('/@fs'.length) : filePath;
      const servedPath = `/@fs/${fsPath.replace(/^\/+/, '')}`;

      return `export default ${JSON.stringify(servedPath)};`;
    },
  };
}

export default defineConfig({
  plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
  assetsInclude: assetIncludes,
  resolve: {
    // Force a single copy of these packages so we never load two versions at once.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [repoRoot, nodeModulesRoot],
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportOnFailure: true,
    },
    snapshotFormat: {
      escapeString: true,
      printBasicPrototype: false,
    },
    resolveSnapshotPath: (testPath, snapExtension) => testPath + snapExtension,
    onConsoleLog(log) {
      if (
        log.includes('WebAssembly.instantiateStreaming') ||
        log.includes('application/wasm') ||
        log.includes('MIME type')
      ) {
        return false;
      }
      if (log.includes('Not implemented: navigation')) {
        return false;
      }
      return true;
    },
    dangerouslyIgnoreUnhandledErrors: false,
    silent: false,
    projects: [
      // Unit tests run in jsdom.
      {
        plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
        assetsInclude: assetIncludes,
        resolve: { alias: paykitWasmAlias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./src/config/test.ts'],
          globals: true,
          include: ['**/*.test.{ts,tsx}'],
          // .claude excludes local tooling worktrees checked out inside the repo.
          // ._* excludes macOS AppleDouble resource-fork files on external drives.
          exclude: ['**/node_modules/**', '**/.claude/**', '**/*.vrt.test.{ts,tsx}', '**/._*'],
          server: { deps: { inline: ['react-tweet'] } },
        },
      },
      // VRT(Visual Regression Tests) run in real browsers via Playwright.
      {
        plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
        assetsInclude: assetIncludes,
        optimizeDeps: {
          include: [
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'next/font/google',
            '@noble/hashes/blake3.js',
            '@noble/hashes/utils.js',
          ],
        },
        resolve: { alias: paykitWasmAlias },
        test: {
          name: 'vrt',
          globals: true,
          testTimeout: 30_000,
          include: ['**/*.vrt.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/.claude/**', '**/._*'],
          setupFiles: ['./src/test-utils/vrt.setup.ts'],
          server: { deps: { inline: ['react-tweet'] } },
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // Shared by comparison (`npm run test:vrt`) and regeneration
            // (`--update`). 0.001 (0.1%) hid a user-visible marketplace
            // badge rewrite ("Local pickup" → "Shipping") on 1440×900
            // desktop captures (~1.3M px → 1,296 allowed mismatches).
            // The more restrictive of pixels and ratio wins. 80 px is
            // enough for residual AA/font raster noise; a one-word label
            // change is hundreds of pixels and must fail. Scenes that
            // genuinely need more slack pass `comparatorOptions` on that
            // `toMatchScreenshot` call only.
            expect: {
              toMatchScreenshot: {
                comparatorName: 'pixelmatch',
                comparatorOptions: {
                  allowedMismatchedPixels: 80,
                  allowedMismatchedPixelRatio: 0.00005,
                },
                // Image-heavy suites (Home, Collections) on WebKit/Linux need
                // extra headroom for layout to settle after fonts/images decode.
                timeout: 15_000,
              },
            },
            // `viewport` below is the INITIAL browser size only. Each test
            // resizes the page per-call via `page.viewport(w, h)` inside
            // `renderForVRT` (see `src/test-utils/vrt.tsx`), so mobile
            // (VRT_VIEWPORT_MOBILE) is driven by the test, not by this
            // config. Add new sizes to `src/test-utils/vrt.viewports.ts`.
            instances: [
              {
                browser: 'chromium',
                viewport: VRT_VIEWPORT_DESKTOP,
              },
              {
                browser: 'firefox',
                viewport: VRT_VIEWPORT_DESKTOP,
              },
              {
                // `webkit` covers Safari's rendering engine.
                browser: 'webkit',
                viewport: VRT_VIEWPORT_DESKTOP,
              },
            ],
          },
        },
      },
    ],
  },
});
