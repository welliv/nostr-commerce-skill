# nostr-commerce-skill

A TypeScript library and AI skill implementing all 22 Nostr commerce scenarios — identity, listings, Lightning payments, escrow, reviews, subscriptions, multi-merchant carts, and disputes.

Built for developers and AI agents who want to build real commerce on Nostr without becoming a NIP expert first.

---

## The problem this solves

Traditional platforms own everything. Amazon owns your seller account, your reviews, your reputation. If they ban you, it's gone. If they shut down, it's gone.

Nostr commerce is different: your identity is a cryptographic keypair, your listings are signed events on relays, your reputation is tied to your pubkey — none of it belongs to a platform.

The challenge is that Nostr commerce spans 22+ different NIPs. Product listings, Lightning payments, escrow, encrypted orders, and dispute resolution each use separate protocols. This library ties them together in one coherent API.

---

## Install

```bash
npm install nostr-commerce-skill
```

To load it as a skill for Claude Code, Cursor, or similar AI tools:

```bash
npx skills add welliv/nostr-commerce-skill
```

---

## Quick start

### Identity (Scenario 1)

```typescript
import { generateIdentity, saveIdentityToFile, loadIdentityFromFile } from 'nostr-commerce-skill';

// Node.js: generate a keypair
const identity = generateIdentity();
// identity.pubkey — share this. It's your public address on Nostr.
// identity.privateKey — never log or commit this.

// Save encrypted to disk (AES-256-GCM)
await saveIdentityToFile(identity, 'strong-passphrase', './merchant.json');

// Load it back
const identity = await loadIdentityFromFile('./merchant.json', 'strong-passphrase');
```

In a browser, skip key generation — use the user's Nostr extension (Alby, nos2x):

```typescript
import { hasNip07Signer, getNip07Pubkey } from 'nostr-commerce-skill';

if (hasNip07Signer()) {
  const pubkey = await getNip07Pubkey();
}
```

---

### Listing a product (Scenario 2 + 3)

```typescript
import { signAndPublishListing } from 'nostr-commerce-skill';

const result = await signAndPublishListing(
  {
    dTag: 'lavender-8oz',           // stable ID — reuse this to update the listing
    title: 'Lavender Soy Candle',
    summary: '8oz hand-poured soy wax',
    content: 'Burns for 40-50 hours. Ships in 2 days.',
    price: { amount: '18.00', currency: 'USD' },
    images: ['https://example.com/candle.jpg'],
    categories: ['candles', 'handmade'],
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400, // expires in 30 days (NIP-40)
  },
  identity.privateKey
);

console.log(result.shareableLink); // naddr1... — share this link with buyers
```

To update a listing, publish again with the same `dTag`. Relays replace the old version automatically.

---

### Sending an encrypted order (Scenario 6)

```typescript
import { sendEncryptedOrder } from 'nostr-commerce-skill';

// Buyer sends order details — relay operators cannot read this
await sendEncryptedOrder(
  {
    type: 0,
    id: 'order-' + Date.now(),
    items: [{ product_id: 'lavender-8oz', quantity: 2 }],
    shippingAddress: '123 Main St, Portland OR 97201',
    message: 'Please include gift wrapping',
  },
  buyerPrivkey,
  merchantPubkey
);

// Merchant decrypts — only they can
const { order, buyerPubkey } = decryptIncomingOrder(wrapEvent, merchantPrivkey);

// ── Direct Payment (Scenario 7) ────────────────────────────────────

// NWC_CONNECTION_URL from Alby Hub → App Connections → New Connection
const wallet = new NostrWalletConnect(process.env.NWC_CONNECTION_URL);
await wallet.connect();

const invoice = await wallet.createInvoice({ amountMsats: 50_000, description: 'Order #001' });
// Buyer pays invoice.invoice from their own wallet
const lookup = await wallet.lookupInvoice(invoice.paymentHash);
if (lookup.paid) console.log('Preimage:', lookup.preimage); // store this

// ── Escrow (Scenario 8) ────────────────────────────────────────────

// Requires Alby Hub — standard NWC wallets don't support hold invoices
const backend = new NWCEscrowBackend(process.env.NWC_CONNECTION_URL);
const escrow = await createEscrowWithNWC({ amountMsats: 50_000, description: 'Order #001' }, backend);
storeEscrowSession(escrow);
// Buyer pays → funds locked. Merchant ships → buyer confirms → call settleEscrow().
// If no confirmation before NIP-40 deadline → invoice auto-expires → buyer refunded.

// ── Proof of Payment (Scenario 9) ─────────────────────────────────

const valid = await verifyPreimage(payment.preimage, invoice.paymentHash);
// true only if SHA256(preimage) === paymentHash

// ── Reviews (Scenario 10) ──────────────────────────────────────────

await publishReview(
  {
    listingEventId: listing.eventId,
    rating: 5,
    content: 'Burns beautifully. Already ordered again.',
    preimage: payment.preimage,      // proof of purchase — required
    paymentHash: invoice.paymentHash,
  },
  buyerPrivkey
);
const reviews = await fetchVerifiedReviews(merchantPubkey, 'pubkey');

// ── Product Q&A (Scenario 11) ──────────────────────────────────────

await postQuestion(
  { listingEventId: listing.eventId, listingAuthorPubkey: merchantPubkey,
    question: 'Does this candle work outdoors?' },
  buyerPrivkey
);
const threads = buildQAThreads(parseQAThread(await fetchQAThread(listing.eventId)));

// ── Report Bad Actor (Scenario 12) ────────────────────────────────

await publishReport(
  { reportedPubkey: scammerPubkey, reason: 'scam',
    comment: 'Took payment, never delivered.', evidenceEventId: orderEventId },
  reporterPrivkey
);
const trust = await assessPubkeyTrust(pubkey);
console.log(`Risk score: ${trust.riskScore}/10`); // 0 = trusted, 10 = investigate
```

