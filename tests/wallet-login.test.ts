import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage, hashMessage, getAddress, Interface, getBytes, toUtf8String } from 'ethers';
import { WalletLogin, WalletLoginError, verifyLoginSignature, loginMessage, LOGIN_LIFETIME_MS, CHALLENGE_LIFETIME_MS } from '../web/login-core.mjs';

// Ephemeral synthetic signers only. No user wallet, user key, network or transaction.
const crypto = { verifyMessage, hashMessage, getAddress, Interface };
const deferred = () => { let resolve!: (value?: any) => void; return { promise: new Promise<any>(r => { resolve = r; }), resolve: (value?: any) => resolve(value) }; };
function fixture() {
  const signer = Wallet.createRandom(), wrong = Wallet.createRandom();
  let now = Date.UTC(2026, 9, 4), origin = 'https://wallet.example.invalid:18443', account = signer.address, chainId = '0x1';
  let sign: (message: string) => Promise<string> = message => signer.signMessage(message);
  let code = '0x', contractResult = `0x1626ba7e${'0'.repeat(56)}`;
  const listeners = new Map<string, Set<() => void>>(), calls: string[] = [], messages: string[] = [];
  const provider = {
    on(event: string, listener: () => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event: string, listener: () => void) { listeners.get(event)?.delete(listener); },
    async request({ method, params = [] }: any): Promise<any> {
      calls.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
      if (method === 'eth_chainId') return chainId;
      if (method === 'eth_getCode') return code;
      if (method === 'personal_sign') { const message = toUtf8String(getBytes(params[0])); messages.push(message); assert.equal(params[1].toLowerCase(), account.toLowerCase()); return sign(message); }
      if (method === 'eth_call') {
        const decoded = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']).decodeFunctionData('isValidSignature', params[0].data);
        assert.equal(decoded[0], hashMessage(messages.at(-1)!)); assert.equal(params[0].to, account); return contractResult;
      }
      throw new Error('Unexpected request');
    },
  };
  const login = new WalletLogin({ crypto, origin: () => origin, now: () => now });
  return { login, signer, wrong, provider, calls, messages, origin: () => origin, now: () => now,
    setTime: (n: number) => { now = n; }, setOrigin: (s: string) => { origin = s; },
    setAccount: (s: string) => { account = s; }, setChain: (s: string) => { chainId = s; },
    setSign: (s: typeof sign) => { sign = s; }, contract: (result = contractResult) => { code = '0x6000'; contractResult = result; },
    emit: (event: string) => { for (const listener of [...listeners.get(event) ?? []]) listener(); } };
}
test('connection is never login; successful EIP-191 proof is origin/account/chain/expiry bound and memory-only', async () => {
  const f = fixture(); await f.provider.request({ method: 'eth_requestAccounts' }); assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
  const session = await f.login.signIn(f.provider); assert.equal(session.account, f.signer.address); assert.equal(session.kind, 'eoa'); assert.equal(session.chainId, '1');
  assert.equal(session.expiresAt, f.now() + LOGIN_LIFETIME_MS); assert.ok(!('signature' in session)); assert.ok(!('nonce' in session));
  assert.match(f.messages[0]!, /^https:\/\/wallet\.example\.invalid:18443 wants you to sign in/); assert.match(f.messages[0]!, /URI: https:\/\/wallet.example.invalid:18443/);
  assert.match(f.messages[0]!, /Nonce: [0-9a-f]{64}/); assert.match(f.messages[0]!, /Version: 1\nChain ID: 1/);
  assert.ok(!f.calls.includes('eth_getBalance')); assert.ok(!f.calls.includes('eth_sendTransaction'));
  const reload = new WalletLogin({ crypto, origin: f.origin }); assert.throws(() => reload.assert(), /LOGIN_REQUIRED/);
});
for (const reason of ['wrong-account', 'tampered-message', 'bad-signature', 'replayed-signature']) test(`login rejects ${reason}`, async () => {
  const f = fixture(); let signature = '';
  if (reason === 'replayed-signature') { f.setSign(async m => signature = await f.signer.signMessage(m)); await f.login.signIn(f.provider); f.login.logout(); }
  f.setSign(m => reason === 'wrong-account' ? f.wrong.signMessage(m) : reason === 'tampered-message' ? f.signer.signMessage(m.replace('Chain ID: 1', 'Chain ID: 8453')) : Promise.resolve(reason === 'bad-signature' ? '0x1234' : signature));
  await assert.rejects(f.login.signIn(f.provider), /LOGIN_SIGNATURE_REFUSED/); assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
});
for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) test(`${event} clears the session and cancels a pending signature`, async () => {
  const f = fixture(); await f.login.signIn(f.provider); const binding = f.login.capture(); f.emit(event); assert.equal(binding.signal.aborted, true);
  assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
  const gate = deferred(), entered = deferred(); f.setSign(async m => { entered.resolve(); await gate.promise; return f.signer.signMessage(m); });
  const pending = f.login.signIn(f.provider); await entered.promise; f.emit(event); gate.resolve();
  await assert.rejects(pending, /LOGIN_CANCELLED/); assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
});
test('logout, cancellation and repeated clicks cannot resurrect a pending login', async () => {
  const f = fixture(), gate = deferred(), entered = deferred(); f.setSign(async m => { entered.resolve(); await gate.promise; return f.signer.signMessage(m); });
  const pending = f.login.signIn(f.provider); await entered.promise;
  await assert.rejects(f.login.signIn(f.provider), /LOGIN_ALREADY_PENDING/); f.login.logout(); gate.resolve(); await assert.rejects(pending, /LOGIN_CANCELLED/);
  assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/); assert.equal(f.calls.filter(m => m === 'personal_sign').length, 1);
});
test('provider rejection produces a retryable safe cancellation and fresh nonce', async () => {
  const f = fixture(); f.setSign(async () => { throw { code: 4001, message: 'untrusted-secret' }; });
  await assert.rejects(f.login.signIn(f.provider), error => error instanceof WalletLoginError && error.code === 'LOGIN_REJECTED' && !error.message.includes('secret'));
  f.setSign(m => f.signer.signMessage(m)); await f.login.signIn(f.provider); assert.notEqual(f.messages[0], f.messages[1]);
});
for (const mutation of ['expired', 'backward-clock', 'origin', 'account', 'chain']) test(`every operation refuses ${mutation} without relying on timers`, async () => {
  const f = fixture(); await f.login.signIn(f.provider); const binding = f.login.capture();
  if (mutation === 'expired') f.setTime(f.now() + LOGIN_LIFETIME_MS);
  if (mutation === 'backward-clock') f.setTime(f.now() - 1);
  if (mutation === 'origin') f.setOrigin('https://wallet.example.invalid:19443');
  if (mutation === 'account') f.setAccount(f.wrong.address);
  if (mutation === 'chain') f.setChain('0x2105');
  await assert.rejects(f.login.check()); assert.throws(() => f.login.assert()); assert.equal(binding.signal.aborted, true);
});
for (const mutation of ['expiry', 'origin', 'account', 'chain']) test(`challenge ${mutation} during signature verification is refused`, async () => {
  const f = fixture(); f.setSign(async m => {
    const signature = await f.signer.signMessage(m);
    if (mutation === 'expiry') f.setTime(f.now() + CHALLENGE_LIFETIME_MS);
    if (mutation === 'origin') f.setOrigin('https://other.example.invalid:18443');
    if (mutation === 'account') f.setAccount(f.wrong.address);
    if (mutation === 'chain') f.setChain('0x2105');
    return signature;
  });
  await assert.rejects(f.login.signIn(f.provider)); assert.throws(() => f.login.assert());
});
test('nonce reuse is refused even with an injected broken test RNG', async () => {
  const f = fixture(); const login = new WalletLogin({ crypto, origin: f.origin, random: (b: Uint8Array) => b.fill(1) });
  await login.signIn(f.provider); login.logout(); await assert.rejects(login.signIn(f.provider), /LOGIN_NONCE_REFUSED/);
});
test('guarded provider rejects a late response after logout or a replacement session', async () => {
  const f = fixture(); await f.login.signIn(f.provider); const original = f.provider.request, gate = deferred();
  f.provider.request = async args => args.method === 'eth_getBalance' ? gate.promise : original(args);
  const oldProvider = f.login.provider(), pending = oldProvider.request({ method: 'eth_getBalance' });
  await new Promise(resolve => setImmediate(resolve)); f.login.logout();
  await f.login.signIn(f.provider); gate.resolve('0x123'); await assert.rejects(pending, /LOGIN_SESSION_CHANGED/);
  await assert.rejects(oldProvider.request({ method: 'eth_getBalance' }), /LOGIN_SESSION_CHANGED/);
});
test('EIP-1271 verifies the personal-message digest on the selected account and chain', async () => {
  const f = fixture(); f.contract(); const session = await f.login.signIn(f.provider); assert.equal(session.kind, 'eip1271'); assert.equal(f.calls.filter(m => m === 'eth_call').length, 1);
});
for (const result of ['0x', '0xffffffff' + '00'.repeat(28), '0x1626ba7e', `0x1626ba7e${'0'.repeat(55)}1`]) test(`EIP-1271 rejects malformed or incorrect result ${result}`, async () => {
  const f = fixture(); f.contract(result); await assert.rejects(f.login.signIn(f.provider), /LOGIN_CONTRACT_SIGNATURE_REFUSED/); assert.throws(() => f.login.assert());
});
for (const field of ['origin', 'chainId', 'nonce', 'account', 'issuedAt', 'expiresAt']) test(`cryptographic proof cannot be reused for changed ${field}`, async () => {
  const f = fixture(); const base = { origin: f.origin(), account: f.signer.address, chainId: '1', nonce: 'a'.repeat(64), issuedAt: f.now(), expiresAt: f.now() + LOGIN_LIFETIME_MS };
  const signature = await f.signer.signMessage(loginMessage(base));
  const changed: any = { ...base, [field]: field === 'origin' ? 'https://other.example.invalid' : field === 'chainId' ? '8453' : field === 'nonce' ? 'b'.repeat(64) : field === 'account' ? f.wrong.address : base[field as 'issuedAt' | 'expiresAt'] + 1000 };
  await assert.rejects(verifyLoginSignature(f.provider, { ...changed, message: loginMessage(changed) }, signature, crypto), /LOGIN_SIGNATURE_REFUSED/);
});

