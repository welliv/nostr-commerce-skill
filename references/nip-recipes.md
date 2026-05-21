# NIP Implementation Recipes

Load this file when implementing a specific scenario. Use it to get the exact tags, kinds, and patterns right without guessing.

## NIP-01 / Identity
```
Event kind: 0 (metadata), kind 1 (text note)
Keys: secp256k1 keypair — store nsec encrypted, share npub freely
Sign: schnorr(SHA256(serialized_event), privkey)
```

## NIP-07 / Browser Signer
```
Check: typeof window.nostr !== 'undefined'
Get pubkey: await window.nostr.getPublicKey()
Sign: await window.nostr.signEvent(unsignedEvent)
Fallback: generate ephemeral key if extension absent
```

## NIP-19 / Bech32 Encoding
```
npub = bech32("npub", pubkey_bytes)     — share freely
nsec = bech32("nsec", privkey_bytes)    — NEVER log or transmit
naddr = bech32("naddr", TLV{kind, pubkey, identifier, relays}) — shareable listing link
```

## NIP-99 / Classified Listing (kind 30402)
```
Required tags: ["d", unique_stable_id], ["title", name], ["price", amount, currency]
Optional:      ["image", url], ["summary", short_desc], ["t", category],
               ["location", place], ["published_at", unix_ts_string]
Content: Markdown description
Update: republish same "d" tag — relay auto-replaces
```

## NIP-40 / Expiration
```
Add to any event: ["expiration", unix_timestamp_string]
After timestamp: relay stops serving event on query (not deleted from disk)
```

## NIP-50 / Search
```
Client: ["REQ", sub_id, {"search": "query terms", "kinds": [30402]}]
Returns: matching events from relays that support NIP-50 (nostr.band, primal.net)
Fallback: client-side filter on event.content + tags if relay lacks NIP-50
```

## NIP-05 / DNS Verification
```
Profile kind 0: {"nip05": "user@domain.com"}
Verify: GET https://domain.com/.well known/nostr.json?name=user
Pass: response.names["user"] === pubkey
```

## NIP-39 / External Identity Claims
```
Profile kind 0 tags: ["i", "github:username", "proof_url"]
Platforms: github, twitter, mastodon, telegram, website
```

## NIP-44 / Encryption
```
Version: 0x02
Key derivation: ECDH(sender_privkey, recipient_pubkey) → HKDF → key
Cipher: XChaCha20-Poly1305
Encode: base64(nonce + ciphertext + mac)
```

## NIP-59 / Gift Wrap (3-layer privacy)
```
Rumor: unsigned inner event (real content, real author pubkey)
Seal:  kind 13, NIP-44 encrypt(rumor), signed by real author
Wrap:  kind 1059, NIP-44 encrypt(seal), signed by RANDOM ephemeral key
       tags: ["p", recipient_pubkey]
```
Result: relay sees only "event for pubkey X, from random key" — real sender hidden.

## NIP-47 / Wallet Connect (NWC)
```
URI: nostr+walletconnect://<wallet_pubkey>?relay=<url>&secret=<hex>
Request: kind 23194, encrypted to wallet_pubkey
  {"method": "pay_invoice", "params": {"invoice": "lnbc..."}}
Response: kind 23195, encrypted to client
  {"result_type": "pay_invoice", "result": {"preimage": "..."}}
Methods: pay_invoice, make_invoice, get_balance, lookup_invoice, get_info
Budget: set max spend in NWC connection URI to cap autonomous spending
```

## NIP-47 / Hold Invoice (Escrow)
```
Requires Alby Hub — standard NWC wallets don't support hold invoices.
Create: make_invoice with hold=true → returns invoice + payment_hash
Buyer pays: invoice is in "held" state (funds locked, not settled)
Release: settle_hold_invoice(preimage) → funds move to merchant
Cancel:  cancel_hold_invoice(payment_hash) → funds refund to buyer
NIP-40 deadline: if not settled by expiration, invoice auto-cancels
```

## NIP-57 / Zaps
```
Zap request: kind 9734
  tags: ["p", recipient_pubkey], ["e", event_id], ["amount", msats], ["relays", ...]
Flow: send 9734 to recipient LNURL endpoint → get invoice → user pays →
      wallet publishes kind 9735 receipt to relays
Prism (splits): multiple ["p", pubkey, "", weight] tags on 9734
```

## NIP-85 / Trusted Assertions
```
Kind: 30382
tags: ["d", subject_pubkey], ["k", claimed_kind], ["n", "true"/"false"]
Publisher: trusted third party (escrow service, platform, etc.)
Use: "this pubkey settled payment X", "this pubkey is KYC-verified merchant"
```

## Kind 31990 / Reviews
```
Content: {"review": "text", "rating": 5}
Tags: ["d", id], ["preimage", payment_preimage], ["e", listing_event_id]
Gate: preimage proves buyer actually paid — verifyPreimage(preimage, paymentHash)
```

## NIP-56 / Reports (kind 1984)
```
tags: ["p", reported_pubkey, "reason"], ["e", evidence_event_id]
reasons: nudity, malware, profanity, illegal, spam, impersonation, scam, other
Permanent on relays. Reported pubkey cannot remove it.
```

## NIP-22 / Comments (kind 1111)
```
Question: tags: ["K", "30402"], ["E", listing_event_id, relay, listing_author_pubkey]
Answer:   tags: ["e", question_event_id, relay, "reply"]
```

## NIP-57 Splits / multi merchant Cart
```
On checkout event: ["zap", seller1_pubkey, relay, weight1],
                   ["zap", seller2_pubkey, relay, weight2]
Lightning splits are SEQUENTIAL, not atomic. Each recipient receives an independent payment.
```

## NIP-57 Prisms / Platform Fees
```
Merchant's lud16 LNURL returns split invoice:
  ["zap", merchant_pubkey, relay, merchant_weight],
  ["zap", platform_pubkey, relay, platform_weight]
calculateFee(amountMsats, {feePercent: 3}) → {merchantMsats, feeMsats, totalMsats}
```

## NIP-98 / HTTP Auth
```
Kind: 27235 (ephemeral — not stored on relays)
tags: ["u", request_url], ["method", "GET"/"POST"]
Header: Authorization: Nostr <base64(JSON.stringify(signedEvent))>
```

## L402 / Paid API
```
Server: 402 response with WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
Client: pay invoice → get preimage → retry with Authorization: L402 <macaroon>:<preimage>
Announce endpoint: publish as kind 30078 event (discoverable via NIP-50)
```

## Relay Defaults
```
wss://relay.damus.io          — general, reliable
wss://relay.nostr.band        — NIP-50 search supported
wss://nos.lol                 — general
wss://relay.primal.net        — NIP-50 search supported
wss://relay.shopstr.store     — commerce-specific
```
Always publish to 3+ relays. Use filterReachableRelays() before critical operations.

## Common Errors
```
Event signature invalid  → wrong private key or corrupted event — resign
Relay refused: pow       → relay requires proof-of-work — switch relay
Invoice expired          → Lightning invoice > 10 min — generate new one
NIP-07 not found         → no browser extension — prompt to install Alby/nos2x
NWC connection refused   → wrong secret or relay URL — check connection URI
Decryption failed        → wrong keys or NIP-44 version mismatch — check key derivation
preimage invalid         → payment not made — verify via Lightning node lookup
```