---

## Chapter 3 — Trust

The reputation layer: social proof, splits, subscriptions, carts, fees.

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 13 | Zaps | Pay to endorse a listing. A zap costs real sats — it's skin-in-the-game social proof. Spam-resistant: you can't endorse without paying. | NIP-57 |
| 14 | Payment Prisms | Split a single payment between multiple recipients at payment time. Non-custodial — no one holds funds between payer and recipients. | NIP-57 splits |
| 15 | Subscriptions | Recurring payments with a buyer-set spending cap. Merchant requests payment each period; the buyer's wallet auto-approves within their budget. | NIP-99, 47 |
| 16 | Multi-merchant Cart | One checkout, multiple merchants. Sequential Lightning payments routed to each seller. One payment flow, no per-merchant friction. | NIP-57 splits, 99 |
| 17 | Platform Fees | Fee extracted at payment time, visible in the invoice before the buyer pays. No hidden extraction, no surprise deductions. | NIP-57 prisms |

### Quick start — Trust

```typescript
import {
  requestZapInvoice,
  buildPrism,
  createSubscription,
  chargeSubscription,
  getDueSubscriptions,
  buildCart,
  payCartSequential,
  calculateFee,
} from 'nostr-commerce-skill';

// ── Zaps + Prisms (Scenarios 13, 14) ──────────────────────────────

// 97% to seller, 3% to platform — split at payment time, no custody
const recipients = buildPrism(
  { pubkey: sellerPubkey, percentage: 97 },
  { pubkey: platformPubkey, percentage: 3 },
);
const { invoice } = await requestZapInvoice(
  { recipients, amountMsats: 10_000, comment: 'Great candle!', relays: ['wss://relay.damus.io'] },
  buyerPrivkey,
  sellerLnurlEndpoint
);

// ── Subscriptions (Scenario 15) ────────────────────────────────────

// Buyer subscribes — their NWC wallet auto-pays within the budget cap
const sub = createSubscription({
  planDTag: 'candle-club-monthly',
  buyerPubkey: buyer.pubkey,
  merchantPubkey: merchant.pubkey,
  buyerNwcUrl: buyer.nwcConnectionUrl, // buyer's wallet — merchant never holds funds
  amountMsats: 5_000_000,              // 50,000 sats/month
  frequency: 'month',                  // 'hour' | 'day' | 'week' | 'month' | 'year'
});

// Merchant's billing agent runs on a schedule
const due = getDueSubscriptions();
for (const s of due) await chargeSubscription(s.id, merchantWallet);

// ── Multi-merchant Cart (Scenario 16) ──────────────────────────────

const cart = buildCart(buyerPubkey, [
  { listingEventId: 'e'.repeat(64), dTag: 'lavender-8oz',
    merchantPubkey: alicePubkey, merchantLud16: 'alice@getalby.com',
    quantity: 2, unitPriceMsats: 18_000, amountMsats: 36_000, title: 'Lavender Candle' },
  { listingEventId: 'f'.repeat(64), dTag: 'cedar-soap',
    merchantPubkey: bobPubkey, merchantLud16: 'bob@getalby.com',
    quantity: 1, unitPriceMsats: 8_000, amountMsats: 8_000, title: 'Cedar Soap' },
]);
// Sequential Lightning payments — Alice gets 36k, Bob gets 8k, buyer pays once
const results = await payCartSequential(cart, buyerWallet, buyerPrivkey);

// ── Platform Fees (Scenario 17) ────────────────────────────────────

const fee = calculateFee(50_000, {
  platformPubkey, platformLnurl: 'fees@shopstr.store', feePercent: 3, minFeeMsats: 1_000,
});
// fee.merchantMsats = 50_000 | fee.feeMsats = 1_500 | fee.totalMsats = 51_500
// Fee is visible in the invoice before the buyer pays
```

