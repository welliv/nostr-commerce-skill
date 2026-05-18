# nostr-commerce-skill

An agentic AI skill and TypeScript library for building Nostr-native commerce — identity, listings, Lightning payments, escrow, reviews, Q&A, and reports across 14 fully-implemented scenarios.

---

## The problem it solves

Nostr commerce is split across 20+ NIPs. Product listings, payments, escrow, reviews, and enforcement each involve different protocols. Nobody can hold the full picture in their head.

Traditional marketplaces solve coordination through centralized control: Amazon decides who sells, Stripe decides who accepts payments, eBay decides what fees to charge. The merchant owns nothing. If the platform disappears, their store disappears with it.

This skill makes the decentralized alternative executable. Give an AI agent (Claude Code, Cursor, Cline) a natural-language instruction — "add Nostr login", "implement Lightning payments", "enable buyer reviews" — and it maps the request to the correct NIPs, analyzes your codebase, proposes a plan, waits for your approval, and implements it.

---

## Install

```bash
# As a library in your project
npm install nostr-commerce-skill

# As an AI skill (Claude Code, Cursor, Cline, Windsurf)
npx skills add <your-github-username>/nostr-commerce-skill
```

---

## What's implemented

| # | Scenario | NIPs | Status |
|---|----------|------|--------|
| 1 | Identity & Onboarding | NIP-01, 07, 19 | ✅ |
| 2 | Marketplace Listings | NIP-99 (kind 30402) | ✅ |
| 3 | Listing Expiration | NIP-40 | ✅ |
| 4 | Product Discovery | NIP-50 | ✅ |
| 5 | Seller Verification | NIP-05, 39, 85 | ✅ |
| 6 | Encrypted Orders | NIP-44, 59, 17 | ✅ |
| 7 | Direct Payment | NIP-47 (NWC) | ✅ |
| 8 | Escrow | Hold invoice + NIP-40 | ✅ (LND + Alby Hub) |
| 9 | Proof of Payment | NIP-85 + preimage | ✅ |
| 10 | Reviews | Kind 31990 + preimage gate | ✅ |
| 11 | Product Q&A | NIP-22 | ✅ |
| 12 | Report Bad Actor | NIP-56 | ✅ |
| 13 | Zaps | NIP-57 | ✅ |
| 14 | Payment Prisms | NIP-57 + splits | ✅ |
| 15–22 | Subscriptions, forwarding, fees, ads, paid APIs, notifications | — | 🗺️ v2 roadmap |

---

## Quick start

### Identity (Scenario 1)

```typescript
import { generateIdentity, hasNip07Signer, getNip07Pubkey } from 'nostr-commerce-skill';

// Browser: sign with Alby, nos2x, or Flamingo extension
if (hasNip07Signer()) {
  const pubkey = await getNip07Pubkey();
}

// Server / Node.js: generate a keypair
const identity = generateIdentity();
// SECURITY: store identity.privateKey with saveIdentityToFile()
// Never log it, never hardcode it, never commit it
```

### Secure Key Storage

```typescript
import { saveIdentityToFile, loadIdentityFromFile } from 'nostr-commerce-skill';

// Save (AES-256-GCM encrypted with your password)
await saveIdentityToFile(identity, 'strong-password', './merchant-key.json');

// Load
const identity = await loadIdentityFromFile('./merchant-key.json', 'strong-password');
```

### Publish a Listing (Scenarios 2, 3, 19)

```typescript
import { signAndPublishListing } from 'nostr-commerce-skill';

const result = await signAndPublishListing(
  {
    dTag: 'candle-001',             // stable ID — reuse to update the listing
    title: 'Beeswax Candle',
    summary: '40-hour burn, honey scent',
    content: '## About\n\nHandmade in small batches...',
    price: { amount: '25.00', currency: 'USD' },
    type: 'physical',
    images: ['https://example.com/candle.jpg'],
    categories: ['candles', 'handmade'],
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400, // NIP-40: 30 days
  },
  privateKey
);

console.log('Event ID:', result.eventId);
console.log('Share this:', result.shareableLink); // naddr1... — works in any Nostr client
```

### Accept Lightning Payments (Scenario 7)

```typescript
import { createWalletFromEnv } from 'nostr-commerce-skill';

// Requires NWC_CONNECTION_URL in .env
// Get from: Alby Hub → App Connections → New Connection (set a budget first)
const wallet = createWalletFromEnv();
await wallet.connect();

const invoice = await wallet.createInvoice({
  amountMsats: 25_000,
  description: 'Order #123',
});

// After buyer pays — store preimage for proof-of-payment
const lookup = await wallet.lookupInvoice(invoice.paymentHash);
if (lookup.paid) {
  console.log('Preimage:', lookup.preimage); // store this
}
```

### Escrow (Scenario 8)

```typescript
import {
  createEscrow,
  waitForPayment,
  releaseEscrow,
  LndEscrowBackend,
} from 'nostr-commerce-skill';

const backend = new LndEscrowBackend({
  host: process.env.LND_HOST!,
  macaroon: process.env.LND_MACAROON_HEX!,
});

// Step 1: Create hold invoice
const session = await createEscrow(
  { amountMsats: 25_000, orderId: 'order-123',
    buyerPubkey: buyer.pubkey, sellerPubkey: merchant.pubkey },
  wallet
);
// → send session.invoice to buyer

// Step 2: Wait for payment (exponential backoff polling)
const funded = await waitForPayment('order-123', wallet, {
  onStatusChange: (s) => console.log('Status:', s),
});

// Step 3: Ship goods, then release
if (funded.status === 'funded') {
  await releaseEscrow('order-123', backend);
}
```

