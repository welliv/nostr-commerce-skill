import { describe, it, expect } from 'vitest';
import {
  httpBinding, mcpBinding, requestHashOf, jcs, settleLnbtc, InMemoryReplayStore, FileReplayStore,
  createLnbtcChallenge, payLnbtcChallenge, validateLnbtcChallenge, serverHandlePaidRetry, MockLightning,
  LNBTC_MAINNET, LNBTC_TESTNET, parseLnbtcPrice, LnbtcError, type LnbtcPaymentRequirements, type LnbtcPaymentPayload,
} from '../src/x402-lnbtc.js';
import { encodeBolt11, decodeBolt11Strict } from '../src/bolt11-strict.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY1 = '00'.repeat(31) + '01';
const PAYTO = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const SPEC_INVOICE = 'lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f';
const PREIMAGE = '0001020304050607080900010203040506070809000102030405060708090102';
const T0 = 1700000000;
const HASH_A = '0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018';
const HASH_B = '4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509';
const MCP_A = '03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4';

const reqA = (): LnbtcPaymentRequirements => ({
  scheme: 'exact', network: LNBTC_MAINNET, amount: '25000', asset: 'BTC', payTo: PAYTO, maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: 'bolt11', paymentFlow: 'upfront', requestHash: HASH_A, requestBindingProfile: 'http:1', requestBindingParams: { headers: [] }, invoice: SPEC_INVOICE },
});
const payloadA = (): LnbtcPaymentPayload => ({ x402Version: 2, accepted: reqA(), payload: { preimage: PREIMAGE } });
const inv = (descriptionHash: string, extra: Partial<Parameters<typeof encodeBolt11>[0]> = {}) => encodeBolt11({
  currency: 'bc', amountMsat: 25000n, timestamp: T0, paymentHash: 'a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e',
  paymentSecret: '11'.repeat(32), descriptionHash, expiry: 300, nodePrivateKey: KEY1, ...extra,
});

describe('BOLT11 strict decoder', () => {
  it('decodes the spec invoice and recovers payTo', () => {
    const d = decodeBolt11Strict(SPEC_INVOICE);
    expect(d.payeeNodeKey).toBe(PAYTO);
    expect(d.descriptionHash).toBe(HASH_A);
    expect(d.amountMsat).toBe('25000');
    expect(d.expiry).toBe(300);
  });
  it('re-encodes the spec invoice byte-for-byte', () => {
    expect(inv(HASH_A)).toBe(SPEC_INVOICE);
  });
  it('rejects a tampered invoice (recovered key changes or decode fails)', () => {
    const t = SPEC_INVOICE.slice(0, 40) + (SPEC_INVOICE[40] === 'q' ? 'p' : 'q') + SPEC_INVOICE.slice(41);
    expect(() => { const d = decodeBolt11Strict(t); if (d.payeeNodeKey === PAYTO) throw new Error('should differ'); throw new Error('changed'); }).toThrow();
  });
});

