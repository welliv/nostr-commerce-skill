# nostr-commerce-skill

TypeScript library implementing all 22 Nostr commerce scenarios — identity, listings, Lightning payments, escrow, reviews, subscriptions, multi-merchant carts, and dispute resolution.

Also works as an AI skill for Claude Code, Cursor, and Gemini CLI: give the agent a plain-English instruction and it maps it to the right NIPs, analyzes your codebase, and implements it.

```bash
npm install nostr-commerce-skill

---

## The problem

Nostr commerce spans 22 NIPs. Listings, payments, escrow, reviews, and reputation each use different protocols. This library implements all of them in one coherent TypeScript API.

Traditional marketplaces (Amazon, eBay) own everything — your account, your reviews, your reputation. If they ban you or shut down, it's gone.

On Nostr, your identity is a keypair, your listings are signed events on relays, and your payments run peer-to-peer over Lightning. No platform controls any of it.

---

## 22 scenarios

### Foundation

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 1 | Identity | Keypair identity — no email, no KYC. Portable across every Nostr client forever. | NIP-01, 07, 19 |
| 2 | Listings | Products as signed events. Only you can update or delete them. | NIP-99, 15 |
| 3 | Expiration | Auto-expire listings at a timestamp — enforced at relay level, not a cron job. | NIP-40 |
| 4 | Discovery | Full-text search across relays. No algorithm, no sponsored results. | NIP-50 |
| 5 | Verification | Multi-signal trust: DNS (NIP-05), social accounts (NIP-39), third-party assertions (NIP-85). | NIP-05, 39, 85 |

### Commerce

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 6 | Encrypted Orders | Three-layer NIP-59 gift wrap. Relay operators cannot read buyer address or items. | NIP-17, 44, 59 |
| 7 | Direct Payment | Lightning via NWC. Marketplace never holds funds. Settles in under a second. | NIP-47 |
| 8 | Escrow | Funds locked until delivery. Auto-refunds at NIP-40 deadline. No middleman. | NIP-47, 40 |
| 9 | Proof of Payment | SHA-256(preimage) == paymentHash. Cryptographic, permanent, unforgeable. | NIP-85 |
| 10 | Reviews | Preimage required. Fake reviews are structurally impossible. | Kind 31990 |
| 11 | Product Q&A | Threaded comments on listings (NIP-22). Every answer helps all future buyers. | NIP-22 |
| 12 | Report Bad Actor | Kind-1984 reports follow a pubkey permanently across the entire network. | NIP-56 |

### Trust

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 13 | Zaps | Pay to endorse a listing. Real sats = skin-in-the-game social proof. | NIP-57 |
| 14 | Payment Prisms | Split one payment to multiple recipients at payment time. Non-custodial. | NIP-57 splits |
| 15 | Subscriptions | Recurring payments with a buyer-set spending cap. | NIP-99, 47 |
| 16 | Multi-merchant Cart | One checkout, multiple merchants. Sequential Lightning payments. | NIP-57, 99 |
| 17 | Platform Fees | Fee visible in invoice before buyer pays. No hidden extraction. | NIP-57 prisms |

### Advanced

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 18 | Zapvertising | Pay viewers directly to see your ad. Viewers receive real sats. | NIP-57, 50 |
| 19 | Fiat Conversion | List in USD/EUR, pay in sats at real-time CoinGecko rate. | NIP-99 |
| 20 | Paid APIs (L402) | Per-call Lightning payments. AI agents can buy data autonomously. | L402, NIP-98 |
| 21 | Notifications | Encrypted order confirmations via relays. No email, no webhooks. | NIP-44, 59 |
| 22 | Disputes | Cryptographic dispute resolution without seeing either wallet. | NIP-85, LNURL |

---

## Quick start

```typescript
import {
  generateIdentity, signAndPublishListing, searchListings,
  sendEncryptedOrder, NostrWalletConnect, createEscrowWithNWC,
  publishReview, buildCart, payCartSequential,
} from 'nostr-commerce-skill';

// Identity (Scenario 1)
const identity = generateIdentity();
await saveIdentityToFile(identity, 'passphrase', './merchant.json');

