import { Env } from '@/libs/env/env';
import { getSingleApprovalSignIn } from '@/libs/runtime-config/runtime-config';

export const APP_VERSION = Env.NEXT_PUBLIC_APP_VERSION;

/**
 * The single sign-in grant. One Ring approval covers everything the app does,
 * on purpose: the homeserver keeps ONE session cookie per user per origin, so
 * splitting capabilities across separate approvals means each new approval
 * clobbers the previous session (this broke all pubky.app writes when the
 * paykit-only messaging grant landed — see `messaging-contracts.ts`).
 * Scopes: the app's own tree, the Paykit tree (encrypted messaging), and the
 * app's private tree (cross-device watchlist sync — `/priv/` is enforced
 * private by the homeserver, verified empirically in
 * `docs/ecommerce/watchlist.md`).
 *
 * This exact string is what the signer (Pubky Ring) displays at approval
 * time, so the step-up re-approval dialog renders it verbatim beside the QR
 * for comparison (docs/ecommerce/step-up-approval.md, QR/phish-swap row).
 */
export const CAPABILITIES = '/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw';

/**
 * Interim dual-POST ceremony (docs/ecommerce/single-approval.md). Runtime
 * flag (`PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN`, default on): `false`
 * restores `awaitApproval()` sign-in plus empty-capability marketplace
 * connect. Read at call time so a deploy can roll back without a rebuild.
 * Do not roll back by POSTing empty capabilities to `/session`.
 */
export function isSingleApprovalSignInEnabled(): boolean {
  return getSingleApprovalSignIn();
}

/** Order-insensitive set equality with {@link CAPABILITIES} split on commas. */
export function capabilitiesMatchFullGrant(capabilities: readonly string[]): boolean {
  const expected = CAPABILITIES.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const incoming = [...new Set(capabilities.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
  if (incoming.length !== expected.length) return false;
  const incomingSet = new Set(incoming);
  return expected.every((entry) => incomingSet.has(entry));
}
