import { afterEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { CommerceApplication } from './commerce';

// A REAL receipt attestation issued by the transaction service's Rust
// attestor (test keypair) and cross-verified against the specs fork's
// verifier — the same artifact the wire delivers. Tampering with any claim
// or the signature must fail the offline recipe.
const BUYER = 'operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo';
const SELLER = 'pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy';
const ORDER_ID = '018f47d2-6a27-7c23-a49d-6b21bb770200';
const RECEIPT_ID = '018f47d2-6a27-7c23-a49d-6b21bb770201';
const RECEIPT_URL = `pubky://${BUYER}/priv/pubky.app/marketplace/v1/receipts/${RECEIPT_ID}`;
const JWS =
  'eyJhbGciOiJFZERTQSIsInR5cCI6InB1Ymt5LW9yZGVyLXJlY2VpcHQrdjEifQ.eyJ2IjoxLCJpc3MiOiI3amZnYWE5bnV0anlpeHppa2I3dGdtc2Y5Z2t3cTdpcXo0OTh6cjFuZDVpZzFmbmc0ZXN5IiwiYnV5ZXIiOiJvcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvIiwic2VsbGVyIjoicHhudTMzeDdqdHB4OWFyMXl0c2k0eXhicDZhNW8zNmd3aGZmczh6b3htYnVwdGljaTFqeSIsIm9yZGVyIjoiMDE4ZjQ3ZDItNmEyNy03YzIzLWE0OWQtNmIyMWJiNzcwMjAwIiwicmVjZWlwdCI6IjAxOGY0N2QyLTZhMjctN2MyMy1hNDlkLTZiMjFiYjc3MDIwMSIsInRvdGFsX21pbm9yIjoxNDc5NiwiY3VycmVuY3kiOiJVU0QiLCJleHBvbmVudCI6MiwicGFpZF9hdCI6IjIwMjYtMDgtMTlUMjI6MDA6MDAuMDAwWiIsImlhdCI6MTc4NzE3NjgwMH0.2zDQZwDYjVsxfppJMZanH9WR04bW8IkqbwHvVY49a72SFqpLDnZN_YYeYHYex5mujtXMp6fLwqhzG8vMZRMFAA';

const attestation = () => ({
  jws: JWS,
  claims: {
    v: 1 as const,
    iss: '7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy',
    buyer: BUYER,
    seller: SELLER,
    order: ORDER_ID,
    receipt: RECEIPT_ID,
    totalMinor: 14796,
    currency: 'USD',
    exponent: 2,
    paidAt: '2026-08-19T22:00:00.000Z',
    iat: 1787176800,
  },
});

// A REAL pubky-drop-edition+v1 JWS from the same attestor, bound to the
// receipt above ("edition 7 of 100" of drop_summer_01) and cross-verified
// against the specs verifier.
const EDITION_JWS =
  'eyJhbGciOiJFZERTQSIsInR5cCI6InB1Ymt5LWRyb3AtZWRpdGlvbit2MSJ9.eyJ2IjoxLCJpc3MiOiI3amZnYWE5bnV0anlpeHppa2I3dGdtc2Y5Z2t3cTdpcXo0OTh6cjFuZDVpZzFmbmc0ZXN5IiwiYnV5ZXIiOiJvcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvIiwic2VsbGVyIjoicHhudTMzeDdqdHB4OWFyMXl0c2k0eXhicDZhNW8zNmd3aGZmczh6b3htYnVwdGljaTFqeSIsImRyb3AiOiJkcm9wX3N1bW1lcl8wMSIsImVkaXRpb24iOjcsIm9mIjoxMDAsInJlY2VpcHQiOiIwMThmNDdkMi02YTI3LTdjMjMtYTQ5ZC02YjIxYmI3NzAyMDEiLCJpYXQiOjE3ODcxNzY4MDB9.HUaDMmkkFaAmGR_MdXB7O_kewj5ruU7sYOh8JKHqTWFWhdpHeLxxk9I8s3IDhGkI-FxAecU0e704UPYuS8brAQ';

const editionAttestation = () => ({
  jws: EDITION_JWS,
  claims: {
    v: 1 as const,
    iss: '7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy',
    buyer: BUYER,
    seller: SELLER,
    drop: 'drop_summer_01',
    edition: 7,
    of: 100,
    receipt: RECEIPT_ID,
    iat: 1787176800,
  },
});

const paidOrder = (receiptId: string = RECEIPT_ID) => ({ receiptId, buyerPubky: BUYER, sellerPubky: SELLER }) as never;

const paidDropOrder = (receiptId: string = RECEIPT_ID) =>
  ({
    receiptId,
    buyerPubky: BUYER,
    sellerPubky: SELLER,
    dropAggregateId: `drop:${SELLER}_drop_summer_01`,
    edition: 7,
  }) as never;

const notFoundError = () =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.NOT_FOUND,
    message: 'HTTP 404',
    service: ErrorService.Homeserver,
    operation: 'test',
    context: { statusCode: 404 },
  });

const forbiddenError = () =>
  new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.BAD_REQUEST,
    message: 'HTTP 403',
    service: ErrorService.Homeserver,
    operation: 'test',
    context: { statusCode: 403 },
  });

const grantCapableSession = () => {
  vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
  vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
  vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
};

