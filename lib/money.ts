export type Amounts = {
  unitPrice: number;
  quantity: number;
  subtotal: number;
  commissionPercent: number;
  commission: number;
  providerFee: number;
  total: number;
};

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function isNonNegativeNumber(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function computeAmounts(
  unitPrice: number,
  quantity: number,
  commissionPercent: number,
  providerFeePercent: number,
): Amounts {
  if (!isPositiveInteger(unitPrice)) throw new RangeError("unitPrice must be a positive integer");
  if (!isPositiveInteger(quantity)) throw new RangeError("quantity must be a positive integer");
  if (!isNonNegativeNumber(commissionPercent)) throw new RangeError("commissionPercent must be >= 0");
  if (!isNonNegativeNumber(providerFeePercent)) throw new RangeError("providerFeePercent must be >= 0");

  const subtotal = unitPrice * quantity;
  const commission = Math.round((subtotal * commissionPercent) / 100);
  const providerFee = Math.ceil((subtotal * providerFeePercent) / 100);
  return {
    unitPrice,
    quantity,
    subtotal,
    commissionPercent,
    commission,
    providerFee,
    total: subtotal + commission + providerFee,
  };
}

export function splitAmounts(
  a: Amounts,
  farmerAmount: number,
): { farmer: number; commission: number; buyerRefund: number } {
  if (!Number.isInteger(farmerAmount) || farmerAmount < 0 || farmerAmount > a.subtotal) {
    throw new RangeError("farmerAmount must be an integer between 0 and the subtotal");
  }
  const commission = Math.round((farmerAmount * a.commissionPercent) / 100);
  const buyerRefund = a.total - farmerAmount - commission;
  return { farmer: farmerAmount, commission, buyerRefund };
}
