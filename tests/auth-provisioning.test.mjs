// Synthetic public identities only. No store key, credential store or service activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAuthConfig, validateAccountBindings } from '../server/config-validation.mjs';
import { initialXionganConfig, runOperatorInit } from '../server/operator-init.mjs';
import { createAuthService } from '../server/auth-service.mjs';
import { MemoryCredentialStore } from '../server/store.mjs';
import { readFileSync } from 'node:fs';
const address = `0x${'1'.repeat(40)}`;
const config = () => initialXionganConfig('synthetic-user', address, ['1', '8453']);
test('public preparation template cannot be activated before verified bindings', () => {
  const template = JSON.parse(readFileSync(new URL('../config/auth.xiongan.preparation.json', import.meta.url)));
  assert.throws(() => validateAuthConfig(template), /AUTH_ACCOUNTS_REQUIRED/);
});
test('initial wallet-only binding has no fabricated password, CA or secret', () => {
  const value = config(); assert.deepEqual(validateAuthConfig(value), { accountCount: 1, bindingCount: 2 });
  assert.deepEqual(Object.keys(value.accounts[0]), ['username', 'wallets']);
});
for (const username of ['__proto__', 'constructor', 'prototype', 'aa', 'UPPERCASE']) test(`refuse invalid username ${username}`, () => {
  assert.throws(() => initialXionganConfig(username, address, ['1']), /AUTH_USERNAME_REFUSED/);
});
test('the same address and chain cannot be bound to another account', () => {
  const value = config(); value.accounts.push({ username: 'other-user', wallets: [{ account: address.toUpperCase().replace('0X','0x'), chainId: '1' }] });
  assert.throws(() => validateAuthConfig(value), /AUTH_DUPLICATE_WALLET_CHAIN_BINDING/);
  assert.throws(() => createAuthService({ ...value, store: new MemoryCredentialStore() }), /AUTH_CONFIG_REFUSED/);
});
test('duplicate within one account is refused but distinct chains remain distinct', () => {
  const value = config(); value.accounts[0].wallets.push(value.accounts[0].wallets[0]);
  assert.throws(() => validateAccountBindings(value.accounts), /AUTH_DUPLICATE/);
});
for (const chain of [1, '01', '0x1', '31337', 'unknown']) test(`operator Ethereum/Base selection refuses ${chain}`, () => {
  assert.throws(() => initialXionganConfig('synthetic-user', address, [chain]), /AUTH_CONFIRMED_CHAIN_SCOPE_REQUIRED/);
});
test('zero address, numeric chain and empty binding are refused', () => {
  assert.throws(() => initialXionganConfig('synthetic-user', `0x${'0'.repeat(40)}`, ['1']), /AUTH_WALLET_BINDING_REFUSED/);
  const value = config(); value.accounts[0].wallets[0].chainId = 1;
  assert.throws(() => validateAuthConfig(value), /AUTH_WALLET_BINDING_REFUSED/);
});
test('unknown client identity fields are not authentication configuration', () => {
  assert.throws(() => validateAuthConfig({ ...config(), operatorIdentifier: 'unverified' }), /AUTH_CONFIG_FIELD_REFUSED/);
});
test('port 443, noncanonical origin and traversal state path are refused', () => {
  for (const delta of [{ port: 443 }, { origin: 'https://xiongan.8415wallet.com:9446/web/' }, { statePath: '/var/lib/../tmp/state' }]) {
    assert.throws(() => validateAuthConfig({ ...config(), ...delta }));
  }
});
test('help has no filesystem or listener side effect', async () => {
  let output = ''; await runOperatorInit(['--help'], {}, { write: text => { output += text; } });
  assert.match(output, /No secret input/);
});