test('revoked EIP-1271 state locks the session before the next protected read', async () => {
  const f = fixture(); f.contract(); await f.login.signIn(f.provider); const binding = f.login.capture();
  f.contract('0xffffffff' + '00'.repeat(28)); await assert.rejects(f.login.check(), /LOGIN_CONTRACT_SIGNATURE_REFUSED/);
  assert.equal(binding.signal.aborted, true); assert.throws(() => f.login.assert(), /LOGIN_REQUIRED/);
});

test('initial account-permission event is allowed before the challenge, not during signing', async () => {
  const f = fixture(), original = f.provider.request;
  f.provider.request = async args => { if (args.method === 'eth_requestAccounts') f.emit('accountsChanged'); return original(args); };
  await f.login.signIn(f.provider); assert.equal(f.login.assert().account, f.signer.address);
});

test('chain changes and disconnect remain observed after an account-switch lock', async () => {
  for (const event of ['chainChanged', 'disconnect']) {
    const f = fixture(), reasons: string[] = []; f.login.subscribe((_session: any, reason: string) => reasons.push(reason));
    await f.login.signIn(f.provider); f.emit('accountsChanged'); f.emit(event);
    assert.deepEqual(reasons.slice(-2), ['LOGIN_ACCOUNT_CHANGED', event === 'chainChanged' ? 'LOGIN_CHAIN_CHANGED' : 'LOGIN_DISCONNECTED']);
    assert.throws(() => f.login.assert()); await f.login.signIn(f.provider); assert.equal(f.login.assert().account, f.signer.address);
  }
});