// List a product (Scenarios 2, 3)
const listing = await signAndPublishListing({
  dTag: 'lavender-8oz',
  title: 'Lavender Soy Candle',
  summary: '40–50 hour burn',
  content: '## About\n\nHandmade in small batches.',
  price: { amount: '18.00', currency: 'USD' },
  images: ['https://example.com/candle.jpg'],
  expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400, // 30 days
}, identity.privateKey);
console.log(listing.shareableLink); // naddr1... — works in any Nostr client

// Accept a Lightning payment (Scenario 7)
const wallet = new NostrWalletConnect(process.env.NWC_CONNECTION_URL);
await wallet.connect();
const invoice = await wallet.createInvoice({ amountMsats: 50_000, description: 'Order #001' });

// Escrow for high-value orders (Scenario 8)
import { NWCEscrowBackend } from 'nostr-commerce-skill';
const backend = new NWCEscrowBackend(process.env.NWC_CONNECTION_URL);
const escrow = await createEscrowWithNWC({ amountMsats: 50_000, description: 'Order #001' }, backend);
// Buyer pays → funds locked. Merchant ships → confirm → settleEscrow() → paid.

// Preimage-gated review (Scenario 10)
await publishReview({
  listingEventId: listing.eventId,
  rating: 5,
  content: 'Burns beautifully.',
  preimage: payment.preimage,      // proves buyer actually paid
  paymentHash: invoice.paymentHash,
}, buyerPrivkey);

// Multi-merchant cart (Scenario 16)
const cart = buildCart(buyerPubkey, [
  { listingEventId: '...', dTag: 'candle', merchantPubkey: alicePk,
    merchantLud16: 'alice@getalby.com', quantity: 2,
    unitPriceMsats: 18_000, amountMsats: 36_000, title: 'Candle' },
  { listingEventId: '...', dTag: 'soap', merchantPubkey: bobPk,
    merchantLud16: 'bob@getalby.com', quantity: 1,
    unitPriceMsats: 8_000, amountMsats: 8_000, title: 'Soap' },
]);
await payCartSequential(cart, buyerWallet, buyerPrivkey);
```

---

## Honest limitations

| Limitation | Detail |
|------------|--------|
| **Escrow hold invoices** | Require Alby Hub. Standard NWC wallets don't support them. |
| **Subscriptions** | Push-payment only. Merchant requests each period — no automatic pull. |
| **Zapvertising reach** | ~40–60% of Nostr users have LNURL-capable wallets. Handle `no_lnurl` gracefully. |
| **Fiat pricing** | CoinGecko rate at purchase time. Volatility between quote and payment is merchant's risk. |
| **L402 tokens** | HMAC-based, not full macaroons. Sufficient for access control; not capability delegation. |
| **NIP-50 search** | Relay-dependent. Use `nostr.band` or `primal.net`; implement client-side fallback. |

All 22 scenarios are implemented and tested. The table above describes infrastructure constraints.

---

## Environment variables

```bash
NWC_CONNECTION_URL=nostr+walletconnect://...   # from Alby Hub → App Connections
MERCHANT_NSEC=nsec1...                          # NEVER commit this
LND_HOST=https://your-lnd:8080                  # for escrow via LND
LND_MACAROON_HEX=...
ESCROW_STORE_ACKNOWLEDGED=false                 # set true after connecting persistent DB
```

---

## Tests

```bash
npm install && npm run typecheck && npm test
# 22 test files · 220 tests · 0 failures

# Live wallet integration tests (requires Alby Hub):
INTEGRATION_TESTS=true NWC_URL_1=nostr+walletconnect://... npm test
```

---

## Use as an AI skill

```bash
npx skills add welliv/nostr-commerce-skill
```

Then tell your agent: *"Add escrow to the checkout"* or *"Let buyers leave verified reviews"* — the skill maps the request to the right NIPs and implements it in your codebase.

---

## Resources

- [Nostr NIPs](https://github.com/nostr-protocol/nips) · [NWC spec](https://nwc.dev) · [L402](https://l402.org)
- [Alby Hub](https://albyhub.com) · [nostr-tools](https://github.com/nbd-wtf/nostr-tools) · [NDK](https://github.com/nostr-dev-kit/ndk)
- [Shopstr](https://shopstr.store) — reference Nostr marketplace

---

MIT License
