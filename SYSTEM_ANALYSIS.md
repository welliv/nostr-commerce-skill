# NOSTR COMMERCE SKILL — WHOLE SYSTEM ANALYSIS
## Complete Audit · All Layers · First Principles
**Date:** May 2026 | **Scope:** All source files, v1 + v2 + fixes + SKILL.md

---

## EXECUTIVE SUMMARY

4,023 lines of v1 TypeScript + 2,291 lines of v2 across 22 source modules.
The core architecture is sound. The v1 bug fixes (BUG-01 through BUG-09)
held through v2. No circular dependencies. No private key leakage.

**4 critical issues** require fixing before the next `npm publish`.
**6 serious issues** require fixing before production use with real funds.
**5 minor issues** are improvements that matter for scale.

The build is solid but not shippable in its current state due to C3:
duplicate type definitions in types.ts would cause a TypeScript build failure.

---

## LAYER 1: ARCHITECTURE

### Dependency Graph (verified clean)

```
types.ts          ← no imports (foundation)
relays.ts         ← types.ts only
identity.ts       ← relays.ts, types.ts
storage.ts        ← identity.ts, types.ts
relay-discovery.ts← relays.ts, types.ts
nwc.ts            ← types.ts only
listing.ts        ← relays.ts, types.ts
orders.ts         ← relays.ts, types.ts
escrow.ts         ← relays.ts, nwc.ts, types.ts
reviews.ts        ← relays.ts, types.ts
zaps.ts           ← relays.ts, types.ts
reports.ts        ← relays.ts, types.ts
qa.ts             ← relays.ts, types.ts
cart.ts           ← relays.ts, nwc.ts, zaps.ts
platform-fees.ts  ← relays.ts, zaps.ts, nwc.ts
subscriptions.ts  ← nwc.ts, relays.ts
notifications.ts  ← nwc.ts, orders.ts, relay-discovery.ts, types.ts
zapvertising.ts   ← relays.ts, nwc.ts
fiat.ts           ← types.ts only
l402.ts           ← relays.ts, nwc.ts
disputes.ts       ← relays.ts, types.ts
index.ts          ← all modules (re-exports only)
```

**No circular dependencies.** The pool singleton is correctly isolated to
`relays.ts` — no other module calls `SimplePool` directly. This is the right
design and it held through all iterations.

---

## LAYER 2: CRITICAL ISSUES (Fix before next publish)

---

### [C1] battle-test-v2.ts: buildCart() call signature wrong

**File:** `examples/battle-test-v2.ts`
**Severity:** Critical — TypeScript compile error, runtime crash

The test calls `buildCart([items])` — passing a single array argument.
The actual function signature in `cart.ts` is:
```typescript
buildCart(buyerPubkey: string, items: CartItem[], note?: string, ttlSeconds?: number): Cart
```
The first argument must be the buyer's pubkey string.

**Fix:**
```typescript
// Replace the buildCart call in battle-test-v2.ts:
const cart = buildCart(
  identity.pubkey,   // ← ADD buyer pubkey as first argument
  [
    {
      listingEventId: "a".repeat(64),
      merchantPubkey: "m".repeat(64),
      quantity: 2,
      amountMsats: 25_000,
    },
    {
      listingEventId: "b".repeat(64),
      merchantPubkey: "n".repeat(64),
      quantity: 1,
      amountMsats: 50_000,
    },
  ]
);
```

Note: cart.ts CartItem does NOT have `dTag`, `merchantLud16`, `unitPriceMsats`,
or `title`. Remove those from the test call. It uses `amountMsats` and `relayHint`.

---

### [C2] battle-test-v2.ts: createSubscription() wrong field names

**File:** `examples/battle-test-v2.ts`
**Severity:** Critical — TypeScript compile error

The test uses field names from `ActiveSubscription` (TYPES_V2_ADDITIONS) but the
actual function takes params matching `SubscriptionRecord` (subscriptions.ts).

Wrong call:
```typescript
createSubscription({
  planDTag: "premium-monthly",
  merchantPubkey: "m".repeat(64),
  merchantLud16: "merchant@getalby.com",   // ← DOESN'T EXIST in params
  amountMsats: 5_000_000,
  frequency: "month",
  nwcUrl: "nostr+walletconnect://...",    // ← WRONG NAME (should be buyerNwcUrl)
})
```

