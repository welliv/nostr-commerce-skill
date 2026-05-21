import { describe, it, expect, beforeAll } from 'vitest';
import { NWCEscrowBackend, createEscrowWithNWC } from '../src/escrow';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const NWC_URL = process.env.NWC_URL_1;
// Gate: only run live network tests when explicitly opted in
// Usage: INTEGRATION_TESTS=true npx vitest tests/escrow.test.ts
const RUN_INTEGRATION = process.env.INTEGRATION_TESTS === 'true' && !!NWC_URL;

if (RUN_INTEGRATION) {
  describe('NWCEscrowBackend — Real NWC Integration', () => {
    let backend: NWCEscrowBackend;

    beforeAll(() => {
      backend = new NWCEscrowBackend(NWC_URL as string);
    });

    it('should create a real hold invoice', async () => {
      const result = await backend.createHoldInvoice({
        amountMsats: 1000, // 1 sat
        description: 'Battle test escrow - 1 sat',
      });

      expect(result.paymentHash).toBeDefined();
      expect(result.invoice).toContain('lnbc');
      expect(result.preimage).toBeDefined();
    });

    it('should create escrow using helper with real NWC', async () => {
      const escrow = await createEscrowWithNWC(
        {
          amountMsats: 2000,
          description: 'Battle test order #BT-001',
        },
        backend
      );

      expect(escrow.paymentHash).toBeDefined();
      expect(escrow.invoice).toContain('lnbc');
      expect(escrow.status).toBe('pending');
    });
  });
} else {
  describe('NWCEscrowBackend — Real NWC Integration', () => {
    it('skipped — run with INTEGRATION_TESTS=true to enable live wallet tests', () => {
      expect(true).toBe(true);
    });
  });
}
