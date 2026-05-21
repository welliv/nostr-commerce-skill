/**
 * Scenario 21: Notifications (NWC + NIP-44/59)
 * Tests createPaymentTracker state management in-process
 * and subscribeToWalletPayments session interface.
 * No real wallet connections needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createPaymentTracker, subscribeToWalletPayments } from '../src/notifications';
import { NostrWalletConnect } from '../src/nwc';

const VALID_NWC_URL =
  'nostr+walletconnect://' + 'a'.repeat(64) +
  '?relay=wss%3A%2F%2Frelay.getalby.com&secret=' + 'b'.repeat(64);

const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);
const HASH_3 = 'c'.repeat(64);

// ── createPaymentTracker ──────────────────────────────────────────────────────

describe('Scenario 21: Notifications', () => {
  describe('createPaymentTracker', () => {
    it('starts with pendingCount of 0', () => {
      const tracker = createPaymentTracker();
      expect(tracker.pendingCount).toBe(0);
    });

    it('register increments pendingCount', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      expect(tracker.pendingCount).toBe(1);
    });

    it('lookup returns orderId after registering', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      expect(tracker.lookup(HASH_1)).toBe('order-001');
    });

    it('lookup returns undefined for unknown payment hash', () => {
      const tracker = createPaymentTracker();
      expect(tracker.lookup(HASH_1)).toBeUndefined();
    });

    it('remove decrements pendingCount', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      tracker.register(HASH_2, 'order-002');
      tracker.remove(HASH_1);
      expect(tracker.pendingCount).toBe(1);
    });

    it('lookup returns undefined after removing', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      tracker.remove(HASH_1);
      expect(tracker.lookup(HASH_1)).toBeUndefined();
    });

    it('stores and retrieves metadata', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001', { buyerNote: 'gift wrap please' });
      expect(tracker.getMetadata(HASH_1)).toEqual({ buyerNote: 'gift wrap please' });
    });

    it('getMetadata returns undefined for unknown hash', () => {
      const tracker = createPaymentTracker();
      expect(tracker.getMetadata(HASH_1)).toBeUndefined();
    });

    it('tracks multiple independent payments', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      tracker.register(HASH_2, 'order-002');
      tracker.register(HASH_3, 'order-003');
      expect(tracker.pendingCount).toBe(3);
      expect(tracker.lookup(HASH_2)).toBe('order-002');
    });

    it('remove is idempotent for unknown hash', () => {
      const tracker = createPaymentTracker();
      expect(() => tracker.remove('unknown'.padEnd(64, '0'))).not.toThrow();
    });

    it('overwriting a payment hash updates the orderId', () => {
      const tracker = createPaymentTracker();
      tracker.register(HASH_1, 'order-001');
      tracker.register(HASH_1, 'order-002-updated');
      expect(tracker.lookup(HASH_1)).toBe('order-002-updated');
      expect(tracker.pendingCount).toBe(1); // still just one entry
    });
  });

  describe('subscribeToWalletPayments', () => {
    it('returns a NotificationSession with close() and isActive', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      // subscribeToWalletPayments calls (wallet as any).subscribeNotifications
      (wallet as any).subscribeNotifications = vi.fn().mockResolvedValue({
        close: vi.fn(),
      });

      const session = await subscribeToWalletPayments(wallet, vi.fn());
      expect(typeof session.close).toBe('function');
      expect(typeof session.isActive).toBe('boolean');
    });

    it('session.isActive is true after creation', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      (wallet as any).subscribeNotifications = vi.fn().mockResolvedValue({
        close: vi.fn(),
      });

      const session = await subscribeToWalletPayments(wallet, vi.fn());
      expect(session.isActive).toBe(true);
    });

    it('session.isActive is false after close()', async () => {
      const wallet = new NostrWalletConnect(VALID_NWC_URL);
      (wallet as any).subscribeNotifications = vi.fn().mockResolvedValue({
        close: vi.fn(),
      });

      const session = await subscribeToWalletPayments(wallet, vi.fn());
      session.close();
      expect(session.isActive).toBe(false);
    });
  });
});