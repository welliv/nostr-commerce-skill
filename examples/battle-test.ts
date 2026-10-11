/**
 * battle-test.ts — Integration tests against live infrastructure
 */

import {
  generateIdentity,
  signEvent,
  publishToRelays,
  fetchEventById,
  signAndPublishListing,
  parseListing,
  searchListings,
  fetchBtcRate,
  fiatToMsats,
  formatPrice,
  fetchLnurlMetadata,
  verifyNip05,
  fetchUserRelays,
  KIND,
  DEFAULT_RELAYS,
  SEARCH_RELAYS,
} from "../src/index.js";

const results: Array<{ name: string; status: "PASS"|"FAIL"|"SKIP"; ms: number; detail: string }> = [];

async function runTest(name: string, fn: () => Promise<void>, skipReason?: string) {
  if (skipReason) {
    results.push({ name, status: "SKIP", ms: 0, detail: skipReason });
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
  console.log("Running against live relays...\n");

  // RELAY tests
  await runTest("RELAY-01: publish to damus", async () => {
    const event = signEvent({
      kind: KIND.TEXT_NOTE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", "nostr-commerce-skill-battle-test"]],
      content: "battle-test ping",
    }, identity.privateKey!);

    const result = await publishToRelays(event, ["wss://relay.damus.io"]);
    if (result.successCount === 0) throw new Error("Published to 0 relays");
  });

  await runTest("RELAY-02: publish and fetch by ID", async () => {
    const event = signEvent({
      kind: KIND.TEXT_NOTE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["t", "nostr-commerce-skill-fetch-test"]],
      content: `fetch-test-${Date.now()}`,
    }, identity.privateKey!);

    await publishToRelays(event, ["wss://relay.nostr.band"]);
    await new Promise(r => setTimeout(r, 2000));

    const fetched = await fetchEventById(event.id, ["wss://relay.nostr.band"]);
    if (!fetched || fetched.id !== event.id) throw new Error("Fetch mismatch");
  });

  // LISTING
  await runTest("LISTING-01: publish kind 30402 listing", async () => {
    const result = await signAndPublishListing({
      dTag: `battle-test-${Date.now()}`,
      title: "Battle Test Candle",
      summary: "Integration test listing",
      content: "Automated battle test",
      price: { amount: "5.00", currency: "USD" },
      type: "physical",
      categories: ["test"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }, identity.privateKey!, ["wss://relay.damus.io"]);

    if (result.successCount === 0) throw new Error("Listing published to 0 relays");
  });

  // FIAT
  await runTest("FIAT-01: get BTC price", async () => {
    const rate = await fetchBtcRate("USD");
    if (!rate || rate <= 0) throw new Error("Invalid rate");
    console.log(`    1 USD ≈ ${rate.toFixed(0)} sats`);
  });

  await runTest("FIAT-02: convert $25 to msats", async () => {
    const msats = await fiatToMsats(25, "USD");
    if (!msats || msats <= 0) throw new Error("Bad conversion");
    console.log(`    $25 = ${Math.floor(msats / 1000)} sats`);
  });

  // NIP-05
  await runTest("NIP05-01: verify jb55@jb55.com", async () => {
    const valid = await verifyNip05("jb55@jb55.com", "bf2376e17ba4ec269d10fcc996a4746b451152be9031fa48e74553dde5526bce");
    if (!valid) throw new Error("NIP-05 verification failed");
  });

  // LNURL / Zaps
  await runTest("ZAP-01: fetch LNURL metadata from Alby", async () => {
    const meta = await fetchLnurlMetadata("https://getalby.com/.well-known/lnurlp/hello");
    if (!meta) throw new Error("Failed to fetch LNURL metadata");
    console.log(`    allowsNostr: ${meta.allowsNostr}`);
  });

  // Results
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  BATTLE TEST RESULTS");
  console.log("══════════════════════════════════════════════════════\n");

  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "SKIP" ? "·" : "✗";
    const time = r.ms > 0 ? ` (${r.ms}ms)` : "";
    console.log(`  ${icon}  ${r.name}${time}`);
    if (r.detail) console.log(`       → ${r.detail}`);
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const fail = results.filter(r => r.status === "FAIL").length;
  const skip = results.filter(r => r.status === "SKIP").length;

  console.log(`\n  ${pass} passed · ${fail} failed · ${skip} skipped\n`);

  if (fail > 0) process.exit(1);
}

main().catch(console.error);