Correct call:
```typescript
createSubscription({
  planDTag: "premium-monthly",
  buyerPubkey: identity.pubkey,            // ← REQUIRED, was missing
  merchantPubkey: "m".repeat(64),
  buyerNwcUrl: "nostr+walletconnect://test?relay=wss://relay.test&secret=abc123",
  amountMsats: 5_000_000,
  frequency: "month",
  // Note: merchantLud16 is NOT in SubscriptionRecord — merchants look it up
  //       from the merchant's kind 0 profile at charge time
});
```

---

### [C3] Duplicate type definitions: TYPES_V2_ADDITIONS vs subscriptions.ts

**File:** `src/types.ts` (after TYPES_V2_ADDITIONS was pasted in) + `src/subscriptions.ts`
**Severity:** Critical — TypeScript build failure (TS2300: Duplicate identifier)

`TYPES_V2_ADDITIONS.ts` defines:
- `SubscriptionFrequency` (4 values: day/week/month/year)
- `SubscriptionPlan` (different shape)
- `ActiveSubscription`

`subscriptions.ts` defines:
- `SubscriptionFrequency` (5 values: hour/day/week/month/year)
- `SubscriptionPlan` (different shape)
- `SubscriptionRecord`

When TYPES_V2_ADDITIONS was pasted into `src/types.ts`, it introduced duplicate
`SubscriptionFrequency` and `SubscriptionPlan` identifiers. TypeScript will not compile.

**The right fix — remove from types.ts, keep in subscriptions.ts:**

The v2 types that were added to `types.ts` via TYPES_V2_ADDITIONS should be reviewed:

Keep in types.ts (genuinely shared, no module owns them):
- CartItem, Cart, CartSummary
- PlatformFeeConfig, FeeCalculation
- ZapAdConfig, ZapAdResult, CampaignResult
- FiatCurrency, FiatRate
- L402Config, L402Token, ApiEndpointInfo
- PaymentEventType, PaymentNotification, OrderNotification
- DisputeData, PaymentAssertionData, LnurlVerifyResult, DisputeResolution

Remove from types.ts (already defined in their module):
- SubscriptionFrequency, SubscriptionPlan, ActiveSubscription
  → These live in `subscriptions.ts` as SubscriptionFrequency, SubscriptionPlan, SubscriptionRecord
- CartItem, Cart (if cart.ts already defines them with different shape — check carefully)
  → cart.ts defines CartItem with {listingEventId, merchantPubkey, quantity, amountMsats, relayHint?}
  → TYPES_V2_ADDITIONS defines CartItem with {dTag, merchantLud16, unitPriceMsats, title, imageUrl?}
  → THESE ARE DIFFERENT SHAPES — one must win, or they must be reconciled

**Resolution for CartItem conflict:**
The `cart.ts` CartItem is missing `merchantLud16` (needed to pay the merchant) and
`title`/`imageUrl` (needed for UI display). The TYPES_V2_ADDITIONS CartItem is missing
`amountMsats` and `relayHint`. The correct merged interface:

```typescript
// CANONICAL CartItem — use in types.ts, replace cart.ts definition
export interface CartItem {
  listingEventId: string;
  dTag: string;
  merchantPubkey: string;
  merchantLud16: string;        // required for payment routing
  quantity: number;
  unitPriceMsats: number;       // price per unit
  amountMsats: number;          // quantity × unitPriceMsats (computed, for convenience)
  title: string;                // for UI display
  imageUrl?: string;
  relayHint?: string;
}
```

---

### [C4] cart.ts CartItem structural mismatch (consequence of C3)

**File:** `src/cart.ts`
**Severity:** Critical — type errors throughout cart usage

`cart.ts` CartItem uses `amountMsats` for the total price of the line item.
`TYPES_V2_ADDITIONS` CartItem uses `unitPriceMsats` (per unit) with no total.
`cart.ts` functions compute totals using `item.amountMsats * item.quantity` which
is mathematically wrong if `amountMsats` is a per-unit price.

The cart payment functions need the merchant's Lightning address (`merchantLud16`)
to pay them, but the current `cart.ts` CartItem doesn't include it.

**Fix:** Use the canonical CartItem above (C3 fix). Update `cart.ts` to use
`item.unitPriceMsats * item.quantity` for totals and `item.merchantLud16` for payment.

---

## LAYER 3: SERIOUS ISSUES (Fix before real-money production use)

---

### [S1] + [S2] relays.ts: fetchEvents subscription memory leak