---

## Chapter 4 — Advanced Commerce

Machine-readable APIs, honest advertising, fiat pricing, encrypted notifications, dispute resolution.

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 18 | Zapvertising | Pay viewers directly to see your ad. Viewers receive real sats — not tracked, not profiled, not manipulated. Budget-controlled. | NIP-57, 50 |
| 19 | Fiat Conversion | List prices in USD, EUR, GBP. Buyers pay sats at the real-time CoinGecko rate. Merchant thinks in dollars; protocol doesn't care. | NIP-99 + rate API |
| 20 | Paid APIs (L402) | Per-call Lightning payments for API access. AI agents can discover, pay for, and consume data autonomously — no API keys, no accounts. | L402, NIP-98 |
| 21 | Notifications | Encrypted order confirmations via Nostr relays. No email address required, no webhook infrastructure, no plain-text receipts. | NIP-44, 59 |
| 22 | LNURL-Verify + Disputes | Cryptographic dispute resolution: a third party verifies payment settled without seeing either party's wallet. Arbitrator's signed assertion is permanent. | NIP-85, LNURL |

### Quick start — Advanced

```typescript
import {
  runZapvertiseCampaign,
  fiatToMsats,
  msatsToFiat,
  formatPrice,
  fetchWithL402,
  publishApiEndpoint,
  createL402Challenge,
  verifyL402Credentials,
  subscribeToWalletPayments,
  sendBuyerPaymentConfirmation,
  createPaymentTracker,
  verifyPaymentViaLnurl,
  initiateDispute,
} from 'nostr-commerce-skill';

// ── Zapvertising (Scenario 18) ─────────────────────────────────────

// Find Nostr users interested in "candles" and pay each one 100 sats to see your listing
const result = await runZapvertiseCampaign(
  {
    audienceQuery: 'handmade candles',
    message: 'Alice's Candles — 40-hour burn, ships in 48h. Use code NOSTR10 for 10% off.',
    amountPerViewerMsats: 100_000, // 100 sats per viewer
    maxViewers: 50,                // total budget cap: 5,000 sats
  },
  advertiserWallet,
  advertiserPrivkey
);
console.log(`Reached ${result.reached} viewers, spent ${result.totalSpentMsats / 1000} sats`);
// result.viewers[n].status: 'zapped' | 'no_lnurl' | 'failed'

// ── Fiat Conversion (Scenario 19) ─────────────────────────────────

// Listing priced in USD — convert to sats at checkout
const conversion = await fiatToMsats(18.00, 'USD');
// conversion.amountMsats = 63_000_000 (at current rate, e.g. 3500 sats/USD)

// Display sats price in fiat for non-Bitcoin users
const display = await msatsToFiat(63_000_000, 'USD');
console.log(`$${display.fiatAmount.toFixed(2)}`); // "$18.00"

// Format a listing price tag for display
const tag = { amount: '18.00', currency: 'USD', amountMsats: 63_000_000 };
console.log(formatPrice(tag)); // "$18.00 (63,000 sats)"

// ── Paid APIs / L402 (Scenario 20) ────────────────────────────────

// === API PROVIDER: announce a paid endpoint ===
await publishApiEndpoint(
  {
    id: 'catalog-v1',
    name: 'Alice Product Catalog',
    description: 'Full catalog with images and availability',
    url: 'https://api.alicecandles.com/catalog',
    pricePerCallMsats: 1_000,  // 1 sat per query
    methods: ['GET'],
  },
  merchantPrivkey
);

// === API PROVIDER: issue a 402 challenge on incoming request ===
const { challenge, paymentHash } = await createL402Challenge(
  merchantWallet, 1_000, 'Catalog API access'
);
// Return challenge in WWW-Authenticate header with HTTP 402 status

// === API PROVIDER: verify payment before returning data ===
const paid = await verifyL402Credentials(req.headers.authorization, merchantWallet);
if (!paid) return res.status(402).set('WWW-Authenticate', challenge).send();

// === API CONSUMER: pay automatically and fetch data ===
const response = await fetchWithL402(
  'https://api.alicecandles.com/catalog',
  { method: 'GET' },
  buyerWallet,
  buyerPrivkey  // for optional NIP-98 authentication
);
const catalog = await response.json();

// ── Notifications (Scenario 21) ────────────────────────────────────

// Merchant: subscribe to incoming Lightning payments
const tracker = createPaymentTracker();

const session = await subscribeToWalletPayments(
  merchantWallet,
  async (payment) => {
    const orderId = tracker.lookup(payment.paymentHash);
    if (!orderId) return;

    // Send encrypted confirmation to buyer — no email, no plain text
    await sendBuyerPaymentConfirmation(
      {
        orderId,
        paymentHash: payment.paymentHash,
        preimage: payment.preimage,
        amountMsats: payment.amountMsats,
        type: 'incoming',
        settledAt: Math.floor(Date.now() / 1000),
        message: 'Your order is confirmed! Ships within 48 hours.',
      },
      merchantPrivkey,
      buyerPubkey
    );
  }
);

// Register invoices when creating them
const invoice = await merchantWallet.createInvoice({ amountMsats: 50_000 });
tracker.register(invoice.paymentHash, 'order-001');

// Shut down cleanly
session.close();

// ── Disputes (Scenario 22) ─────────────────────────────────────────

// Arbitrator: verify payment happened without seeing either wallet
const verification = await verifyPaymentViaLnurl(
  'https://alice.getalby.com/lnurl-verify/abc123',
  paymentHash
);
if (verification.settled) {
  console.log('Payment confirmed — buyer's claim is valid');
  console.log('Preimage:', verification.preimage); // cryptographic proof
}

// Buyer: raise a formal dispute if merchant doesn't deliver
await initiateDispute(
  {
    orderId: 'order-001',
    merchantPubkey,
    buyerPubkey,
    paymentHash: invoice.paymentHash,
    reason: 'Item never arrived after 30 days. Tracking shows delivered but package missing.',
    evidenceEventIds: [orderEventId, trackingEventId],
  },
  buyerPrivkey
);
```

