export function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

// pct is a percentage, e.g. 20 means 20% off
export function applyDiscount(price, pct) {
  return price - price * pct;
}
