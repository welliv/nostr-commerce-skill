/**
 * battle-test-v2.ts — Updated integration tests after P0 fixes
 */

import {
  generateIdentity,
  signEvent,
  publishToRelays,
  fetchEventById,
  signAndPublishListing,
  buildCart,
  createSubscription,
  fetchBtcRate,
  fiatToMsats,
  fetchLnurlMetadata,
  verifyNip05,
  KIND,
  DEFAULT_RELAYS,
} from "../src/index.js";

const results: Array<{ name: string; status: string; ms: number; detail: string }> = [];

async function runTest(name: string, fn: () => Promise<void>, skip?: string) {
  if (skip) {
    results.push({ name, status: "SKIP", ms: 0, detail: skip });
    return;
  }
  const start = Date.now();
  try {
    await fn();
    results.push({ name, status: "PASS", ms: Date.now() - start, detail: "" });
  } catch (e: any) {
    results.push({ name, status: "FAIL", ms: Date.now() - start, detail: e.message || String(e) });
  }
}

async function main() {
  const identity = generateIdentity();
  console.log(`\nTest identity: ${identity.npub.slice(0, 20)}...`);

  await runTest("RELAY-01: publish to damus", async () => {
    const event = signEvent({
      kind: KIND.TEXT_NOTE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", "nostr-commerce-skill-v2"]],
      content: "v2 battle test",
    }, identity.privateKey!);
    const result = await publishToRelays(event, ["wss://relay.damus.io"]);
    if (result.successCount === 0) throw new Error("Published to 0 relays");
  });

  await runTest("LISTING-01: publish listing", async () => {
    const result = await signAndPublishListing({
      dTag: `v2-test-${Date.now()}`,
      title: "V2 Test Item",
      summary: "Updated battle test",
      content: "Test after P0 fixes",
      price: { amount: "10.00", currency: "USD" },
      type: "physical",
      categories: ["test"],
    }, identity.privateKey!, ["wss://relay.damus.io"]);
    if (result.successCount === 0) throw new Error("Listing failed");
  });

  await runTest("CART-01: build multi-merchant cart", async () => {
    const cart = buildCart(identity.pubkey, [
      {
        listingEventId: "a".repeat(64),
        merchantPubkey: "m".repeat(64),
        quantity: 2,
        unitPriceMsats: 25000,
        merchantLud16: "merchant@getalby.com",
      },
    ]);
    if (!cart.id) throw new Error("Cart creation failed");
  });

  await runTest("SUB-01: create subscription", async () => {
    const sub = createSubscription({
      planDTag: "premium-monthly",
      buyerPubkey: identity.pubkey,
      merchantPubkey: "m".repeat(64),
      buyerNwcUrl: "nostr+walletconnect://test",
      amountMsats: 5000000,
      frequency: "month",
    });
    if (!sub.id) throw new Error("Subscription creation failed");
  });

  await runTest("FIAT-01: get BTC price", async () => {
    const rate = await fetchBtcRate("USD");
    if (!rate || rate <= 0) throw new Error("Invalid rate");
  });

  // Results
  console.log("\n=== BATTLE TEST V2 RESULTS ===");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "SKIP" ? "·" : "✗";
    console.log(`  ${icon} ${r.name} (${r.ms}ms) ${r.detail ? "→ " + r.detail : ""}`);
  }
  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  console.log(`\n${pass} passed · ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

main().catch(console.error);