---
## Alice's journey — all 22 scenarios in practice

Alice sells handmade candles.

**Setting up (1–5):** She installs Alby, gets a keypair, publishes her profile. Her identity is a 64-character pubkey — not an account on anyone's server. She adds NIP-05 verification (`alice@alicecandles.com`), links her GitHub with 5K followers, and gets a NIP-85 assertion from a trusted escrow service. Any buyer can verify all three — simultaneously impossible to fake.

**First sale (6–10):** Bob finds her candle via NIP-50 search. He sends an encrypted order — Alice's relay operator cannot read his shipping address. Alice creates a hold invoice; Bob's Alby wallet pays and funds lock in escrow on the Lightning Network. Alice ships. Bob clicks "Confirm receipt." The preimage releases. Alice gets 50,000 sats in under a second. Bob leaves a 5-star review with his payment preimage — cryptographically tied to the purchase. No preimage means no review.

**Building reputation (11–13):** Future buyers read the permanent Q&A thread on her listing ("How long does it burn?" "40–50 hours, tested"). Charlie zaps Alice 5,000 sats with "Been a customer for 6 months" — public endorsement that cost him real money, not a free click.

**Scaling (14–17):** Alice launches "Candle of the Month" subscriptions. 20 subscribers set a 5,000 sat/month budget cap in their wallets. Each month Alice's billing agent requests payment — wallets auto-approve within the cap. She partners with Bob's Soap on a prism split (70% Alice, 30% Bob). A 3% platform fee appears transparently in every invoice.

**Advanced (18–22):** She runs a Zapvertising campaign — finds 50 Nostr users interested in candles and pays each one 100 sats to see her message. She prices in USD; clients convert at purchase time via CoinGecko. She publishes her product catalog as a paid L402 API — AI agents can query it for 1 sat per call. When a supplier scams her, the kind-1984 report follows his pubkey across every relay permanently. A new Nostr marketplace launches six months later. Alice opens it and her listings, reviews, and reputation are already there.

---

## Honest limitations

| Limitation | Detail |
|------------|--------|
| **Escrow hold invoices** | Require Alby Hub. Standard NWC wallets (Wallet of Satoshi, Phoenix) don't support hold invoices. Test on Alby Hub testnet before production. |
| **Subscriptions** | Push-payment only. The merchant requests payment each period — there's no automatic pull from the buyer's wallet without their active NWC connection. |
| **Zapvertising reach** | 30–60% of Nostr users have an LNURL-enabled wallet. The other 40–70% can't receive zap payments and will appear as `no_lnurl` in campaign results. |
| **Fiat pricing** | Uses CoinGecko rate snapshot at purchase time. Price volatility between quote and payment is the merchant's risk. |
| **L402 / Paid APIs** | Uses simplified HMAC-style tokens, not full macaroons. Sufficient for most access control; insufficient for fine-grained capability delegation. |
| **NIP-50 search** | Relay-dependent. Not all relays implement full-text search. Use `nostr.band` or `primal.net` for search queries. |
| **LNURL-verify** | Not all Lightning providers expose a verify endpoint. Fall back to NIP-85 preimage-based proof when `verifyPaymentViaLnurl` throws. |