**File:** `src/relays.ts`
**Severity:** Serious — memory leak + stale event delivery

The `done()` function in `fetchEvents` has two problems:

**Problem A: No guard against double invocation**
Both the timeout path and the `oneose` path call `done()`. In normal operation,
`oneose` fires first and `done()` is called once. But if the relay sends events
slowly and `oneose` fires very close to the timeout, both can fire. JavaScript
`Promise.resolve()` is idempotent (second call is ignored), but the subscription
may still be active when the caller has already received results.

**Problem B: Subscription not closed on timeout path**
When the timeout fires:
```typescript
const timer = setTimeout(done, FETCH_TIMEOUT_MS);  // ← calls done() after timeout
```
`done()` resolves the promise, but `sub.close()` is only called inside `oneose`.
If the relay sends `oneose` after the timeout (which it will eventually), `done()`
is called a second time on an already-resolved promise, and `sub.close()` is called.
But between timeout and the eventual `oneose`, the subscription continues consuming
relay resources and delivering events to the Map.

**Fix:**
```typescript
export async function fetchEvents(
  filters: object[],
  relays: string[] = DEFAULT_RELAYS
): Promise<Event[]> {
  const pool = getPool();

  return new Promise((resolve) => {
    const events = new Map<string, Event>();
    let settled = false;

    const done = () => {
      if (settled) return;  // ← guard: only resolve once
      settled = true;
      clearTimeout(timer);
      sub?.close();         // ← always close subscription when done
      resolve([...events.values()]);
    };

    const timer = setTimeout(done, FETCH_TIMEOUT_MS);

    const sub = pool.subscribeMany(relays, filters, {
      onevent(event: Event) {
        if (!verifyEvent(event)) return;
        if (!events.has(event.id)) events.set(event.id, event);
      },
      oneose() {
        done();
      },
    });
  });
}
```

---

### [S3] SKILL.md: Scenario 17 NIP reference is wrong

**File:** `SKILL.md`, line ~98
**Severity:** Serious — AI agents will implement the wrong protocol

SKILL.md row 17 says: `Lightning: Wrapped | NIP-42 + wrapped invoices`

NIP-42 is relay authentication (kind 22242). It has nothing to do with platform
fees. The actual code in `platform-fees.ts` uses NIP-57 payment prisms — the
merchant and platform are both recipients in a zap split.

**Fix the SKILL.md row 17:**
```markdown
| 17 | Platform Fees | Wrapped | NIP-57 prisms | platform fee, commission, marketplace cut, fee |
```

And update the recipe in SKILL.md's "NIP implementation recipes" section to show
the actual prism approach rather than the NIP-42 relay auth pattern.

---

### [S4] SKILL.md: Scenario 16 NIP reference is wrong

**File:** `SKILL.md`, line ~97
**Severity:** Serious — agents will try to implement an unratified NIP

SKILL.md row 16 says: `NIP-69 | cart, multi-seller, multi-merchant`

NIP-69 has two competing unmerged PRs and zero production implementations.
The actual code uses NIP-57 prism splits for multi-merchant payment. An agent
following SKILL.md for Scenario 16 will look for NIP-69 and find nothing usable.

**Fix the SKILL.md row 16:**
```markdown
| 16 | Multi-Merchant Cart | Multi-route | NIP-57 splits + NIP-99 | cart, multi-seller, one checkout, payment routing |
```

---

### [S5] listing.ts and relay-discovery.ts: missing verifyEvent() before publish

**Files:** `src/listing.ts:deleteListing()`, `src/relay-discovery.ts:buildRelayListEvent()`
**Severity:** Serious — publishing unverified events risks relay rejection and data corruption

`deleteListing()` calls `finalizeEvent()` then immediately `publishToRelays()` without
verifying the signature. All other modules verify before publishing. This is an
oversight that will cause silent failures if the private key is malformed.

`buildRelayListEvent()` returns an event without verifying it — the caller is expected
to verify, but there is no documentation of this requirement.

**Fix for both:**
```typescript
// In deleteListing():
const event = finalizeEvent(template, privateKey);
if (!verifyEvent(event)) throw new Error("Deletion event signature invalid.");
return publishToRelays(event, relays);

// In buildRelayListEvent():
const event = finalizeEvent(template, privateKey) as NostrEvent;
if (!verifyEvent(event)) throw new Error("Relay list event signature invalid.");
return event;
```

