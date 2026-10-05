import test from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
import { applyDiscount, roundMoney } from '../src/utils.js';

test('roundMoney rounds to 2 decimals', () => assert.equal(roundMoney(10.456), 10.46));
test('applyDiscount treats pct as a percentage', () => assert.equal(applyDiscount(200, 20), 160));

test('subtotal respects quantity', () => {
  const c = new Cart(); c.add('pen', 2.5, 4); c.add('book', 10);
  assert.equal(c.subtotal(), 20);
});
test('total applies discount', () => {
  const c = new Cart(); c.add('lamp', 50, 2);
  assert.equal(c.total(10), 90);
});
test('remove deletes by name', () => {
  const c = new Cart(); c.add('a', 1); c.add('b', 2); c.remove('a');
  assert.deepEqual(c.items.map((i) => i.name), ['b']);
});
test('mostExpensive returns null for empty cart', () => assert.equal(new Cart().mostExpensive(), null));
test('mostExpensive finds the priciest item', () => {
  const c = new Cart(); c.add('a', 5); c.add('b', 9); c.add('c', 7);
  assert.equal(c.mostExpensive().name, 'b');
});