describe('request binding vectors (spec)', () => {
  it('HTTP article A / B', () => {
    const b = httpBinding({ method: 'GET', url: 'https://api.example.com/article/A' }, { headers: [] });
    expect(jcs(b)).toBe('{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:lnbtc:bolt11:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}');
    expect(requestHashOf(b)).toBe(HASH_A);
    expect(requestHashOf(httpBinding({ method: 'GET', url: 'https://api.example.com/article/B' }, { headers: [] }))).toBe(HASH_B);
  });
  it('MCP vectors', () => {
    const p = { server: 'https://api.example.com/mcp', metadata: [] as string[] };
    expect(requestHashOf(mcpBinding({ name: 'get_article', arguments: { article: 'A' } }, p))).toBe(MCP_A);
    expect(requestHashOf(mcpBinding({ name: 'get_article', arguments: { article: 'B' } }, p))).toBe('b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678');
    expect(requestHashOf(mcpBinding({ name: 'delete_article', arguments: { article: 'A' } }, p))).toBe('3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455');
    expect(requestHashOf(mcpBinding({ name: 'get_article', arguments: { article: 'A' } }, { ...p, server: 'https://other.example.com/mcp' }))).toBe('96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45');
  });
  it('MCP metadata absent vs null', () => {
    const p = { server: 'https://api.example.com/mcp', metadata: ['acct'] };
    expect(mcpBinding({ name: 'x' }, p).metadata[0].valueHash).toBe('6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
    expect(mcpBinding({ name: 'x', _meta: { acct: null } }, p).metadata[0].valueHash).toBe('c58dcb77cee9027d1f4b3207bd876d232e61f79ee9f9dbd4e6d834778da78b16');
  });
  it('rejects x402/payment and progressToken in metadata, unknown params', () => {
    expect(() => mcpBinding({ name: 'x' }, { server: 'https://a/mcp', metadata: ['progressToken'] })).toThrow(LnbtcError);
    expect(() => mcpBinding({ name: 'x' }, { server: 'https://a/mcp', metadata: ['x402/payment'] })).toThrow(LnbtcError);
    expect(() => httpBinding({ method: 'GET', url: 'https://a/' }, { headers: [], extra: 1 } as any)).toThrow(LnbtcError);
    expect(() => httpBinding({ method: 'GET', url: 'https://a/' }, { headers: ['b', 'a'] })).toThrow(LnbtcError);
  });
});

describe('facilitator settlement case table (HTTP)', () => {
  const opts = { nowUnix: T0 };
  it('unchanged examples settle; transaction is payment hash; no payer', async () => {
    const r = await settleLnbtc(payloadA(), reqA(), new InMemoryReplayStore(), opts);
    expect(r).toEqual({ success: true, transaction: 'a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e', network: LNBTC_MAINNET });
  });
  it('different member order still settles', async () => {
    const r0 = reqA(); const reordered = JSON.parse(JSON.stringify({ extra: r0.extra, maxTimeoutSeconds: 300, payTo: PAYTO, asset: 'BTC', amount: '25000', network: LNBTC_MAINNET, scheme: 'exact' }));
    expect((await settleLnbtc({ ...payloadA(), accepted: reordered }, reqA(), new InMemoryReplayStore(), opts)).success).toBe(true);
  });
  it('fresh requirements invoice still settles with accepted invoice', async () => {
    const r = reqA(); r.extra.invoice = inv(HASH_A, { paymentHash: 'bb'.repeat(32) });
    expect((await settleLnbtc(payloadA(), r, new InMemoryReplayStore(), opts)).success).toBe(true);
  });
  it('concurrent duplicate: exactly one succeeds', async () => {
    const s = new InMemoryReplayStore();
    const [a, b] = await Promise.all([settleLnbtc(payloadA(), reqA(), s, opts), settleLnbtc(payloadA(), reqA(), s, opts)]);
    expect([a.success, b.success].filter(Boolean).length).toBe(1);
    expect([a, b].find((x) => !x.success)!.errorReason).toBe('duplicate_settlement');
  });
  it('durable file store: concurrent claim exactly one, survives restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-'));
    const [a, b] = await Promise.all([settleLnbtc(payloadA(), reqA(), new FileReplayStore(dir), opts), settleLnbtc(payloadA(), reqA(), new FileReplayStore(dir), opts)]);
    expect([a.success, b.success].filter(Boolean).length).toBe(1);
    expect((await settleLnbtc(payloadA(), reqA(), new FileReplayStore(dir), opts)).errorReason).toBe('duplicate_settlement');
  });
  it('same hash on testnet is a different key', async () => {
    const s = new InMemoryReplayStore(); await settleLnbtc(payloadA(), reqA(), s, opts);
    expect(await s.has(`${LNBTC_TESTNET}:a923c2c0e4fe77061ff1cb882171f6fdf926719bb7f5ffe2e05458438c52825e`)).toBe(false);
  });
  it('article A proof for article B request → request_mismatch', async () => {
    const r = reqA(); r.extra.requestHash = HASH_B;
    expect((await settleLnbtc(payloadA(), r, new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_request_mismatch');
  });
  it('echoing B digest → invoice_request_mismatch', async () => {
    const r = reqA(); r.extra.requestHash = HASH_B; const p = payloadA(); p.accepted.extra.requestHash = HASH_B;
    expect((await settleLnbtc(p, r, new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_invoice_request_mismatch');
  });
  it('POST or body 0x78 with echoed digest → invoice_request_mismatch', async () => {
    for (const req of [{ method: 'POST', url: 'https://api.example.com/article/A' }, { method: 'GET', url: 'https://api.example.com/article/A', body: new Uint8Array([0x78]) }]) {
      const h = requestHashOf(httpBinding(req, { headers: [] }));
      const r = reqA(); r.extra.requestHash = h; const p = payloadA(); p.accepted.extra.requestHash = h;
      expect((await settleLnbtc(p, r, new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_invoice_request_mismatch');
    }
  });
  it('missing binding fields either side → request_binding', async () => {
    for (const f of ['requestHash', 'requestBindingProfile', 'requestBindingParams'] as const) {
      for (const side of ['r', 'a']) {
        const r = reqA(); const p = payloadA(); delete (side === 'r' ? r.extra : p.accepted.extra)[f];
        expect((await settleLnbtc(p, r, new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_request_binding');
      }
    }
  });
  it('unknown profile / missing param / unknown param → request_binding', async () => {
    const muts: Array<(e: any) => void> = [(e) => (e.requestBindingProfile = 'grpc:1'), (e) => (e.requestBindingParams = {}), (e) => (e.requestBindingParams = { headers: [], x: 1 })];
    for (const m of muts) { const r = reqA(); const p = payloadA(); m(p.accepted.extra); m(r.extra);
      expect((await settleLnbtc(p, r, new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_request_binding'); }
  });
  it('changing only accepted header list → request_mismatch', async () => {
    const p = payloadA(); p.accepted.extra.requestBindingParams = { headers: ['accept'] };
    expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_request_mismatch');
  });
  it('inline description invoice → invoice_description', async () => {
    const p = payloadA(); p.accepted.extra.invoice = inv(undefined as any, { descriptionHash: undefined, description: 'article A' });
    expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_invoice_description');
  });
  it('wrong network currency (tb invoice under mainnet) → currency mismatch', async () => {
    const p = payloadA(); p.accepted.extra.invoice = inv(HASH_A, { currency: 'tb' });
    expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_invoice_currency_mismatch');
  });
  it('payee mismatch (self-issued invoice) → payee_mismatch', async () => {
    const p = payloadA(); p.accepted.extra.invoice = inv(HASH_A, { nodePrivateKey: '00'.repeat(31) + '02' });
    expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe('invalid_exact_lnbtc_invoice_payee_mismatch');
  });
  it('preimage errors', async () => {
    const cases: [any, string][] = [[undefined, 'invalid_exact_lnbtc_preimage_missing'], ['ZZ', 'invalid_exact_lnbtc_preimage_malformed'], ['00', 'invalid_exact_lnbtc_preimage_length'], ['00'.repeat(32), 'invalid_exact_lnbtc_preimage_hash_mismatch']];
    for (const [pre, reason] of cases) { const p = payloadA(); p.payload = { preimage: pre };
      expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe(reason); }
  });
  it('expiry boundary: end+skew ok, +1 fails; created-in-future', async () => {
    expect((await settleLnbtc(payloadA(), reqA(), new InMemoryReplayStore(), { nowUnix: T0 + 300 + 60 })).success).toBe(true);
    expect((await settleLnbtc(payloadA(), reqA(), new InMemoryReplayStore(), { nowUnix: T0 + 361 })).errorReason).toBe('invalid_exact_lnbtc_invoice_expired');
    expect((await settleLnbtc(payloadA(), reqA(), new InMemoryReplayStore(), { nowUnix: T0 - 61 })).errorReason).toBe('invalid_exact_lnbtc_invoice_created_in_future');
    expect((await settleLnbtc(payloadA(), reqA(), new InMemoryReplayStore(), { nowUnix: T0 - 60 })).success).toBe(true);
  });
  it('core mismatches', async () => {
    const muts: [(a: any) => void, string][] = [
      [(a) => (a.network = LNBTC_TESTNET), 'network_mismatch'], [(a) => (a.amount = '1'), 'invalid_exact_lnbtc_amount_mismatch'],
      [(a) => (a.payTo = '03' + 'a'.repeat(64)), 'invalid_exact_lnbtc_pay_to_mismatch'], [(a) => (a.maxTimeoutSeconds = 301), 'invalid_exact_lnbtc_max_timeout_mismatch'],
      [(a) => (a.scheme = 'upto'), 'unsupported_scheme'], [(a) => (a.extra.paymentFlow = 'deferred'), 'invalid_exact_lnbtc_payment_flow'],
      [(a) => (a.extra.assetTransferMethod = 'bolt12'), 'invalid_exact_lnbtc_asset_transfer_method'],
    ];
    for (const [m, reason] of muts) { const p = payloadA(); m(p.accepted);
      expect((await settleLnbtc(p, reqA(), new InMemoryReplayStore(), opts)).errorReason).toBe(reason); }
  });
});

describe('MCP settlement cases', () => {
  const params = { server: 'https://api.example.com/mcp', metadata: [] as string[] };
  const mk = (): LnbtcPaymentRequirements => ({ ...reqA(), extra: { ...reqA().extra, requestHash: MCP_A, requestBindingProfile: 'mcp:1', requestBindingParams: params, invoice: inv(MCP_A) } });
  const pl = (): LnbtcPaymentPayload => ({ x402Version: 2, accepted: mk(), payload: { preimage: PREIMAGE } });
  it('HTTP invoice with MCP binding → invoice_request_mismatch', async () => {
    const p = pl(); p.accepted.extra.invoice = SPEC_INVOICE;
    expect((await settleLnbtc(p, mk(), new InMemoryReplayStore(), { nowUnix: T0 })).errorReason).toBe('invalid_exact_lnbtc_invoice_request_mismatch');
  });
  it('changing only accepted profile to http:1 → request_mismatch', async () => {
    const p = pl(); p.accepted.extra.requestBindingProfile = 'http:1'; p.accepted.extra.requestBindingParams = { headers: [] };
    expect((await settleLnbtc(p, mk(), new InMemoryReplayStore(), { nowUnix: T0 })).errorReason).toBe('invalid_exact_lnbtc_request_mismatch');
  });
  it('client rejects http:1 advertised for an MCP tool call before paying', () => {
    expect(() => validateLnbtcChallenge(reqA(), { expectedProfile: 'mcp:1', request: { name: 'get_article', arguments: { article: 'A' } }, trustedMcpServer: params.server, nowUnix: T0 })).toThrow(/request_binding/);
  });
});

describe('end-to-end with mock Lightning', () => {
  it('server challenge → client pays → server retry settles once', async () => {
    const ln = new MockLightning('11'.repeat(32), 'bc', () => T0);
    const cfg = { network: LNBTC_MAINNET, amountMsat: parseLnbtcPrice('21 sats'), maxTimeoutSeconds: 300, profile: 'http:1' as const, params: { headers: ['content-type'] } };
    const request = { method: 'POST', url: 'https://artist.example/license/x', body: '{"use":"sync"}', headers: { 'Content-Type': 'application/json' } };
    const ch = await createLnbtcChallenge(cfg, ln.receiver, request, T0);
    const payload = await payLnbtcChallenge(ch, { expectedProfile: 'http:1', request, nowUnix: T0, allowedNetworks: [LNBTC_MAINNET] }, ln.payer);
    const store = new InMemoryReplayStore();
    const fresh = (await createLnbtcChallenge(cfg, ln.receiver, request, T0)).extra.invoice;
    expect((await serverHandlePaidRetry(cfg, request, payload, ln.receiver.nodePubkey, fresh, store, T0 + 5)).success).toBe(true);
    expect((await serverHandlePaidRetry(cfg, request, payload, ln.receiver.nodePubkey, fresh, store, T0 + 6)).errorReason).toBe('duplicate_settlement');
    // tampered body on retry
    expect((await serverHandlePaidRetry(cfg, { ...request, body: '{"use":"ai"}' }, payload, ln.receiver.nodePubkey, fresh, new InMemoryReplayStore(), T0 + 5)).errorReason).toBe('invalid_exact_lnbtc_request_mismatch');
  });
  it('price parser rejects bare numbers and USD', () => {
    expect(() => parseLnbtcPrice('21')).toThrow(); expect(() => parseLnbtcPrice('$1')).toThrow();
    expect(parseLnbtcPrice({ asset: 'BTC', amount: '21000' })).toBe('21000');
  });
});
