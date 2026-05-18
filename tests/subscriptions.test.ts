import { describe, it, expect, vi } from 'vitest';
import {
  createSubscription,
  cancelSubscription,
  storeSubscription,
  getSubscription,
} from '../src/subscriptions';

describe('Subscriptions', () => {
  it('should create a subscription record', () => {
    const sub = createSubscription({
      buyerPubkey: 'npub1buyer1234567890',
      merchantPubkey: 'npub1merchant',
      planDTag: 'premium-monthly',
      buyerNwcUrl: 'nostr+walletconnect://test',
      amountMsats: 2100000,
      frequency: 'month',
    });

    expect(sub).toHaveProperty('id');
    expect(sub.planDTag).toBe('premium-monthly');
    expect(sub.status).toBe('active');
  });

  it('should cancel a subscription', async () => {
    const sub = createSubscription({
      buyerPubkey: 'npub1buyer1234567890',
      merchantPubkey: 'npub1merchant',
      planDTag: 'premium-monthly',
      buyerNwcUrl: 'nostr+walletconnect://test',
      amountMsats: 2100000,
      frequency: 'month',
    });
    storeSubscription(sub);

    const cancelled = await cancelSubscription(sub.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('should retrieve subscription by id', () => {
    const sub = createSubscription({
      buyerPubkey: 'npub1buyer1234567890',
      merchantPubkey: 'npub1merchant',
      planDTag: 'premium-monthly',
      buyerNwcUrl: 'nostr+walletconnect://test',
      amountMsats: 2100000,
      frequency: 'month',
    });
    storeSubscription(sub);

    const found = getSubscription(sub.id);
    expect(found?.id).toBe(sub.id);
  });
});