---

### [S6] BOLT-11 prefix validation will reject valid future invoices

**File:** `src/nwc.ts:payInvoice()`
**Severity:** Serious for future compatibility — low risk today

Current validation:
```typescript
if (!normalizedInvoice.startsWith("lnbc") &&
    !normalizedInvoice.startsWith("lntb") &&
    !normalizedInvoice.startsWith("lnbcrt")) {
  throw new Error("Invalid BOLT-11 invoice...");
}
```

BOLT-12 offers use `lno` prefix. As BOLT-12 adoption grows (LND 0.18+, CLN current),
this validation will reject valid payments. The fix is to remove the prefix check and
let the wallet reject invalid invoices — it will do so with a more specific error.

**Fix:**
```typescript
// Remove the prefix validation entirely — wallet handles invalid invoices
// If needed, validate only that the string is non-empty and lowercase hex-like:
if (!invoice || invoice.length < 20) {
  throw new Error("Invoice string is too short to be valid.");
}
```

---

## LAYER 4: MINOR ISSUES

---

### [M1] SubscriptionFrequency missing 'hour'

subscriptions.ts includes `"hour"` as a valid frequency (for hourly paid APIs).
TYPES_V2_ADDITIONS omits it. After the C3 fix (remove duplicate from types.ts),
this becomes a non-issue since the canonical definition is in subscriptions.ts.
If `SubscriptionFrequency` is kept in types.ts as the authoritative definition,
add `"hour"` back.

---

### [M2] signAndPublishListing() return type incompletely typed

The function returns `PublishResult & { shareableLink: string }` but the TypeScript
signature shows only `Promise<PublishResult & { eventId: string; shareableLink: string }>`.
This works at runtime but callers who type the return as `PublishResult` will lose
access to `shareableLink` without a cast. Update the declared return type.

---

### [M3] Escrow production warning fires on module import

The safety warning in `escrow.ts`:
```typescript
if (process.env.NODE_ENV === "production" && !process.env.ESCROW_STORE_ACKNOWLEDGED) {
  console.error("⚠️ ESCROW SAFETY WARNING...");
}
```
This runs at module load time. Any test file that imports escrow functions will
trigger this warning in CI/CD environments set to `NODE_ENV=production`. Move
the check inside `createEscrow()` where it's actually relevant.

---

### [M4] Zap amount parser used for more than display

The BOLT-11 amount parser in `zaps.ts` is documented as "display only" but
`parseZapReceipt()` populates `ParsedZap.amountMsats` from it. This value is
used in `summarizeZaps()` which drives UI totals and campaign accounting.

The NIP-57 zap receipt includes an `["amount", msats]` tag from the zap request.
Use this tag instead of parsing BOLT-11:
```typescript
const amountTag = receipt.tags.find(t => t[0] === "amount");
const amountMsats = amountTag ? parseInt(amountTag[1], 10) : parseBolt11AmountDisplay(bolt11);
```

---

### [M5] storage.ts file permission not enforced on overwrite

`writeFileSync(filepath, content, { mode: 0o600 })` sets permissions correctly
on new file creation. On overwrite of an existing file, some operating systems
(particularly Linux with certain umask configurations) may not apply the mode.

Use `chmod` after write:
```typescript
writeFileSync(filepath, JSON.stringify(blob, null, 2));
chmodSync(filepath, 0o600);
```

---

## LAYER 5: CONFIRMED CORRECT (Not bugs — verified clean)

The following were checked and confirmed working:

| Check | Result |
|-------|--------|
| Circular dependencies | ✅ None |
| Pool singleton isolation | ✅ Only relays.ts uses SimplePool |
| NIP-01 BUG-01 fix | ✅ `const [p] = pool.publish()` present |
| NIP-47 BUG-04 fix | ✅ `import { nwc } from "@getalby/sdk"` present |
| NIP-07 BUG-02 fix | ✅ pubkey injected before signEvent |
| EscrowSession.amountMsats BUG-03 | ✅ Present in types.ts |
| ReviewData.paymentHash BUG-08 | ✅ Required field, verified before publish |
| KIND constants | ✅ All match NIP spec |
| NIP-44 encryption | ✅ Uses nip44.getConversationKey correctly |
| NIP-59 gift wrap | ✅ Three layers, ±2 day timestamp jitter |
| NWC assertConnected() | ✅ Guards all payment methods |
| verifyEvent() on fetch | ✅ In fetchEvents onevent handler |
| verifyEvent() on publish | ✅ In reviews, orders, qa, escrow, reports |
| Private key logging | ✅ None found in any file |
| NWC URL logging | ✅ None found |

