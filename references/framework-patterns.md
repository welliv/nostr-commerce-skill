# Framework Quick-Start Patterns

Load this file when you detect a specific stack and need the idiomatic integration pattern.

## React / Next.js (TypeScript)

```typescript
// Install: npm install @nostr-dev-kit/ndk @getalby/bitcoin-connect
// lib/nostr.ts — singleton NDK instance
import NDK from '@nostr-dev-kit/ndk';
export const ndk = new NDK({
  explicitRelayUrls: ['wss://relay.damus.io', 'wss://relay.nostr.band', 'wss://nos.lol'],
});
await ndk.connect();

// NIP-07 browser signing
import { NDKNip07Signer } from '@nostr-dev-kit/ndk';
ndk.signer = new NDKNip07Signer();
const user = await ndk.signer.user();
```

## Node.js / Express

```typescript
// Install: npm install nostr-tools ws
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools';
import { Relay } from 'nostr-tools/relay';

const sk = generateSecretKey(); // Uint8Array — store in env, never in code
const pk = getPublicKey(sk);
```

## React Native

```typescript
// Install: npm install @nostr-dev-kit/ndk-mobile
import NDKMobile from '@nostr-dev-kit/ndk-mobile';
// Uses secure storage (Keychain/Keystore) automatically
```

## Python (FastAPI / Django)

```python
# Install: pip install pynostr
from pynostr.key import PrivateKey
from pynostr.relay_manager import RelayManager
from pynostr.event import Event, EventKind
```

## Relay Connection Pattern (all stacks)

```typescript
// Always connect with timeout and error handling
const connectRelay = async (url: string) => {
  const relay = new Relay(url);
  try {
    await Promise.race([
      relay.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Relay timeout')), 5_000))
    ]);
    return relay;
  } catch {
    console.warn(`Could not connect to ${url}`);
    return null;
  }
};
```

## Event Publishing Pattern (all stacks)

```typescript
// Always verify before publishing
const publishEvent = async (event: Event, relays: Relay[]) => {
  if (!verifyEvent(event)) throw new Error('Event signature invalid');
  const results = await Promise.allSettled(
    relays.filter(Boolean).map(r => r.publish(event))
  );
  const published = results.filter(r => r.status === 'fulfilled').length;
  if (published === 0) throw new Error('Failed to publish to any relay');
  return { published, total: relays.length };
};
```