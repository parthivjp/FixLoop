import { roundMoney, applyDiscount } from './utils.js';

export class Cart {
  constructor() { this.items = []; }

  add(name, price, qty = 1) { this.items.push({ name, price, qty }); }

  remove(name) { this.items = this.items.filter((i) => i.name !== name); }

  subtotal() {
    return this.items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  total(discountPct = 0) {
    return roundMoney(applyDiscount(this.subtotal(), discountPct));
  }

  mostExpensive() {
    if (this.items.length === 0) return null;
    return this.items.reduce((a, b) => (a.price > b.price ? a : b));
  }
}
