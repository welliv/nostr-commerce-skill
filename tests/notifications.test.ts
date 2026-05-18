import { describe, it, expect } from 'vitest';
import {
  subscribeToWalletPayments,
  createPaymentTracker,
} from '../src/notifications.js';

describe('Notifications (Scenario 9)', () => {
  it('subscribeToWalletPayments is callable', () => {
    expect(typeof subscribeToWalletPayments).toBe('function');
  });

  it('createPaymentTracker is callable', () => {
    expect(typeof createPaymentTracker).toBe('function');
  });
});
