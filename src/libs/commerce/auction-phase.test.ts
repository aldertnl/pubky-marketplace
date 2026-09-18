import { describe, expect, it } from 'vitest';
import { getAuctionPhase } from './auction-phase';

const startsAt = '2026-09-09T10:00:00.000Z';
const endsAt = '2026-09-09T11:00:00.000Z';

describe('getAuctionPhase', () => {
  it('treats the exact end boundary as ended', () => {
    expect(getAuctionPhase(startsAt, endsAt, Date.parse(endsAt))).toBe('ended');
  });

  it('treats time before the start as upcoming', () => {
    expect(getAuctionPhase(startsAt, endsAt, Date.parse(startsAt) - 1)).toBe('upcoming');
  });
});
