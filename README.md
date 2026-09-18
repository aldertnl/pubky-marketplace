# Marketplace frontend redesign

Based on https://github.com/BitcoinErrorLog/pubky-app at commit 1a58ea46f38b6af118b54269261fb5b713795f12. Original license retained in LICENSE.

This snapshot contains the marketplace redesign, application code, assets, dependencies and tests. It excludes planning documents, screenshots, local credentials and Git history.

## Run locally

Use Node.js 24. Run `npm ci`, copy `.env.example` to `.env.local`, and configure the public runtime settings described there. Set `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=sandbox` for demo listings. Run `npm run dev:webpack`.

The sandbox transaction backend runs separately with `npm run marketplace:dev`. The frontend preview alone does not provide checkout or bidding.

## Scope

Marketplace browsing, card design, filters, display currency and responsive navigation. Other marketplace pages receive shared width and navigation adjustments.
