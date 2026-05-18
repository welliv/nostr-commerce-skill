import { describe, it, expect } from 'vitest';
import {
  initiateDispute,
  verifyPaymentViaLnurl,
} from '../src/disputes.js';

describe('Disputes (Scenario 22)', () => {
  it('initiateDispute is callable', () => {
    expect(typeof initiateDispute).toBe('function');
  });

  it('verifyPaymentViaLnurl is callable', () => {
    expect(typeof verifyPaymentViaLnurl).toBe('function');
  });
});
