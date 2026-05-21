import { WebSocket } from 'ws';

// nostr-tools/relay uses WebSocket which isn't available in Node.js by default
globalThis.WebSocket = WebSocket as any;
