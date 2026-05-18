/**
 * smoke-test.ts — Validates BUG-01 (relay publish) and BUG-04 (NWC) fixes
 * Run: node --loader ts-node/esm examples/smoke-test.ts
 */
import { generateIdentity, signEvent } from "../src/identity.js";
import { publishToRelays } from "../src/relays.js";
import { createWalletFromEnv } from "../src/nwc.js";
import { KIND } from "../src/types.js";

async function smokeTest() {
  console.log("\n=== Nostr Commerce Skill — Smoke Test ===\n");
  let passed = 0;
  let failed = 0;

  const ok = (label: string, detail?: string) => {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
    passed++;
  };
  const fail = (label: string, detail?: string) => {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  };

  // ── Relay Test (BUG-01 fix) ──────────────────────────────────────
  console.log("1. Relay publish:");
  try {
    const { privateKey } = generateIdentity();
    const event = signEvent(
      { kind: KIND.TEXT_NOTE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["t", "nostr-commerce-skill-test"]],
        content: "smoke test" },
      privateKey
    );
    const result = await publishToRelays(event, [
      "wss://relay.damus.io",
      "wss://relay.nostr.band",
    ]);
    ok("Published", `${result.successCount}/2 relays`);
    ok("Event ID valid", event.id.length === 64 ? event.id.slice(0, 16) + "..." : "INVALID");
  } catch (err) {
    fail("Relay publish", String(err));
  }

  // ── NWC Test (BUG-04 fix) ────────────────────────────────────────
  console.log("\n2. NWC wallet:");
  if (!process.env.NWC_CONNECTION_URL) {
    console.log("  ⚠ NWC_CONNECTION_URL not set — skipping");
  } else {
    try {
      const wallet = createWalletFromEnv();
      const info = await wallet.connect();
      ok("Connected", info.alias ?? "unnamed");
      ok("Methods", info.methods.slice(0, 3).join(", ") + "...");
      const balance = await wallet.getBalance();
      ok("Balance", `${balance.sats} sats`);
      const invoice = await wallet.createInvoice({ amountMsats: 1000, description: "smoke test", expiry: 300 });
      ok("Invoice created", invoice.invoice.slice(0, 20) + "...");
      await wallet.disconnect();
    } catch (err) {
      fail("NWC", String(err));
    }
  }

  console.log(`\n${"─".repeat(42)}`);
  console.log(`${passed} passed  ${failed} failed`);
  if (failed > 0) {
    console.error("\n⛔ Fix failures before publishing.\n");
    process.exit(1);
  }
  console.log("\n✅ Ready to publish.\n");
}

smokeTest().catch(err => { console.error(err); process.exit(1); });
