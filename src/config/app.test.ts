import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitiesMatchFullGrant } from './app';

describe('capabilitiesMatchFullGrant', () => {
  const full = CAPABILITIES.split(',');

  it('accepts the exact CAPABILITIES set', () => {
    expect(capabilitiesMatchFullGrant(full)).toBe(true);
  });

  it('accepts a reordered full grant', () => {
    expect(capabilitiesMatchFullGrant([...full].reverse())).toBe(true);
  });

  it('refuses empty capabilities', () => {
    expect(capabilitiesMatchFullGrant([])).toBe(false);
  });

  it('refuses a missing or extra entry', () => {
    expect(capabilitiesMatchFullGrant(full.slice(0, 2))).toBe(false);
    expect(capabilitiesMatchFullGrant([...full, '/extra/:rw'])).toBe(false);
  });
});