describe('CommerceApplication.publishOrderReceipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('publishes a verified portable receipt built from the attestation claims', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()]);

    expect(put).toHaveBeenCalledOnce();
    const [url, record] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(RECEIPT_URL);
    expect(record.recordType).toBe('order_receipt');
    expect(record.role).toBe('buyer');
    expect(record.ownerPubky).toBe(BUYER);
    expect(record.receiptId).toBe(RECEIPT_ID);
    expect(record.orderId).toBe(ORDER_ID);
    expect(record.total).toEqual({ amountMinor: 14796, currency: 'USD', exponent: 2 });
    expect(record.paidAt).toBe('2026-08-19T22:00:00.000Z');
    expect(record.receiptAttestation).toBe(JWS);
  });

  it('publishes a drop order receipt carrying the verified edition attestation', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const editions = vi
      .spyOn(MarketplaceGatewayService, 'getEditionAttestation')
      .mockResolvedValue(editionAttestation());
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidDropOrder()]);

    expect(editions).toHaveBeenCalledWith(BUYER, RECEIPT_ID);
    expect(put).toHaveBeenCalledOnce();
    const [, record] = put.mock.calls[0] as [string, Record<string, unknown>];
    expect(record.editionAttestation).toBe(EDITION_JWS);
    expect(record.drop).toEqual({ dropId: 'drop_summer_01', edition: 7, of: 100 });
  });

  it('refuses to publish a drop receipt whose edition attestation does not verify', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const tampered = editionAttestation();
    tampered.jws = `${EDITION_JWS.slice(0, -8)}AAAAAAAA`;
    vi.spyOn(MarketplaceGatewayService, 'getEditionAttestation').mockResolvedValue(tampered);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    await CommerceApplication.publishOrderReceipts(BUYER, [paidDropOrder()]);

    expect(put).not.toHaveBeenCalled();
  });

  it('does not fetch edition attestations for non-drop orders', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const editions = vi.spyOn(MarketplaceGatewayService, 'getEditionAttestation');
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770206')]);

    expect(editions).not.toHaveBeenCalled();
  });

  it('refuses to publish when the attestation does not verify against the record', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    // Tamper: signature bytes flipped — structural shape survives, crypto fails.
    const tampered = attestation();
    tampered.jws = `${JWS.slice(0, -8)}AAAAAAAA`;
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(tampered);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()]);

    expect(put).not.toHaveBeenCalled();
  });

  it('skips publication when the receipt document already exists on the homeserver', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ recordType: 'order_receipt' });
    const fetchAttestation = vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation');
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    // A distinct receipt id keeps this test independent of the module-level
    // published-URL memo the other tests populate.
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770202')]);

    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('does nothing without a durable mode, a session, or the /priv write grant', async () => {
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    vi.mocked(HomeserverService.hasActiveSession).mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops honestly when the deployment issues no attestations', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(null);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson');

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770204')]);

    expect(put).not.toHaveBeenCalled();
  });

  it('ignores orders the current user is not a party to and orders without receipts', async () => {
    grantCapableSession();
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    const stranger = 'y'.repeat(52);
    await CommerceApplication.publishOrderReceipts(stranger, [
      paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770205'),
      { receiptId: null, buyerPubky: stranger, sellerPubky: SELLER } as never,
    ]);

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('CommerceApplication.publishOrderReceipts publication status (step-up Option C)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('reports needs_reauth from session facts alone under the narrow bridged grant — no probing, no silent return', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770210')]),
    ).resolves.toBe('needs_reauth');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports skipped for non-durable modes and signed-out sessions', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770211')]),
    ).resolves.toBe('skipped');

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770211')]),
    ).resolves.toBe('skipped');
  });

  it('transitions needs_reauth → published when the session is widened by re-approval', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    const canWrite = vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770212')]),
    ).resolves.toBe('needs_reauth');

    // The step-up re-approval replaced the cookie with the superset grant.
    canWrite.mockReturnValue(true);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770212')]),
    ).resolves.toBe('published');
    expect(put).toHaveBeenCalledOnce();
  });

  it('reports published when every eligible receipt already exists on the homeserver', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ recordType: 'order_receipt' });

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770213')]),
    ).resolves.toBe('published');
  });

  it('re-reads a published receipt after clearMarketplaceSession instead of trusting the memo', async () => {
    grantCapableSession();
    const fetch = vi
      .spyOn(CommerceHomeserverService, 'fetchJson')
      .mockResolvedValue({ recordType: 'order_receipt' });
    vi.spyOn(MarketplaceSessionService, 'clearSession').mockImplementation(() => {});
    const receiptId = '018f47d2-6a27-7c23-a49d-6b21bb770217';

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(fetch).toHaveBeenCalledTimes(1);

    // Memo hit: a second pass in the same session does not re-read.
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(fetch).toHaveBeenCalledTimes(1);

    // Sign-out / account-switch teardown drops the memo alongside the bearer,
    // so the next session confirms publication from the homeserver itself.
    CommerceApplication.clearMarketplaceSession();
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports needs_reauth when the private read is refused with 403 mid-pass', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(forbiddenError());

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770214')]),
    ).resolves.toBe('needs_reauth');
  });

  it('reports unavailable when the deployment issues no attestations', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(null);

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770215')]),
    ).resolves.toBe('unavailable');
  });

  it('reports unavailable when a receipt write fails transiently (it retries on the next load)', async () => {
    grantCapableSession();
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(notFoundError());
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(new TypeError('network unavailable'));
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770216')]),
    ).resolves.toBe('unavailable');
  });
});
