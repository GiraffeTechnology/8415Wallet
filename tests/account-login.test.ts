import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyMessage, getAddress, hashMessage, Interface } from 'ethers';
import { WalletLogin } from '../web/login-core.mjs';
const origin = 'https://wallet.example.invalid:18443', signer = Wallet.createRandom();
function fixture() {
  const calls: string[] = [], state = { account: signer.address, valid: true, revoked: 0, now: Date.now(), gate: null as null | Promise<void> };
  const provider = { on() {}, removeListener() {}, async request({ method }: any) {
    calls.push(method); if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [state.account];
    if (method === 'eth_chainId') return '0x1'; if (method === 'eth_getBalance') return '0x1'; throw Error(method);
  } };
  const session = { id: 'a'.repeat(43), csrf: 'b'.repeat(43), tenant: 'xiongan', account: signer.address, chainId: '1', origin, issuedAt: state.now, expiresAt: state.now + 900000, kind: 'password' };
  const server = { async authenticate() { if (state.gate) await state.gate; return session; }, async check() { if (!state.valid) throw Error('revoked'); return session; }, async logout() { state.revoked++; } };
  const login = new WalletLogin({ crypto: { verifyMessage, getAddress, hashMessage, Interface }, origin: () => origin, now: () => state.now });
  return { calls, state, provider, session, server, login };
}
for (const method of ['password', 'totp', 'recovery', 'wallet', 'ca']) test(`server ${method} identity unlocks only its bound provider and requires live revocation checks`, async () => {
  const f = fixture(); f.session.kind = method; const session = await f.login.signIn(f.provider, f.server);
  assert.equal(session.kind, method); assert.equal(f.calls.includes('personal_sign'), false);
  assert.equal(await f.login.provider().request({ method: 'eth_getBalance' }), '0x1');
  f.state.valid = false; await assert.rejects(f.login.provider().request({ method: 'eth_getBalance' })); assert.throws(() => f.login.assert());
});
for (const field of ['account', 'chainId', 'origin', 'expiresAt', 'kind']) test(`server login rejects substituted ${field}`, async () => {
  const f = fixture(); (f.session as any)[field] = field === 'expiresAt' ? f.state.now + 900001 : 'invalid';
  await assert.rejects(f.login.signIn(f.provider, f.server), /REFUSED/); assert.equal(f.state.revoked, 1); assert.throws(() => f.login.assert());
});
test('late server login is revoked after cancellation and does not unlock the display', async () => {
  const f = fixture(); let release!: () => void;
  f.state.gate = new Promise<void>(resolve => { release = resolve; });
  const pending = f.login.signIn(f.provider, f.server); await new Promise(resolve => setImmediate(resolve));
  f.login.logout(); release(); await assert.rejects(pending, /CANCELLED/); assert.equal(f.state.revoked, 1); assert.throws(() => f.login.assert());
});
test('a connected but substituted provider cannot reuse password authentication', async () => {
  const f = fixture(); await f.login.signIn(f.provider, f.server); f.state.account = Wallet.createRandom().address;
  await assert.rejects(f.login.check(), /CHANGED/); assert.throws(() => f.login.assert());
});