---

## LAYER 6: BATTLE TEST DIAGNOSIS (from results)

2 passed, 5 failed — correctly categorized:

**4 failures = environment, not code:**
All HTTPS endpoints (CoinGecko, jb55.com, getalby.com) returned `HTTP 403 Host
not in allowlist`. The test environment has an outbound proxy restricting HTTPS
to non-whitelisted domains. WebSocket (wss://) is not restricted — relay tests pass.
These failures do not indicate code bugs. Re-run from an unrestricted network.

**1 failure = code defect (RELAY-02):**
"Fetch mismatch" — wrong event returned, not null. The pool singleton carries open
subscriptions from RELAY-01 into RELAY-02. The relay flushes prior subscription
events into the new query's Map. `events[0]` is the wrong event.
Fix: verify `event.id === requested id` in `fetchEventById` + add `fetchEventByIdWithRetry`.

---

## PRIORITY FIX ORDER FOR CODING AGENT

### P0 — Fix before `npx tsc --noEmit` can pass

**Step 1:** Resolve C3 — remove duplicate types from `src/types.ts`
- Delete: `SubscriptionFrequency`, `SubscriptionPlan`, `ActiveSubscription`
- Delete: the `CartItem` from TYPES_V2_ADDITIONS (keep cart.ts's version,
  but add `merchantLud16: string` and `title: string` to cart.ts CartItem)

**Step 2:** Fix C4 — reconcile CartItem into one canonical interface
- Merge fields: `listingEventId`, `dTag?`, `merchantPubkey`, `merchantLud16`,
  `quantity`, `unitPriceMsats`, `title?`, `imageUrl?`, `relayHint?`
- Update `cart.ts` summarizeCart to use `unitPriceMsats * quantity` for totals

**Step 3:** Verify `npx tsc --noEmit` now passes with zero errors

### P1 — Fix before `battle-test-v2.ts` can run

**Step 4:** Fix C1 — correct `buildCart()` call in battle-test-v2.ts
**Step 5:** Fix C2 — correct `createSubscription()` call in battle-test-v2.ts
**Step 6:** Re-run battle test — expect all non-network tests to pass

### P2 — Fix before real relay production use

**Step 7:** Fix S1+S2 — relays.ts `fetchEvents` double-resolve + subscription leak
  Apply the `settled` guard and always-close pattern above

**Step 8:** Fix S5 — add `verifyEvent()` in `deleteListing()` and `buildRelayListEvent()`

### P3 — Fix before real-money production use

**Step 9:** Fix S3+S4 — correct SKILL.md NIP references for scenarios 16 and 17
**Step 10:** Fix M3 — move escrow warning into `createEscrow()`, not module load
**Step 11:** Fix M4 — use `["amount"]` tag for zap msats, not BOLT-11 parser

### P4 — Improvements before v3

**Step 12:** Fix S6 — remove BOLT-11 prefix validation
**Step 13:** Fix M1 — add `"hour"` to SubscriptionFrequency in types.ts
**Step 14:** Fix M2 — update return type annotation for signAndPublishListing
**Step 15:** Fix M5 — add chmodSync after writeFileSync in storage.ts

---

## FINAL VERDICT

| Layer | Status | Notes |
|-------|--------|-------|
| Architecture | ✅ Sound | Clean dep graph, no circulars, singleton isolated |
| v1 Bug Fixes | ✅ All held | 9 original bugs confirmed fixed |
| Protocol Correctness | ⚠️ Mostly | 2 wrong NIP refs in SKILL.md |
| Type System | ❌ C3 broken | Duplicate defs will fail tsc |
| Test Suite | ❌ C1+C2 broken | Battle test will not compile |
| Security | ✅ Sound | No key leakage, signatures verified |
| Runtime Safety | ⚠️ S1+S2 | Subscription memory leak in fetchEvents |
| Production Readiness | ❌ Not yet | Fix P0+P1+P2 first |

The foundation is correct. Fix the 4 criticals (C1–C4) and the 2 runtime issues
(S1+S2) and the build becomes clean, the tests run, and the relay behavior is safe.
Everything else is polish that matters but doesn't block shipping a working v2.