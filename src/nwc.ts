/**
 * nwc.ts - Nostr Wallet Connect (NIP-47, Scenario 7)
 *
 * Provides Lightning wallet operations via NWC - the only standardized way
 * to connect a Lightning wallet to a Nostr application without custody.
 *
 * AUDIT FIX APPLIED:
 *   BUG-04: @getalby/sdk v3 does NOT export NWCClient at the top level.
 *           Previous: import { NWCClient } from "@getalby/sdk"  ← WRONG (module not found)
 *           Fixed:    import { nwc } from "@getalby/sdk"
 *                     new nwc.NWCClient({ nostrWalletConnectUrl: url })
 *
 * SECURITY RULES (enforced by design):
 *   1. NWC connection URL contains a secret - ALWAYS load from environment variable.
 *   2. Use a dedicated connection per app - never reuse your main wallet connection.
 *   3. Set a spending budget in Alby Hub before creating the connection.
 *   4. This module never logs the connection URL, any preimage, or any secret.
 *   5. Budget = your blast radius if the NWC_CONNECTION_URL is ever compromised.
 */

import { nwc } from "@getalby/sdk";  // BUG-04 FIX: correct import path
import type { InvoiceParams, InvoiceResult, PaymentResult } from "./types.js";

// ─── Wallet Client ────────────────────────────────────────────────────────────

export class NostrWalletConnect {
  private client: nwc.NWCClient;  // BUG-04 FIX: nwc.NWCClient not NWCClient
  private connected = false;

  /**
   * @param connectionUrl - nostr+walletconnect://<pubkey>?relay=<url>&secret=<hex>
   *
   * SECURITY: Load from process.env.NWC_CONNECTION_URL - never hardcode.
   * Get this URL from: Alby Hub → App Connections → New Connection
   *                    Set a sats budget before copying the URL.
   */
  constructor(connectionUrl: string) {
    if (!connectionUrl.startsWith("nostr+walletconnect://")) {
      throw new Error(
        "Invalid NWC connection URL.\n" +
          "Must start with: nostr+walletconnect://\n" +
          "Get yours from: Alby Hub (albyhub.com) → App Connections → New Connection"
      );
    }
    this.client = new nwc.NWCClient({  // BUG-04 FIX
      nostrWalletConnectUrl: connectionUrl,
    });
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connect to the wallet service and verify what methods are supported.
   * Call this once before any other method.
   * Throws if the connection URL is wrong or the wallet is unreachable.
   */
  async connect(): Promise<{ methods: string[]; alias?: string }> {
    const info = await this.client.getInfo();
    this.connected = true;
    return {
      methods: info.methods ?? [],
      alias: info.alias,
    };
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error(
        "Wallet not connected. Call connect() before using wallet methods.\n" +
          "Example: const wallet = createWalletFromEnv(); await wallet.connect();"
      );
    }
  }

  // ─── Balance ────────────────────────────────────────────────────────────────

  /** Get wallet balance. Returns both msats and whole sats. */
  async getBalance(): Promise<{ msats: number; sats: number }> {
    this.assertConnected();
    const result = await this.client.getBalance();
    return {
      msats: result.balance,
      sats: Math.floor(result.balance / 1000),
    };
  }

  // ─── Invoice Creation ────────────────────────────────────────────────────────

  /**
   * Create a standard BOLT-11 Lightning invoice.
   * Use this for direct payments (Scenario 7).
   * For escrow hold invoices (Scenario 8), use escrow.ts → createEscrow().
   */
  async createInvoice(params: InvoiceParams): Promise<InvoiceResult> {
    this.assertConnected();

    if (params.amountMsats <= 0) {
      throw new Error("Invoice amount must be greater than 0 msats.");
    }

    const result = await this.client.makeInvoice({
      amount: params.amountMsats,
      description: params.description ?? "Nostr Commerce Payment",
      expiry: params.expiry ?? 3600,
    });

    return {
      invoice: result.invoice,
      paymentHash: result.payment_hash,
      expiresAt: Math.floor(Date.now() / 1000) + (params.expiry ?? 3600),
    };
  }

