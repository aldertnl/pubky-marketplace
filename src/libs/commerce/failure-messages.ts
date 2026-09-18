import { isAppError } from '@/libs/error/error';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory } from '@/libs/error/error.types';

/** Client-owned copy for marketplace command and service failures. */
export const MARKETPLACE_FAILURE_MESSAGES = {
  offer: 'Could not update this offer.',
  offerChanged: 'This offer changed since you loaded it. The latest state was reloaded — retry from there.',
  sendOffer: 'Could not send this offer.',
  counterOffer: 'Could not send this counteroffer.',
  bid: 'Could not place this bid.',
  message: 'Could not send this message.',
  notifications: 'Could not update commerce notifications.',
  order: 'Could not update this order.',
  orderChanged: 'This order changed since you loaded it. The latest state was reloaded — retry from there.',
  paymentChanged: 'This payment changed since you loaded it. The latest state was reloaded — retry from there.',
  checkout: 'Checkout could not be completed.',
  claim: 'The claim could not be submitted. Check your connection and try again.',
  claimAddress: 'Save a delivery address first — the claim sends it with the checkout.',
  claimListingUnavailable: 'This listing could not be prepared for checkout. It may have been removed by the seller.',
  claimRefusal: 'The claim could not be completed.',
  drop: 'The transaction service could not be reached.',
  dropRefusal: 'The drop action could not be completed.',
  locksPayment: 'The payment request could not be created. Nothing was charged; you can retry.',
  session: 'Your marketplace session expired. Reconnect and try again.',
  sessionTimeout: 'The approval expired before it was completed. Try again.',
  sessionStart: 'Could not start the marketplace session.',
  soldOut: 'This drop is sold out.',
  dropNotStarted: "This drop hasn't started yet.",
  dropEnded: 'This drop has ended.',
  dropPerBuyerLimit: "You've reached the per-buyer limit for this drop.",
  shippingRates: 'Shipping rates are unavailable.',
  shippingLabel: 'The shipping label could not be purchased.',
  paymentSettings: 'Payment settings are unavailable.',
  bitcoinOfferUnavailable: 'Bitcoin is temporarily unavailable. Other payment methods are unaffected.',
  stripeKeyRemoval: 'The Stripe key could not be removed.',
  messagingStart: 'Could not start marketplace messaging.',
  messagingStorage: 'Messaging paused: storage protection unavailable',
  sandboxPayment: 'Could not advance the sandbox payment.',
  offersUnavailable: 'Marketplace offers are unavailable.',
  notificationsUnavailable: 'Commerce notifications are unavailable.',
  notificationsReadUnavailable: 'The durable marketplace service does not store read state yet.',
  notificationsReadFailed: 'Could not mark commerce notifications read.',
  notificationPreferencesUnavailable: 'The durable marketplace service does not store notification preferences yet.',
  notificationPreferencesFailed: 'Could not update commerce notification preferences.',
  ordersUnavailable: 'Marketplace orders are unavailable.',
  unavailable: 'The marketplace service is temporarily unavailable.',
  shopSettings: 'Could not save shop settings.',
  savedSearch: 'Could not save this search.',
  savedSearchDelete: 'Could not delete this saved search.',
  shippingSettings: 'The shipping settings could not be saved.',
  watchOnlyClaimInvalid: 'That does not look like an account xpub. Export the BIP84 account key from your wallet.',
  watchOnlyClaimStart: 'The watch-only claim could not be started.',
  watchOnlyClaimComplete: 'The watch-only claim could not be completed.',
  paymentSettingsSave: 'The payment settings could not be saved.',
} as const;

type MarketplaceFailureCode = string | null | undefined;

const CODE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['INSUFFICIENT_INVENTORY', MARKETPLACE_FAILURE_MESSAGES.soldOut],
  ['INVALID_RESPONSE', MARKETPLACE_FAILURE_MESSAGES.unavailable],
  ['SESSION_EXPIRED', MARKETPLACE_FAILURE_MESSAGES.session],
  ['UNAUTHORIZED', MARKETPLACE_FAILURE_MESSAGES.session],
]);

const DROP_REFUSAL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['INVALID_STATE:The drop has not started.', MARKETPLACE_FAILURE_MESSAGES.dropNotStarted],
  ['INVALID_STATE:The drop has ended.', MARKETPLACE_FAILURE_MESSAGES.dropEnded],
  ['INSUFFICIENT_INVENTORY:The drop is sold out.', MARKETPLACE_FAILURE_MESSAGES.soldOut],
  ["INVALID_STATE:You have reached this drop's per-buyer limit.", MARKETPLACE_FAILURE_MESSAGES.dropPerBuyerLimit],
]);

export function marketplaceDropRefusalMessage(code: MarketplaceFailureCode, message: unknown): string | null {
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return DROP_REFUSAL_MESSAGES.get(`${code}:${message}`) ?? null;
}

export function marketplaceFailureMessage(code: MarketplaceFailureCode, fallback: string, error?: unknown): string {
  if (
    isAppError(error) &&
    error.category === ErrorCategory.Validation &&
    Object.values(ValidationErrorCode).includes(error.code as ValidationErrorCode)
  ) {
    return error.message;
  }
  return (code && CODE_MESSAGES.get(code)) || fallback;
}

export function marketplaceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
