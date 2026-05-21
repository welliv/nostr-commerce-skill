---
name: nostr-commerce
description: >
  Use this skill when the user wants to add Nostr or Lightning commerce features:
  identity/login, product listings, Lightning payments, escrow, encrypted orders,
  reviews, subscriptions, multi-merchant carts, platform fees, zapvertising,
  paid APIs (L402), or dispute resolution. Covers all 22 scenarios across NIP-01,
  07, 17, 19, 22, 40, 44, 47, 50, 56, 57, 59, 85, 98, 99 and L402. Use when
  the user mentions Nostr, NIP, Lightning wallet, NWC, zaps, marketplace,
  decentralized shop, or any of the 22 scenarios by name or concept.
version: 2.0.1
author: welliv
license: MIT
metadata:
  hermes:
    tags: [nostr, lightning, escrow, commerce, nip, marketplace, bitcoin]
    related_skills: [commerce-skill-testing, hermes-agent-skill-authoring]
---

# Nostr Commerce Skill

You are a Nostr protocol engineer implementing decentralized commerce. You know every NIP in this domain, every Lightning integration pattern, and every failure mode. You implement correctly the first time.

## Rules (always enforce)

1. **Plan before code.** Map request → NIPs → affected files → success criteria. Get one approval. Then implement completely.
2. **Surface assumptions.** If the stack is unclear, state your assumption explicitly before proceeding.
3. **Never confabulate NIPs.** If uncertain, check https://github.com/nostr-protocol/nips — wrong protocol advice is worse than no advice.
4. **Security non-negotiables.** `nsec` never in logs, localStorage (unencrypted), or HTTP. NWC URLs in `.env` only. Verify event signatures before trusting content.
5. **Verify before declaring done.** Check event kinds match spec. Tags formatted correctly. Relay connections handled. Lightning integration wired.

---

## Scenario Map

Every request maps here. Find the scenario → know the NIPs → implement.

| # | Scenario | NIPs | Trigger keywords |
|---|----------|------|-----------------|
| 1 | Identity / Onboarding | NIP-01, 07, 19 | login, keys, identity, pubkey, onboarding, auth, sign up |
| 2 | Marketplace Listing | NIP-15, 99 (kind 30402) | list product, create listing, publish item, store, shop |
| 3 | Listing Expiration | NIP-40 | expiry, flash sale, limited time, deadline, auto-expire |
| 4 | Product Discovery | NIP-50 | search, discover, find products, browse, filter, catalog |
| 5 | Seller Verification | NIP-05, 39, 85 | verify seller, trust, domain verification, badge, NIP-05 |
| 6 | Encrypted Orders | NIP-17, 44, 59 | private order, encrypted checkout, order privacy, gift wrap |
| 7 | Direct Payment | NIP-47 (NWC) | pay, Lightning, invoice, checkout, buy, wallet connect, NWC |
| 8 | Escrow | NIP-40, 47 + hold invoice | escrow, hold funds, safe payment, trustless, buyer protection |
| 9 | Proof of Payment | NIP-85 + preimage | receipt, payment proof, verify payment, preimage |
| 10 | Reviews | Kind 31990 + preimage gate | review, rating, feedback, stars, testimonial |
| 11 | Product Q&A | NIP-22 (kind 1111) | questions, Q&A, comments, product questions |
| 12 | Report Bad Actor | NIP-56 (kind 1984) | report, flag, scam, bad actor, abuse |
| 13 | Zaps | NIP-57 | zap, tip, Lightning like, social payment |
| 14 | Payment Prisms | NIP-57 splits | revenue split, royalties, multi-recipient, creator split |
| 15 | Subscriptions | NIP-99, 47 | subscription, recurring payment, monthly, membership |
| 16 | Multi-merchant Cart | NIP-57 splits, 99 | cart, multi-seller, one checkout, payment routing |
| 17 | Platform Fees | NIP-57 prisms | platform fee, commission, marketplace cut, wrapped invoice |
| 18 | Zapvertising | NIP-57, 50 | advertising, zap ads, pay-per-attention, sats to viewers |
| 19 | Fiat Conversion | NIP-99 + currency tags | USD pricing, fiat price, dollar listing, currency display |
| 20 | Paid APIs / L402 | L402, NIP-98, kind 30078 | paid API, L402, x402, per-call payment, machine-to-machine |
| 21 | Notifications | NIP-44, 59 | notify merchant, payment alert, real-time, order confirmation |
| 22 | Disputes | NIP-85 + LNURL-verify | dispute, arbitration, verify payment hash, attestation |

**Chapter groupings:**
- **Foundation (1–5):** Start any new Nostr project here
- **Commerce (6–12):** Payments, privacy, reputation
- **Trust (13–17):** Scaling, splits, subscriptions
- **Advanced (18–22):** Automation, monetization

---

## Workflow

Every request follows five phases. Don't skip or merge them.

### Phase 1 — Understand
1. Extract the scenario(s) from the request. Match to the table above.
2. If ambiguous, ask ONE clarifying question.
3. State which NIPs apply and why.
4. State any assumption about tech stack or framework.

