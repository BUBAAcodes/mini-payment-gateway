import { describe, expect, it } from 'vitest';
import { computeSettlement } from './settlements';

describe('computeSettlement', () => {
  it('pays out captures minus our fees minus refunds', () => {
    const totals = computeSettlement(
      [
        { amount: 50_000, fee: 1_000 },
        { amount: 30_000, fee: 600 },
      ],
      [{ amount: 20_000 }],
    );
    expect(totals).toEqual({ gross: 80_000, fees: 1_600, refunds: 20_000, net: 58_400 });
  });

  it('is zero for nothing', () => {
    expect(computeSettlement([], [])).toEqual({ gross: 0, fees: 0, refunds: 0, net: 0 });
  });

  it('goes negative when refunds outweigh new captures', () => {
    // A full refund of an earlier ₹500 payment, with nothing new captured: the fee isn't
    // returned (decision 0001), so the merchant owes us the whole refund.
    expect(computeSettlement([], [{ amount: 50_000 }]).net).toBe(-50_000);
  });
});
