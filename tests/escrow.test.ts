import { describe, it, expect, beforeAll } from 'vitest';
import { NWCEscrowBackend, createEscrowWithNWC } from '../src/escrow';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const NWC_URL = process.env.NWC_URL_1!;

describe('NWCEscrowBackend — Real NWC Integration', () => {
  let backend: NWCEscrowBackend;

  beforeAll(() => {
    if (!NWC_URL) {
      throw new Error('NWC_URL_1 not found in .env.test');
    }
    backend = new NWCEscrowBackend(NWC_URL);
  });

  it('should create a real hold invoice', async () => {
    const result = await backend.createHoldInvoice({
      amountMsats: 1000, // 1 sat
      description: 'Battle test escrow - 1 sat',
    });

    expect(result.paymentHash).toBeDefined();
    expect(result.invoice).toContain('lnbc');
    expect(result.preimage).toBeDefined();

    console.log('Created hold invoice:', result.paymentHash);
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

    console.log('Escrow created:', escrow.paymentHash);
  });
});