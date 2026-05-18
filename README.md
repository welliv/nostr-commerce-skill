# nostr-commerce-skill

A TypeScript library and AI skill that lets agents build real commerce on Nostr. It covers identity, listings, Lightning payments, escrow, reviews, subscriptions, carts, fees, and disputes across 22 scenarios.

## What this solves

Nostr commerce touches 20+ different NIPs. Listings, payments, escrow, reviews, and enforcement all use separate protocols. Most developers only know a few of them.

Traditional platforms keep everything in one place. Amazon controls who can sell. Stripe controls payments. The merchant ends up owning nothing. When the platform disappears, the store disappears too.

This library gives agents the full set of tools. Tell an agent what you want — "add Lightning checkout", "support buyer reviews", "handle recurring payments" — and it can map the request to the right NIPs and implement it.

## Install

```bash
# Use it as a library
npm install nostr-commerce-skill

# Or load it as a skill for Claude Code, Cursor, or similar tools
npx skills add welliv/nostr-commerce-skill
```

## What's included

| #  | Scenario                    | NIPs                        | Status |
|----|-----------------------------|-----------------------------|--------|
| 1  | Identity & Onboarding       | NIP-01, 07, 19              | ✅     |
| 2  | Marketplace Listings        | NIP-99 (kind 30402)         | ✅     |
| 3  | Listing Expiration          | NIP-40                      | ✅     |
| 4  | Product Discovery           | NIP-50                      | ✅     |
| 5  | Seller Verification         | NIP-05, 39, 85              | ✅     |
| 6  | Encrypted Orders            | NIP-44, 59, 17              | ✅     |
| 7  | Direct Payment              | NIP-47 (NWC)                | ✅     |
| 8  | Escrow                      | Hold invoice + NIP-40       | ✅     |
| 9  | Proof of Payment            | NIP-85 + preimage           | ✅     |
| 10 | Reviews                     | Kind 31990 + preimage gate  | ✅     |
| 11 | Product Q&A                 | NIP-22                      | ✅     |
| 12 | Report Bad Actor            | NIP-56                      | ✅     |
| 13 | Zaps                        | NIP-57                      | ✅     |
| 14 | Payment Prisms              | NIP-57 + splits             | ✅     |
| 15 | Subscriptions               | NIP-99, NIP-47              | ✅     |
| 16 | Multi-merchant Cart         | NIP-57 splits, NIP-99       | ✅     |
| 17 | Platform Fees               | NIP-57 prisms               | ✅     |
| 18 | Zapvertising                | NIP-50 + NIP-57             | ✅     |
| 19 | Fiat Conversion             | CoinGecko + kind 30402      | ✅     |
| 20 | Paid APIs (L402)            | NIP-98, kind 30078          | ✅     |
| 21 | Payment Notifications       | NWC + NIP-59                | ✅     |
| 22 | Disputes + LNURL-Verify     | NIP-85, LNURL-Verify        | ✅     |

## Quick start

### Create an identity

```typescript
import { generateIdentity, hasNip07Signer, getNip07Pubkey } from 'nostr-commerce-skill';

// Browser: use Alby, nos2x, or Flamingo
if (hasNip07Signer()) {
  const pubkey = await getNip07Pubkey();
}

// Node.js: generate a new key
const identity = generateIdentity();
// Store identity.privateKey with saveIdentityToFile()
// Never log it or commit it
```

### Save and load keys securely

```typescript
import { saveIdentityToFile, loadIdentityFromFile } from 'nostr-commerce-skill';

// Save with AES-256-GCM encryption
await saveIdentityToFile(identity, 'strong-password', './merchant-key.json');

// Load it back
const identity = await loadIdentityFromFile('./merchant-key.json', 'strong-password');
```

## Honest Limitations (read before production use)

These constraints are real and affect what you can ship today:

- **NWC hold invoices** (escrow) require Alby Hub. Standard NWC wallets do not support hold invoices.
- **Subscriptions** are push-payment only. There is no automatic pull model yet.
- **Zapvertising** (pay-per-view) has 30–60% LNURL coverage depending on the audience's wallets.
- **Fiat pricing** uses CoinGecko snapshots. Volatility between quote and settlement is the merchant's risk.
- **L402 / Paid APIs** currently use a simplified HMAC token, not full macaroons.

All 22 scenarios are implemented and tested, but the above points determine whether a given use-case is production-ready today.
