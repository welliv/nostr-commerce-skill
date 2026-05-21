import { describe, it, expect } from 'vitest';
import { buildCart, summarizeCart } from '../src/cart';

describe('multi merchant Cart (Battle Tests)', () => {
  it('should build a cart', () => {
    const cart = buildCart('npub1buyer', [
      { merchantPubkey: 'npub1m1', listingEventId: 'evt1', amountMsats: 10000, quantity: 1 },
      { merchantPubkey: 'npub1m2', listingEventId: 'evt2', amountMsats: 25000, quantity: 1 },
    ]);

    expect(cart).toHaveProperty('id');
    expect(cart.items.length).toBe(2);
  });

  it('should summarize cart correctly', () => {
    const cart = buildCart('npub1buyer', [
      { merchantPubkey: 'npub1m1', listingEventId: 'evt1', amountMsats: 10000, quantity: 1 },
      { merchantPubkey: 'npub1m1', listingEventId: 'evt2', amountMsats: 5000, quantity: 1 },
    ]);

    const summary = summarizeCart(cart);
    expect(summary.merchantCount).toBe(1);
    expect(summary.totalMsats).toBe(15000);
  });
});