### Encrypted Orders (Scenario 6)

```typescript
import { sendEncryptedOrder, decryptIncomingOrder } from 'nostr-commerce-skill';

// Buyer sends order — relay cannot read it
await sendEncryptedOrder(
  { id: 'order-123', type: 0,
    items: [{ productId: 'candle-001', quantity: 2 }],
    contact: { nostr: buyer.pubkey },
    address: '123 Main St' },
  buyerPrivkey,
  merchantPubkey
);

// Merchant decrypts
const { order, buyerPubkey } = decryptIncomingOrder(wrapEvent, merchantPrivkey);
```

### Reviews (Scenario 10)

```typescript
import { publishReview, fetchVerifiedReviews } from 'nostr-commerce-skill';

// Buyer posts a review — preimage proves they actually paid
await publishReview(
  { subject: merchantPubkey, subjectType: 'pubkey',
    rating: 5, content: 'Fast shipping, beautiful candle.',
    preimage: paymentPreimage,       // from wallet after payment
    paymentHash: invoice.paymentHash,
    listingEventId: listing.eventId },
  buyerPrivkey
);

// Fetch and cryptographically verify
const reviews = await fetchVerifiedReviews(merchantPubkey, 'pubkey');
console.log(reviews.filter(r => r.isVerified)); // only real buyers
```

### Zaps + Revenue Splits (Scenarios 13, 14)

```typescript
import { requestZapInvoice, buildPrism } from 'nostr-commerce-skill';

// 97% to seller, 3% to platform — split at payment time, no custody
const recipients = buildPrism(
  { pubkey: sellerPubkey, percentage: 97 },
  { pubkey: platformPubkey, percentage: 3 },
);

const { invoice } = await requestZapInvoice(
  { recipients, amountMsats: 10_000, relays: ['wss://relay.damus.io'] },
  buyerPrivkey,
  sellerLnurlEndpoint
);
```

### Product Q&A (Scenario 11)

```typescript
import { postQuestion, postAnswer, fetchQAThread, buildQAThreads } from 'nostr-commerce-skill';

await postQuestion(
  { listingEventId: listing.eventId,
    listingAuthorPubkey: merchant.pubkey,
    question: 'Does this candle work outdoors?' },
  buyerPrivkey
);

const events = await fetchQAThread(listing.eventId);
const threads = buildQAThreads(parseQAThread(events));
// → [{ question: {...}, answers: [{...}] }]
```

### Report Bad Actor (Scenario 12)

```typescript
import { publishReport, assessPubkeyTrust } from 'nostr-commerce-skill';

await publishReport(
  { reportedPubkey: scammerPubkey, reason: 'scam',
    comment: 'Took payment, never delivered.',
    evidenceEventId: orderEventId },
  reporterPrivkey
);

const trust = await assessPubkeyTrust(pubkey);
console.log(`Risk score: ${trust.riskScore}/10`); // 0 = trusted, 10 = investigate
```

---

## Environment variables

```bash
# Required for payments (Scenario 7+)
NWC_CONNECTION_URL=nostr+walletconnect://...   # from Alby Hub

# Required for server-side signing
MERCHANT_NSEC=nsec1...                          # never commit this

# Required for escrow (Scenario 8) — LND backend
LND_HOST=https://your-lnd-node:8080
LND_MACAROON_HEX=...

# Safety: set true after connecting a persistent escrow database
ESCROW_STORE_ACKNOWLEDGED=false
```

Copy `.env.example` to `.env` and fill in your values.

---

## NIP-65 Relay Discovery

This library uses NIP-65 relay lists (kind 10002) to find users' preferred relays, rather than hardcoding defaults. This means events actually reach their intended recipients.

```typescript
import { getRelaysForUser, fetchUserRelays } from 'nostr-commerce-skill';

// Send a message to merchant — uses their preferred write relays
const relays = await getRelaysForUser(merchantPubkey);
await publishToRelays(event, relays);
```

---

## Honest limitations

**Relay reliability:** Relay uptime varies. Always publish to 3+ relays. Use `filterReachableRelays()` before critical operations.

**Kind 31990 reviews:** The use of kind 31990 for reviews is a Shopstr/community convention — it is not a finalized NIP. Some clients may not display these reviews.

**Hold invoices (escrow):** Require a real Lightning node (LND or CLN) or Alby Hub with node access. Custodial wallets (Wallet of Satoshi, etc.) do not support hold invoice settlement.

**Key management:** Non-technical users must manage private keys. Use the `storage.ts` module (`saveIdentityEncrypted`, `loadIdentityDecrypted`) to protect keys with a password. A lost key means a lost identity — warn users clearly.

**Self-reviews:** A merchant can review their own products by paying themselves. The `isSuspect` flag in `ParsedReview` identifies cases where the reviewer pubkey matches the listing author — surface this in your UI.

**Scenarios 15–22:** Subscriptions, payment forwarding, platform fees, zapvertising, paid APIs, payment notifications, and LNURL-Verify are on the v2 roadmap. They are not implemented in this release.

---

## Resources

- [Nostr NIPs](https://github.com/nostr-protocol/nips)
- [nostr-tools v2](https://github.com/nbd-wtf/nostr-tools)
- [Alby Hub](https://albyhub.com) — Lightning node + NWC
- [Alby SDK](https://github.com/getAlby/alby-js-sdk)
- [NWC Spec](https://nwc.dev)
- [Shopstr](https://shopstr.store) — reference Nostr marketplace

---

## License

MIT