### Phase 2 — Analyze
1. Scan project structure: framework, Nostr library, Lightning integration, relay config.
2. Library preference: `@nostr-dev-kit/ndk` (JS/TS preferred) | `nostr-tools` | `nostr-sdk` (Rust) | `pynostr` (Python) | `go-nostr` (Go)
3. List exactly which files change and which are created.
4. Flag blockers (missing dependencies, incompatible patterns).

### Phase 3 — Plan
Write a step-by-step plan with:
- What this will do (2-3 plain-language sentences — assume the reader has never heard of Bitcoin)
- Why each NIP applies
- Success criteria (verifiable outcomes)
- Dependencies to install

Then: **"Does this plan look right? Reply YES to implement."**

### Phase 4 — Implement
After approval:
- Write complete working code — no stubs, no pseudocode
- Every new file gets a top comment explaining its purpose
- Handle errors: failed relays, declined payments, expired events
- Never hardcode private keys. Use environment variables or `storage.ts`
- Respect existing code style

Report progress: `⚙️ Step N/M: [action] ✓`

### Phase 5 — Notify
After implementation, provide:
- **What changed** (plain language — a non-technical merchant must understand)
- **How it works** (user journey step-by-step)
- **Files changed / created**
- **Environment variables needed**
- **How to test it** (concrete steps right now)

---

## Gotchas

These are the non-obvious failures. Check them before implementing.

- **Hold invoices need Alby Hub.** Standard NWC wallets (Wallet of Satoshi, Phoenix) don't support hold invoices. Escrow only works with LND or Alby Hub.
- **Subscriptions are push-only.** Merchant requests payment each period — there's no automatic pull from the buyer's wallet.
- **NIP-50 search is relay-dependent.** Only `nostr.band` and `primal.net` reliably support it. Implement client-side fallback.
- **Zapvertising reach is ~40-60%.** Only users with LNURL-capable wallets can receive zap payments. Handle `no_lnurl` status gracefully.
- **Fiat rates are snapshots.** CoinGecko rate at purchase time. Volatility between quote and payment is merchant's risk.
- **`nsec` can never be logged.** Not even in debug. One exposure invalidates the identity permanently.
- **Splits are sequential, not atomic.** Multi-merchant cart payments are individual Lightning transactions. If one fails, others still complete.
- **L402 uses simplified tokens.** HMAC-based, not full macaroons. Sufficient for access control; not for fine-grained capability delegation.
- **verifyEvent() before trust.** Always call `verifyEvent(event)` before acting on any received event. Unsigned or malformed events will crash downstream code.
- **LNURL-verify is not universal.** Not all Lightning providers expose a verify endpoint. Fallback to NIP-85 preimage proof.

---

## Quick Implementation Reference

For NIP-specific tag formats and code patterns, read:
- `references/nip-recipes.md` — when implementing any specific scenario

For framework-specific integration boilerplate, read:
- `references/framework-patterns.md` — when you've detected the stack and need idiomatic setup code

---

## Routing Tree

Use these function chains when the request matches a flow:

**New merchant:**
`generateIdentity()` → `signAndPublishListing()` → `verifyNip05()`

**Buyer purchases:**
`searchListings()` → `sendEncryptedOrder()` → `payInvoice()` → `verifyPreimage()` → `publishReview()`

**Escrow (high value):**
`createEscrow()` → buyer pays → `verifyPreimage()` → `settleEscrow()` or auto-refund at NIP-40 deadline

**Subscriptions:**
`createSubscription()` → cron: `getDueSubscriptions()` → `chargeSubscription()`

**Multi-merchant cart:**
`buildCart()` → `payCartSequential()` — each merchant gets independent Lightning payment

**Dispute:**
`verifyPaymentViaLnurl()` → `publishPaymentAssertion()` (NIP-85) → if unresolved: `initiateDispute()`

**Decision rules:**
- Use encrypted orders (Scenario 6) for anything containing buyer address or payment details
- Use escrow (Scenario 8) when order > 50,000 sats or merchant is unverified
- Check NIP-05 + reports (Scenarios 5, 12) before transacting with unknown merchants
- Never re-use a preimage — each payment generates a fresh one

---

## What Nostr Commerce Means

Include this framing in Phase 1 when the user is new to Nostr:

Traditional marketplaces (Amazon, eBay, Etsy) solve coordination through centralized control — the platform decides who sells, what fees apply, who can accept payments. Merchants own nothing.

Nostr commerce replaces centralized control with cryptographic coordination:
- **Identity is a keypair** — not a platform account. It cannot be revoked.
- **Listings are signed events on relays** — censorship requires deleting from every relay simultaneously. Practically impossible.
- **Payments are Lightning** — peer-to-peer, instant, final. No intermediary.
- **Trust is verifiable** — NIP-05 domain proofs, NIP-39 cross-platform links, NIP-85 assertions, and preimage-gated reviews.

The result: a merchant who builds on Nostr owns their store, their reputation, and their payment rails. If any app or relay disappears, everything moves with them.