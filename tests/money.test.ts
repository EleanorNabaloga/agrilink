import { expect, test } from "vitest";
import { computeAmounts, splitAmounts } from "@/lib/money";

test("buyer pays price + 3% + fee, all whole shillings", () => {
  expect(computeAmounts(60000, 50, 3, 1.5)).toEqual({ unitPrice: 60000, quantity: 50, subtotal: 3000000,
    commissionPercent: 3, commission: 90000, providerFee: 45000, total: 3135000 });
});
test("commission rounds to nearest shilling, fee rounds up", () => {
  const a = computeAmounts(333, 1, 3, 1.5);   // 9.99 -> 10, 4.995 -> 5
  expect([a.commission, a.providerFee, a.total]).toEqual([10, 5, 348]);
});
test("zero commission allowed", () => { expect(computeAmounts(1000, 2, 0, 0).total).toBe(2000); });
test("rejects fractional or non-positive inputs", () => {
  expect(() => computeAmounts(1000.5, 1, 3, 0)).toThrow(RangeError);
  expect(() => computeAmounts(1000, 0, 3, 0)).toThrow(RangeError);
});
test("split parts always add up to the total paid", () => {
  const a = computeAmounts(60000, 50, 3, 1.5);
  for (const f of [0, 1, 1234567, 3000000]) {
    const s = splitAmounts(a, f);
    expect(s.farmer + s.commission + s.buyerRefund).toBe(a.total);
    expect(s.commission).toBe(Math.round(f * 3 / 100));
  }
});
test("split refuses more than the subtotal", () => {
  expect(() => splitAmounts(computeAmounts(100, 1, 3, 0), 101)).toThrow(RangeError);
});
