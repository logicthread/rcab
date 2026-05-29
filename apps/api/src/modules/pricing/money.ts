export type Currency = 'INR';

export interface Money {
  /** integer minor units (paise for INR) */
  amount: number;
  currency: Currency;
}

export const ZERO_INR: Money = { amount: 0, currency: 'INR' };

export function inr(amount: number): Money {
  if (!Number.isFinite(amount)) {
    throw new Error(`inr(): non-finite amount ${amount}`);
  }
  return { amount: Math.round(amount), currency: 'INR' };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sumMoney(values: Money[]): Money {
  if (values.length === 0) return ZERO_INR;
  return values.reduce((acc, m) => addMoney(acc, m), { amount: 0, currency: values[0].currency });
}

export function mulMoney(m: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new Error(`mulMoney(): non-finite factor ${factor}`);
  }
  return { amount: Math.round(m.amount * factor), currency: m.currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