  // ─── Payment ─────────────────────────────────────────────────────────────────

  /**
   * Pay a BOLT-11 Lightning invoice.
   *
   * Returns the preimage - your cryptographic proof of payment.
   * STORE THIS. It is required for:
   *   - Scenario 9: Proof of Payment (NIP-85 attestation)
   *   - Scenario 10: Preimage-gated reviews (kind 31990)
   *
   * The preimage is only returned once. If you lose it, you cannot prove payment.
   */
  async payInvoice(invoice: string): Promise<PaymentResult> {
    this.assertConnected();

    const normalizedInvoice = invoice.toLowerCase();
    if (
      !normalizedInvoice.startsWith("lnbc") &&
      !normalizedInvoice.startsWith("lntb") &&
      !normalizedInvoice.startsWith("lnbcrt")
    ) {
      throw new Error(
        "Invalid BOLT-11 invoice. Must start with lnbc (mainnet), lntb (testnet), or lnbcrt (regtest)."
      );
    }

    const result = await this.client.payInvoice({ invoice });

    return {
      preimage: result.preimage,
      paymentHash: result.payment_hash ?? "",
      feeMsats: result.fees_paid,
    };
  }

  // ─── Invoice Lookup ────────────────────────────────────────────────────────

  /**
   * Look up an invoice by payment hash to check if it has been paid.
   *
   * Use this to poll for escrow payment status (Scenario 8).
   * For high-volume polling, use exponential backoff - see escrow.ts.
   */
  async lookupInvoice(paymentHash: string): Promise<{
    paid: boolean;
    preimage?: string;
    settledAt?: number;
    amountMsats?: number;
  }> {
    this.assertConnected();
    try {
      const result = await this.client.lookupInvoice({
        payment_hash: paymentHash,
      });
      return {
        paid: result.settled_at != null,
        preimage: result.preimage,
        settledAt: result.settled_at,
        amountMsats: result.amount,
      };
    } catch {
      // Invoice not found or not yet paid
      return { paid: false };
    }
  }

  // ─── Transaction History ──────────────────────────────────────────────────

  /** List recent transactions. Useful for merchant dashboards and Scenario 21. */
  async listTransactions(options?: {
    limit?: number;
    type?: "incoming" | "outgoing";
    from?: number;
    until?: number;
  }): Promise<
    {
      type: string;
      invoice: string;
      paymentHash: string;
      amountMsats: number;
      feeMsats?: number;
      description?: string;
      settledAt?: number;
    }[]
  > {
    this.assertConnected();
    const result = await this.client.listTransactions({
      limit: options?.limit ?? 20,
      type: options?.type,
      from: options?.from,
      until: options?.until,
    });

    return (result.transactions ?? []) .map((tx: any) => ({
      type: tx.type,
      invoice: tx.invoice,
      paymentHash: tx.payment_hash,
      amountMsats: tx.amount,
      feeMsats: tx.fees_paid,
      description: tx.description,
      settledAt: tx.settled_at,
    }));
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    await this.client.close();
    this.connected = false;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a NWC client from an environment variable.
 *
 * @param envKey - Name of the environment variable (default: NWC_CONNECTION_URL)
 *
 * @example
 *   const wallet = createWalletFromEnv();
 *   await wallet.connect();
 *   const balance = await wallet.getBalance();
 */
export function createWalletFromEnv(
  envKey = "NWC_CONNECTION_URL"
): NostrWalletConnect {
  const url = process.env[envKey];
  if (!url) {
    throw new Error(
      `Missing environment variable: ${envKey}\n\n` +
        `To get a NWC connection URL:\n` +
        `  1. Install Alby Hub: https://albyhub.com\n` +
        `  2. Connect a Lightning node (LND, CLN, or Alby's hosted node)\n` +
        `  3. Go to App Connections → New Connection\n` +
        `  4. Set a spending budget (start with 10,000 sats)\n` +
        `  5. Copy the nostr+walletconnect:// URL into your .env file`
    );
  }
  return new NostrWalletConnect(url);
}
