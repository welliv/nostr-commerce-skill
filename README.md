# nostr-commerce-skill

TypeScript library implementing all 22 Nostr commerce scenarios — identity, listings, Lightning payments, escrow, reviews, subscriptions, multi merchant carts, and dispute resolution.

Also works as an AI skill for Claude Code, Cursor, and Gemini CLI: give the agent a plain-English instruction and it maps it to the right NIPs, analyses your codebase, and implements it.

```bash
npm install nostr-commerce-skill

---

## The problem

Nostr commerce spans 22 NIPs. Listings, payments, escrow, reviews, and reputation each use different protocols. This library implements all of them in one coherent TypeScript API.

Traditional marketplaces (Amazon, eBay) own everything — your account, your reviews, your reputation. If they ban you or shut down, it's gone.

On Nostr, your identity is a keypair, your listings are signed events on relays, and your payments run peer to peer over Lightning. No platform controls any of it.

---

## 22 scenarios

### Foundation

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 1 | Identity | Keypair identity — no email, no KYC. Portable across every Nostr client forever. | NIP-01, 07, 19 |
| 2 | Listings | Products as signed events. Only you can update or delete them. | NIP-99, 15 |
| 3 | Expiration | Auto-expire listings at a timestamp — enforced at relay level, not a cron job. | NIP-40 |
| 4 | Discovery | Full-text search across relays. No algorithm, no sponsored results. | NIP-50 |
| 5 | Verification | Multi-signal trust: DNS (NIP-05), social accounts (NIP-39), third party assertions (NIP-85). | NIP-05, 39, 85 |

### Commerce

| # | Scenario | What it does | NIPs |
|---|----------|--------------|------|
| 6 | Encrypted Orders | Three-layer NIP-59 gift wrap. Relay operators cannot read buyer address or items. | NIP-17, 44, 59 |
| 7 | Direct Payment | Lightning via NWC. Marketplace never holds funds. Settles in under a second. | NIP-47 |
| 8 | Escrow | Funds locked until delivery. Auto-refunds at NIP-40 deadline. No middleman. | NIP-47, 40 |
| 9 | Proof of Payment | SHA-256(preimage) == paymentHash. Cryptographic, permanent, unforgeable. | NIP-85 |
| 10 | Reviews | Preimage required. Fake reviews are structurally impossible. | NIP-32 kind 1985 (breaking: was 31990) |
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
| 19 | Fiat Conversion | List in USD/EUR, pay in sats at real time CoinGecko rate. | NIP-99 |
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

## Music License Link

An artist publishes a price and the exact licence text for one use of a track (sync in an online video, AI training, remix, or membership), signed with their Nostr key. Any app, fan or AI agent can find the offer, pay it over HTTP 402 with Lightning, and get back a signed licence that anyone can verify. A Bitcoin-anchored timestamp shows the file existed under the artist's key by a date. A platform's settlement agent can do all of this automatically, within limits a human sets.

What it does not do: stop copying, prove authorship or ownership, or replace legal review. It only works where the seller controls both the recording and the composition.

### Run the walkthrough (mock Lightning, no money, no relays)

```bash
npm install
npm run demo:music        # artist publishes → agent discovers → approval → splits + x402 payment → licence → verification → audit log → demo reward plan
npm run mcp:music         # stdio MCP server (demo world): find_license_offers / buy_license / verify_license
npx vitest run tests/x402-lnbtc.test.ts tests/music-license-link.test.ts tests/fan-and-mcp.test.ts
```

The walkthrough uses an in-process mock Lightning network that signs real BOLT11 invoices with test node keys. Payment is simulated by returning the stored preimage. It is "regtest-style": nothing touches a real node. A Polar/regtest integration with real LND or phoenixd nodes is not in this branch yet.

### Status of each part

| Part | File | Status |
|---|---|---|
| Strict BOLT11 decode + signature recovery | `src/bolt11-strict.ts` | Done. Reproduces the x402 spec's test invoice byte for byte |
| x402 `exact`/`lnbtc` (server challenge, client payment, facilitator `/settle`, paid-but-expired grace, replay store) | `src/x402-lnbtc.ts` | Done against the merged spec `specs/schemes/exact/scheme_exact_lnbtc.md`. All HTTP and MCP request-hash vectors reproduce. Concurrent-claim case passes. **Not yet run against a real node.** The official TS mechanism (x402 PR #3688) was unmerged when written; names follow the spec text |
| Durable replay store | `FileReplayStore` | Done (one file per key, O_EXCL atomic create, survives restart). Single host only; multi-instance needs a shared DB with a UNIQUE key. `InMemoryReplayStore` is for tests and is **not** spec-compliant |
| L402 | `src/l402.ts` | Kept alongside, unchanged |
| Licence offer | `src/license.ts` | Done. NIP-99 kind 30402 (standard). Tags `license`, `terms`, `terms-text`, `pay-link` are **PROPOSED** |
| Licence grant (signed receipt) + signer authorization | `src/license.ts` | Done. Kinds **3402 and 3403 are PROPOSED, unregistered placeholders** |
| Third-party verifier | `verifyLicense()` | Done. Checks signatures, signer authority, offer, terms hash, track hash, anchor time, invoice decode, payee = artist's bound node, amount, network, preimage, request binding, splits. States its limits (cannot detect self-dealing) |
| Lightning node binding | `buildPayToBinding()` | Kind 10133 (NIP-A3, **draft**); type value `lightning-node` is **PROPOSED** |
| Pay link (artist server) | `src/license-server.ts` | Done in-process (pure handler). Not deployed. No HTTP framework wired |
| Proof of release | `src/proof-of-release.ts` | Done. NIP-94 kind 1063 (`ox` = master hash), OpenTimestamps stamp (live calendar submission tested once manually), our own Bitcoin header check via Esplora (injectable), optional NIP-03 kind 1040. `opentimestamps` npm 0.4.9 is **effectively unmaintained** (last release 2021/22); it is pinned and wrapped behind `OtsBackend`. NIP-03 is flagged as needing an update, so the `.ots` file is the primary artifact |
| Platform settlement agent | `src/settlement-agent.ts` | Done with mocks. Discovery, allowlists (artist, terms hash, use, network), per-licence and daily caps, human-approval rules, kill switch (`<dataDir>/KILL` or `SETTLEMENT_KILL=1`, checked before every payment), rate limit, splits as **separate, non-atomic** payments, licence verification, evidence bundle. Mirror the daily cap as an NWC wallet budget in production |
| Signed audit log | `src/audit-log.ts` | Done. Hash-chained JSONL, Schnorr-signed, refuses preimage fields. Daily OTS anchoring of the head hash is not automated yet |
| MCP buyer tool | `src/mcp-buyer.ts`, `src/bin/music-license-mcp.ts` | Done, tested over the SDK in-memory transport. The bin runs the **demo world only** |
| Fan identity v1 | `src/fan.ts` | Done. Fan keys, fan-signed agent budget authorization (**PROPOSED** 3405), private supporter record gift-wrapped to self (**PROPOSED** 3406 via NIP-59), platform listening attestation (**PROPOSED** 3404, distinct days only). **Reward runner is a labelled DEMO**: only after the period closes, capped per fan, disclosed, never per listen |
| Blossom upload + audio encryption | — | Not started |
| NIP-46 / subkey licence signer in production | — | Design only. The demo uses a separate signing key authorized by the artist (3403) |

### What a real sale still needs

A funded payer wallet (NWC that returns preimages), an artist receiver node that can make invoices with a caller-supplied description hash and is exclusive to the pay link (Alby Hub self-hosted, phoenixd or LND; description-hash support needs testing), a deployed pay link, a lawyer-reviewed licence text, and a track the artist fully owns.

## Honest limitations

| Limitation | Detail |
|------------|--------|
| **Escrow hold invoices** | Require Alby Hub. Standard NWC wallets don't support them. |
| **Subscriptions** | Push-payment only. Merchant requests each period — no automatic pull. |
| **Zapvertising reach** | ~40–60% of Nostr users have LNURL-capable wallets. Handle `no_lnurl` gracefully. |
| **Fiat pricing** | CoinGecko rate at purchase time. Volatility between quote and payment is merchant's risk. |
| **L402 tokens** | HMAC-SHA256 over (payment hash, resource, expiry) with `L402_SECRET`; resource + expiry caveats; single-use. Not full macaroons; no delegation. |
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
# 23 test files · 253 tests · 0 failures

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
## Breaking changes in v3.0.0 (step1-fixes)

- **L402 tokens are now HMAC-signed.** `createL402Challenge(wallet, msats, desc, { resource, ttlSeconds?, secret? })` mints `base64url(payload).hmac` where the payload binds payment hash, resource and expiry (with `resource=` / `expires=` caveats). Set `L402_SECRET` (>= 32 chars) or pass `secret`.
- **`verifyL402Credentials(header, { resource, secret?, usedTokenStore?, now? })`** replaces `verifyL402Credentials(header, wallet)`. It verifies offline: HMAC, caveats, expiry, `SHA256(preimage) === payment_hash`, and single use via a pluggable `UsedTokenStore` (default `InMemoryUsedTokenStore`, single-process only; use Redis/DB when running several instances). Legacy tokens where "macaroon = payment hash" are rejected; clients need no change (they still send `L402 <token>:<preimage>`).
- **BOLT-11 parsing** now uses `light-bolt11-decoder` (MIT) instead of reading the last 64 characters. Invalid invoices throw. The decoder does not verify the invoice signature.
- **Reviews** are published as NIP-32 label events (kind 1985, namespace `commerce.review`) instead of kind 31990 (NIP-89 handler info). Reviews published under 31990 are no longer fetched.
- **`.well-known`** paths for NIP-05 and Lightning addresses fixed (they contained a space and failed in production).