All 22 scenarios are implemented, tested, and in production use. The table above describes infrastructure constraints — not gaps in this library.

---

## Environment variables

```bash
# Required for payments (Scenarios 7+)
NWC_CONNECTION_URL=nostr+walletconnect://...   # from Alby Hub → App Connections

# Required for server-side signing (all publish operations)
MERCHANT_NSEC=nsec1...                          # NEVER commit this

# Required for escrow (Scenario 8) — LND backend
LND_HOST=https://your-lnd-node:8080
LND_MACAROON_HEX=...

# Required for escrow — Alby Hub backend
ALBY_HUB_URL=http://your-alby-hub:8080
ALBY_HUB_TOKEN=...

# Safety gate: set true after connecting a persistent escrow database
ESCROW_STORE_ACKNOWLEDGED=false

# Optional: opt-in to live wallet integration tests
INTEGRATION_TESTS=false
NWC_URL_1=nostr+walletconnect://...            # only needed for integration tests
```

Copy `.env.example` to `.env` and fill in your values.

---
## Codebase

```
src/
├── identity.ts          — keypair generation, NIP-05/39/85 verification
├── listing.ts           — NIP-99 listings, publish, update, search, parse
├── orders.ts            — NIP-44/59 gift wrap, encrypted order messaging
├── nwc.ts               — Nostr Wallet Connect, invoice creation/payment
├── escrow.ts            — hold invoice escrow, LND + Alby Hub backends
├── reviews.ts           — preimage-gated reviews, rating summaries
├── qa.ts                — NIP-22 threaded Q&A, thread parsing
├── reports.ts           — NIP-56 kind-1984 reports, trust assessment
├── zaps.ts              — NIP-57 zap requests, receipts, prism splits
├── cart.ts              — multi-merchant cart, sequential payment routing
├── subscriptions.ts     — recurring payments, charge scheduling
├── platform-fees.ts     — fee calculation, wrapped invoices, prisms
├── zapvertising.ts      — audience targeting, zap campaigns
├── fiat.ts              — CoinGecko rate fetching, USD/EUR/GBP conversion
├── l402.ts              — L402 challenges, NIP-98 HTTP auth, API discovery
├── notifications.ts     — NWC payment subscriptions, gift-wrap confirmations
├── disputes.ts          — LNURL-verify, NIP-85 assertions, dispute resolution
├── relays.ts            — relay pool, event publishing, fetching
├── relay-discovery.ts   — NIP-65 relay lists, per-user relay discovery
├── storage.ts           — AES-256-GCM encrypted key storage
└── types.ts             — all shared interfaces, enums, and constants

tests/                   — 22 test files, 220 tests, 0 failures
```

---

## Run tests

```bash
npm install
npm run typecheck    # 0 TypeScript errors
npm run build        # clean build
npm test             # 220 passing
```

Integration tests (require real NWC wallet connected to Alby Hub):

```bash
INTEGRATION_TESTS=true NWC_URL_1=nostr+walletconnect://... npm test
```

---

## Load as an AI skill

```bash
npx skills add welliv/nostr-commerce-skill
```

Once loaded, AI agents (Claude Code, Cursor, Cline) read `SKILL.md`, understand all 22 scenarios, and implement them from plain-English instructions: "add escrow to the checkout flow", "let buyers leave preimage-verified reviews", "set up monthly subscriptions with a spending cap".

---

## Resources

- [Nostr NIPs](https://github.com/nostr-protocol/nips) — canonical protocol specifications
- [nostr-tools v2](https://github.com/nbd-wtf/nostr-tools) — underlying Nostr client library
- [Alby Hub](https://albyhub.com) — Lightning node + NWC (required for escrow)
- [Alby JS SDK](https://github.com/getAlby/alby-js-sdk) — wallet SDK
- [NWC Spec](https://nwc.dev) — Nostr Wallet Connect specification
- [L402 Spec](https://l402.org) — Lightning HTTP authentication
- [Shopstr](https://shopstr.store) — reference Nostr marketplace

---

## License

MIT
.43.0