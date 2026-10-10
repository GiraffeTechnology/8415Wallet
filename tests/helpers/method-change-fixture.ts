/** Shared synthetic HTTP fixture for exact combined method-change regression tests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { createAuthService } from '../../server/auth-service.mjs';
import { MemoryCredentialStore } from '../../server/store.mjs';
import { hashPassword, hotp, digest } from '../../server/crypto.mjs';
export const NOW = Date.UTC(2026, 9, 10, 12), OLD = 'synthetic original password', NEW = 'synthetic replacement password';
export const oldHash = await hashPassword(OLD), ANSWER = 'synthetic old security answer', answerHash = await hashPassword(ANSWER);
export const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', EMAIL = 'verified@example.invalid', savedRecovery = Array(8).fill('1234').join('-');
export const profile = () => ({ version: 1, email: EMAIL, questionId: 'recovery-phrase', answerHash, emailVerifiedAt: NOW - 1000 });
export function initial(options: any = {}) {
  return { 'xiongan:tester': { revision: 1, ...(options.registered === false ? {} : { registration: { version: 1, email: EMAIL, verifiedAt: NOW - 1000 } }),
    ...(options.totp ? { secret: SECRET, lastStep: Math.floor(NOW / 30000) - 1, recoverySalt: 'synthetic-salt', recoveryHashes: [digest(`synthetic-salt:${savedRecovery}`)] } : {}),
    ...(options.profile ? { recoveryProfile: profile() } : {}), ...options.credential }, ...(options.registered === false ? {} : {
    '@registration:xiongan': { version: 1, records: [{ username: 'tester', email: EMAIL, verifiedAt: NOW - 1000 }] } }) };
}
export async function fixture(options: any = {}) {
  const signer = Wallet.createRandom(), state = { now: NOW }, messages: any[] = [], store = options.store ?? new MemoryCredentialStore(initial(options));
  let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const accounts = [{ username: 'tester', wallets: [{ account: signer.address, chainId: '1' }], caFingerprints: [], ...(options.passwordless ? {} : { passwordHash: oldHash }) }];
  const restart = (next = store) => { handler = createAuthService({ origin, tenant: 'xiongan', accounts, store: next, now: () => state.now,
    sendOtp: options.noMail ? null : async (message: any) => { messages.push(message); await options.sendGate?.(); } }); };
  restart();
  const client = () => {
    let csrf = ''; const jar = new Map<string, string>();
    const call = async (path: string, body?: any, extra = {}) => {
      const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
        Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0]!.split('='); if (value) jar.set(key!, value); else jar.delete(key!); }
      const data: any = await response.json(); if (response.ok && data.csrf) csrf = data.csrf;
      return { status: response.status, data };
    };
    const login = async () => {
      await call('bootstrap'); const selected = { account: signer.address, chainId: '1' };
      const challenge = (await call('challenge', { method: 'wallet', ...selected })).data;
      const result = await call('proof', { ...selected, id: challenge.id, signature: await signer.signMessage(challenge.message) }); assert.equal(result.status, 200); return result;
    };
    return { call, login };
  };
  const authorize = async (c: ReturnType<typeof client>, intent: any, extra: any = {}) => {
    const start = await c.call('account/change/start', intent); assert.equal(start.status, 200, JSON.stringify(start));
    const identity = start.data.factor === 'wallet' ? { signature: await signer.signMessage(start.data.message) } : { originalPassword: OLD };
    const verified = await c.call('account/change/verify', { changeId: start.data.changeId, ...identity,
      ...(options.totp ? { existingCode: hotp(SECRET, Math.floor(state.now / 30000)) } : {}), ...(options.profile ? { existingAnswer: ANSWER } : {}), ...extra });
    assert.equal(verified.status, 200, JSON.stringify(verified));
    const confirmed = await c.call('account/change/confirm', { changeId: start.data.changeId, code: messages.at(-1).code });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed)); return confirmed.data;
  };
  return { signer, state, messages, store, client, authorize, restart, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
export const commit = (c: any, proof: any, extra = {}) => c.call('account/change/commit', { changeProof: proof.changeProof, ...extra });
