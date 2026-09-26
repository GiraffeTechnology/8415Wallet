import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const signer = require_('../scripts/controls/testnet-signer.cjs');
const journey = require_('../scripts/controls/browser-journey.cjs');

const domain = {
  name: '8415Wallet ResponsibilityControls', version: '1', chainId: '11155111',
  verifyingContract: '0x1111111111111111111111111111111111111111',
};
const types = { EIP712Domain: [{ name: 'name', type: 'string' }], ForwardConsent: [{ name: 'legId', type: 'bytes32' }] };
const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ primaryType: 'ForwardConsent', domain, types, message: { legId: `0x${'11'.repeat(32)}` }, ...over });
const config = { chainId: 11155111n };

test('the signer custodies test networks only and never relays a write method', () => {
  assert.deepEqual(signer.ALLOWED_CHAINS, [11155111n, 560048n]);
  for (const method of ['eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTransaction',
    'eth_accounts', 'eth_sendTransaction', 'eth_signTypedData_v4']) {
    assert.equal(signer.FORWARD.has(method), false, `${method} must never be forwarded verbatim`);
  }
  for (const method of ['eth_call', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionReceipt']) {
    assert.equal(signer.FORWARD.has(method), true);
  }
  assert.deepEqual([...signer.LOCAL].sort(), ['eth_accounts', 'eth_sendTransaction', 'eth_signTypedData_v4']);
});

test('typed signing is bound to the one control domain and refuses anything else', () => {
  const accepted = signer.typedData(payload(), config);
  assert.deepEqual(Object.keys(accepted.types), ['ForwardConsent'], 'EIP712Domain is never re-declared to the signer');
  assert.equal(accepted.domain.verifyingContract, domain.verifyingContract);
  const refusals: [string, string][] = [
    [payload({ primaryType: 'Permit' }), 'SIGNER_TYPED_DOMAIN_REFUSED'],
    [payload({ domain: { ...domain, name: 'Other' } }), 'SIGNER_TYPED_DOMAIN_REFUSED'],
    [payload({ domain: { ...domain, version: '2' } }), 'SIGNER_TYPED_DOMAIN_REFUSED'],
    [payload({ domain: { ...domain, chainId: '1' } }), 'SIGNER_TYPED_DOMAIN_REFUSED'],
    [payload({ domain: { ...domain, verifyingContract: 'not-an-address' } }), 'SIGNER_TYPED_DOMAIN_REFUSED'],
    [payload({ types: { ...types, Permit: [] } }), 'SIGNER_TYPED_TYPES_REFUSED'],
    [payload({ types: { EIP712Domain: [] } }), 'SIGNER_TYPED_TYPES_REFUSED'],
    [payload({ message: null }), 'SIGNER_TYPED_MESSAGE_REFUSED'],
    ['{not json', 'SIGNER_TYPED_PAYLOAD_REFUSED'],
  ];
  for (const [input, code] of refusals) {
    assert.throws(() => signer.typedData(input, config), (error: { safeCode?: string }) => error.safeCode === code,
      `expected ${code}`);
  }
});

test('a mainnet chain id is never a signable domain even with every other field correct', () => {
  assert.throws(() => signer.typedData(payload(), { chainId: 1n }),
    (error: { safeCode?: string }) => error.safeCode === 'SIGNER_TYPED_DOMAIN_REFUSED');
});

test('funding requirement carries headroom over the measured gas of every role', () => {
  const maxFee = 3000000000n;
  const { rows, totalWei } = signer.requirement(maxFee);
  assert.deepEqual(rows.map((r: { role: string }) => r.role), signer.ROLES);
  assert.equal(totalWei, rows.reduce((t: bigint, r: { weiRequired: bigint }) => t + r.weiRequired, 0n));
  for (const row of rows) {
    const bare = signer.MEASURED_GAS[row.role] * maxFee;
    assert.ok(row.weiRequired > bare, 'a role is funded above its measured cost, never exactly at it');
    assert.equal(row.weiRequired, bare * signer.HEADROOM_PERCENT / 100n);
  }
});

test('a keystore is refused unless it is a private regular file holding five keys', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), '8415-keystore-'));
  const write = (name: string, body: unknown, mode: number) => {
    const file = path.join(base, name);
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const keys = Array.from({ length: 5 }, (_v, i) => `0x${String(i + 1).repeat(64)}`);
  const good = write('good.json', { schema: '8415-testnet-signers/1', keys }, 0o600);
  assert.deepEqual(signer.load({ file: good }), keys);

  const cases: [string, unknown, number, string][] = [
    ['world-readable.json', { schema: '8415-testnet-signers/1', keys }, 0o644, 'SIGNER_KEYSTORE_PERMISSIONS_REFUSED'],
    ['wrong-schema.json', { schema: 'other/1', keys }, 0o600, 'SIGNER_KEYSTORE_SCHEMA_REFUSED'],
    ['short.json', { schema: '8415-testnet-signers/1', keys: keys.slice(1) }, 0o600, 'SIGNER_KEYSTORE_SCHEMA_REFUSED'],
    ['not-hex.json', { schema: '8415-testnet-signers/1', keys: [...keys.slice(1), 'nope'] }, 0o600, 'SIGNER_KEYSTORE_SCHEMA_REFUSED'],
  ];
  for (const [name, body, mode, code] of cases) {
    const file = write(name, body, mode);
    assert.throws(() => signer.load({ file }), (error: { safeCode?: string }) => error.safeCode === code, name);
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('the browser journey drives a phone viewport as well as a desktop one, on test networks only', () => {
  assert.deepEqual(journey.ALLOWED_CHAINS, [11155111n, 560048n]);
  const names = journey.VIEWPORTS.map((v: { name: string }) => v.name);
  assert.deepEqual(names, ['desktop', 'mobile']);
  const mobile = journey.VIEWPORTS.find((v: { name: string }) => v.name === 'mobile');
  assert.equal(mobile.isMobile, true);
  assert.equal(mobile.hasTouch, true);
  assert.ok(mobile.viewport.width < 500, 'a phone profile is not a narrow desktop window');
});
