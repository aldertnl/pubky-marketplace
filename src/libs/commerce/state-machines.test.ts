import { describe, expect, it } from 'vitest';
import {
  canTransitionAuction,
  canTransitionListing,
  canTransitionOffer,
  canTransitionOrder,
  canTransitionPayment,
  canTransitionReservation,
} from './state-machines';
import type {
  AuctionState,
  ListingState,
  OfferState,
  OrderState,
  PaymentState,
  ReservationState,
} from './transaction-contracts';

describe('listing state machine', () => {
  it.each<[ListingState, ListingState]>([
    ['available', 'reserved'],
    ['reserved', 'available'],
    ['reserved', 'sold'],
    // Approving a paid order's cancellation returns its quantity to stock.
    ['sold', 'available'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionListing(from, to)).toBe(true);
  });

  it.each<[ListingState, ListingState]>([
    ['available', 'sold'],
    ['sold', 'reserved'],
    ['available', 'available'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionListing(from, to)).toBe(false);
  });
});

describe('reservation state machine', () => {
  it.each<[ReservationState, ReservationState]>([
    ['active', 'converted'],
    ['active', 'released'],
    ['active', 'expired'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionReservation(from, to)).toBe(true);
  });

  it.each<[ReservationState, ReservationState]>([
    ['converted', 'active'],
    ['released', 'active'],
    ['expired', 'converted'],
    ['active', 'active'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionReservation(from, to)).toBe(false);
  });
});

describe('offer state machine', () => {
  it.each<[OfferState, OfferState]>([
    ['pending', 'countered'],
    ['countered', 'countered'],
    ['countered', 'accepted'],
    ['pending', 'rejected'],
    ['pending', 'withdrawn'],
    ['countered', 'expired'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionOffer(from, to)).toBe(true);
  });

  it.each<[OfferState, OfferState]>([
    ['accepted', 'withdrawn'],
    ['rejected', 'pending'],
    ['expired', 'accepted'],
    ['pending', 'pending'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionOffer(from, to)).toBe(false);
  });
});

describe('auction state machine', () => {
  it.each<[AuctionState, AuctionState]>([
    ['scheduled', 'active'],
    ['active', 'sold'],
    ['active', 'unsold'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionAuction(from, to)).toBe(true);
  });

  // `cancelled` is declared but unreachable in the canonical contract.
  it.each<[AuctionState, AuctionState]>([
    ['scheduled', 'sold'],
    ['scheduled', 'cancelled'],
    ['active', 'cancelled'],
    ['sold', 'active'],
    ['unsold', 'active'],
    ['cancelled', 'active'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionAuction(from, to)).toBe(false);
  });
});

describe('payment state machine', () => {
  it.each<[PaymentState, PaymentState]>([
    ['awaiting_entitlement', 'detected'],
    ['awaiting_entitlement', 'confirmed'],
    ['awaiting_entitlement', 'expired'],
    ['awaiting_entitlement', 'manual_review'],
    ['detected', 'confirmed'],
    ['detected', 'manual_review'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(true);
  });

  it.each<[PaymentState, PaymentState]>([
    ['confirmed', 'detected'],
    ['expired', 'confirmed'],
    ['manual_review', 'confirmed'],
    ['detected', 'expired'],
    ['awaiting_entitlement', 'awaiting_entitlement'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionPayment(from, to)).toBe(false);
  });
});

describe('order state machine', () => {
  it.each<[OrderState, OrderState]>([
    ['pending_payment', 'paid'],
    ['pending_payment', 'cancelled'],
    ['paid', 'shipped'],
    ['paid', 'cancel_requested'],
    // Wave 7 local pickup (§A6): mark_ready arms the handover, confirm_pickup
    // completes it from either pickup state, and the buyer-protection
    // unilateral exits cancel straight from both.
    ['paid', 'ready_for_pickup'],
    ['paid', 'delivered'],
    ['paid', 'cancelled'],
    ['ready_for_pickup', 'delivered'],
    ['ready_for_pickup', 'cancel_requested'],
    ['ready_for_pickup', 'cancelled'],
    ['shipped', 'delivered'],
    ['delivered', 'completed'],
    ['delivered', 'return_requested'],
    ['completed', 'return_requested'],
    ['cancel_requested', 'cancelled'],
    ['cancelled', 'refunded_external'],
    ['return_requested', 'return_approved'],
    ['return_approved', 'return_received'],
    ['return_received', 'refunded_external'],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransitionOrder(from, to)).toBe(true);
  });

  it.each<[OrderState, OrderState]>([
    ['pending_payment', 'shipped'],
    ['paid', 'processing'],
    ['ready_for_pickup', 'shipped'],
    ['ready_for_pickup', 'paid'],
    ['shipped', 'return_requested'],
    ['shipped', 'cancelled'],
    ['completed', 'closed'],
    ['cancelled', 'paid'],
    ['closed', 'return_requested'],
    ['refunded_external', 'closed'],
  ])('rejects %s -> %s', (from, to) => {
    expect(canTransitionOrder(from, to)).toBe(false);
  });
});