for (const change of ['account', 'chain', 'contract-revocation']) test(`held read rejects silent ${change} before returning data`, async () => {
  const f = fixture(); if (change === 'contract-revocation') f.contract(); await f.login.signIn(f.provider);
  const original = f.provider.request, entered = deferred(), gate = deferred();
  f.provider.request = async args => { if (args.method === 'eth_getBalance') { entered.resolve(); return gate.promise; } return original(args); };
  const binding = f.login.capture(), pending = f.login.provider().request({ method: 'eth_getBalance' }); await entered.promise;
  if (change === 'account') f.setAccount(f.wrong.address);
  if (change === 'chain') f.setChain('0x2105');
  if (change === 'contract-revocation') f.contract('0xffffffff' + '00'.repeat(28));
  gate.resolve('private old balance'); await assert.rejects(pending); assert.equal(binding.signal.aborted, true); assert.throws(() => f.login.assert());
});

for (const event of ['chainChanged', 'disconnect']) test(`pre-challenge ${event} cancels re-login and invalidates an account-switch handoff`, async () => {
  const f = fixture(), reasons: string[] = []; f.login.subscribe((_session: any, reason: string) => reasons.push(reason));
  await f.login.signIn(f.provider); f.emit('accountsChanged');
  const original = f.provider.request, entered = deferred(), gate = deferred();
  f.provider.request = async args => { if (args.method === 'eth_requestAccounts') { entered.resolve(); await gate.promise; } return original(args); };
  const pending = f.login.signIn(f.provider); await entered.promise; f.emit(event); gate.resolve();
  await assert.rejects(pending, /LOGIN_CANCELLED/); assert.equal(reasons.at(-1), event === 'chainChanged' ? 'LOGIN_CHAIN_CHANGED' : 'LOGIN_DISCONNECTED');
  assert.throws(() => f.login.assert()); assert.equal(f.calls.filter(method => method === 'personal_sign').length, 1);
});

test('provider address casing stays byte-oriented while the SIWE message uses the canonical checksum', async () => {
  const f = fixture(); const mixed = f.signer.address.replace(/[a-fA-F]/g, value => value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase());
  f.setAccount(mixed); await f.login.signIn(f.provider);
  assert.equal(f.login.assert().account, f.signer.address); assert.ok(f.messages[0]!.includes(`\n${f.signer.address}\n`));
  await f.login.check();
});
