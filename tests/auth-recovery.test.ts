import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Wallet } from 'ethers';
import { createAuthService } from '../server/auth-service.mjs';
import { createRecoveryService } from '../server/recovery-service.mjs';
import { createSmtpOtpSender, createOtpSenderFromEnvironment, normalizeEmail, OTP_FROM, OTP_HOST } from '../server/mail-otp.mjs';
import { MemoryCredentialStore, openEncryptedStore } from '../server/store.mjs';
import { hashPassword, hotp, matchTotp } from '../server/crypto.mjs';

const answer = 'synthetic reserved recovery phrase', answerHash = await hashPassword(answer);
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const initialNow = Date.UTC(2026, 9, 6, 12);
const profile = () => ({ version: 1, email: 'reserved@example.invalid', questionId: 'recovery-phrase', answerHash, emailVerifiedAt: initialNow - 1000 });
function fixture(options: any = {}) {
  const state = { now: initialNow }, messages: any[] = [], sessions: any[] = [];
  const store = options.store ?? new MemoryCredentialStore({ 'xiongan:tester': {
    revision: 1, ...(options.withTotp ? { secret, lastStep: -1, recoveryHashes: [] } : {}),
    ...(options.withProfile ? { recoveryProfile: profile() } : {}), enabledMethods: ['wallet'],
  } });
  let recovery: any;
  function session(overrides: any = {}) {
    const result = { id: `synthetic-session-${sessions.length}`, username: 'tester', account: `0x${'1'.repeat(40)}`,
      chainId: '1', revision: 1, issuedAt: state.now, kind: 'wallet', active: true, ...overrides };
    sessions.push(result); return result;
  }
  const assertRecent = (value: any) => {
    if (!value.active || !['wallet', 'password', 'ca'].includes(value.kind) || state.now < value.issuedAt || state.now - value.issuedAt >= 300000) throw Error('AUTH_REFUSED');
  };
  const credentialFor = async (value: any) => {
    const prior = await store.read(`xiongan:${value.username}`); assertRecent(value);
    if ((prior?.revision ?? 0) !== value.revision) throw Error('AUTH_REFUSED'); return prior;
  };
  recovery = createRecoveryService({ origin: 'https://wallet.example.invalid', tenant: 'xiongan', store, now: () => state.now,
    sendOtp: options.noMail ? null : options.sendOtp ?? (async (message: any) => { messages.push(message); }), assertRecent, credentialFor,
    consumeExistingCode: async (value: any, code: string, _saved: boolean, authorize: any) => store.transaction(`xiongan:${value.username}`, (prior: any) => {
      assertRecent(value); if (prior.revision !== value.revision) throw Error('AUTH_REFUSED');
      const step = matchTotp(prior.secret, code, state.now, prior.lastStep); if (step === null) throw Error('AUTH_REFUSED');
      authorize(prior); return { ...prior, lastStep: step };
    }),
    revokeAccount: (username: string) => { for (const value of sessions) if (value.username === username) { value.active = false; recovery.cancel(value); } },
  });
  const enrollBody = (extra = {}) => ({ email: 'new-reserved@example.invalid', questionId: 'first-school', answer, ...extra });
  const otpBody = (start: any) => ({ challengeId: start.challengeId, code: messages.at(-1)?.code });
  const prove = async (value: any) => { const start = await recovery.startReset(value, { answer }); return recovery.confirmReset(value, otpBody(start)); };
  return { recovery, store, state, messages, session, enrollBody, otpBody, prove };
}

test('reserved email and question enrollment verifies email before encrypted-state activation and revokes sessions', async () => {
  const f = fixture(), a = f.session(), b = f.session();
  const start = await f.recovery.handler('recovery/enroll/start', f.enrollBody(), a);
  assert.equal(start.digits, 8); assert.equal(start.emailMasked, 'n***@example.invalid');
  assert.equal(f.messages[0].purpose, 'enroll'); assert.match(f.messages[0].code, /^\d{8}$/);
  assert.equal((await f.store.read('xiongan:tester')).recoveryProfile, undefined);
  assert.doesNotMatch(JSON.stringify(start), /answerHash|synthetic reserved|new-reserved|"code"/);
  const result = await f.recovery.handler('recovery/enroll/confirm', f.otpBody(start), a);
  assert.deepEqual(result, { configured: true, loggedOut: true }); assert.equal(a.active, false); assert.equal(b.active, false);
  const saved = await f.store.read('xiongan:tester');
  assert.equal(saved.revision, 2); assert.equal(saved.recoveryProfile.email, 'new-reserved@example.invalid');
  assert.match(saved.recoveryProfile.answerHash, /^scrypt-v1\$/); assert.notEqual(saved.recoveryProfile.answerHash, answerHash);
  assert.doesNotMatch(JSON.stringify(saved), /synthetic reserved recovery phrase/);
  assert.deepEqual(saved.enabledMethods, ['wallet']);
  assert.deepEqual(f.recovery.status(saved), { configured: true, emailMasked: 'n***@example.invalid', questionId: 'first-school',
    emailOtpAvailable: true, questions: ['recovery-phrase', 'first-school', 'childhood-place'] });
});

test('enrollment requires fresh independent identity and existing TOTP when already configured', async () => {
  for (const kind of ['totp', 'recovery']) {
    const f = fixture(); await assert.rejects(f.recovery.startEnrollment(f.session({ kind }), f.enrollBody()), /REFUSED/); assert.equal(f.messages.length, 0);
  }
  const old = fixture(), stale = old.session(); old.state.now += 300000;
  await assert.rejects(old.recovery.startEnrollment(stale, old.enrollBody()), /REFUSED/);
  const wrong = fixture({ withTotp: true });
  await assert.rejects(wrong.recovery.startEnrollment(wrong.session(), wrong.enrollBody({ existingCode: 'wrong' })), /REFUSED/);
  assert.equal(wrong.messages.length, 0);
  const f = fixture({ withTotp: true }), session = f.session();
  const start = await f.recovery.startEnrollment(session, f.enrollBody({ existingCode: hotp(secret, Math.floor(f.state.now / 30000)) }));
  await f.recovery.confirmEnrollment(session, f.otpBody(start));
  const saved = await f.store.read('xiongan:tester'); assert.equal(saved.secret, secret); assert.equal(saved.lastStep, Math.floor(f.state.now / 30000));
});

test('reset challenges only send to the encrypted-store reserved email and never authorize login', async () => {
  const f = fixture({ withProfile: true }), session = f.session();
  for (const field of ['email', 'to', 'username', 'account', 'chainId', 'questionId']) {
    await assert.rejects(f.recovery.startReset(session, { answer, [field]: 'attacker-input' }), /INPUT_REFUSED/);
  }
  const start = await f.recovery.startReset(session, { answer: `  ${answer.toUpperCase()}  ` });
  assert.equal(f.messages[0].to, 'reserved@example.invalid'); assert.equal(f.messages[0].purpose, 'reset');
  const proof = await f.recovery.confirmReset(session, f.otpBody(start));
  assert.equal(typeof proof.resetProof, 'string'); assert.equal(proof.expiresAt, f.state.now + 120000);
  assert.equal((await f.store.read('xiongan:tester')).revision, 1);
  await assert.rejects(f.recovery.confirmReset(session, f.otpBody(start)), /REFUSED/);
  await assert.rejects(f.recovery.handler('email/login', { code: f.messages[0].code }, session), /ROUTE_REFUSED/);
});

test('security answer is mandatory and wrong/no-profile failures reveal no account or email details', async () => {
  for (const withProfile of [true, false]) {
    const f = fixture({ withProfile });
    await assert.rejects(f.recovery.startReset(f.session(), { answer: 'incorrect synthetic recovery answer' }), (error: any) => error.message === 'AUTH_REFUSED');
    assert.equal(f.messages.length, 0);
  }
});

test('reset authorization is account, chain, session, revision and purpose bound and consumed once', async () => {
  const f = fixture({ withProfile: true }), session = f.session(), proof = await f.prove(session), prior = await f.store.read('xiongan:tester');
  for (const overrides of [{ id: 'other' }, { username: 'other' }, { account: `0x${'2'.repeat(40)}` }, { chainId: '8453' }, { revision: 2 }]) {
    assert.throws(() => f.recovery.consumeProof({ ...session, ...overrides }, proof.resetProof, prior), /REFUSED/);
  }
  assert.throws(() => f.recovery.consumeProof(session, proof.resetProof, { ...prior, recoveryProfile: { ...prior.recoveryProfile, email: 'substituted@example.invalid' } }), /REFUSED/);
  f.recovery.consumeProof(session, proof.resetProof, prior);
  assert.throws(() => f.recovery.consumeProof(session, proof.resetProof, prior), /REFUSED/);
});

test('a configured profile cannot be replaced without proof of the old reserved factors', async () => {
  const missing = fixture({ withProfile: true });
  await assert.rejects(missing.recovery.startEnrollment(missing.session(), missing.enrollBody()), /REFUSED/); assert.equal(missing.messages.length, 0);
  const f = fixture({ withProfile: true }), session = f.session(), proof = await f.prove(session);
  f.state.now += 60000;
  const start = await f.recovery.startEnrollment(session, f.enrollBody({ resetProof: proof.resetProof }));
  assert.equal(f.messages[0].to, 'reserved@example.invalid'); assert.equal(f.messages[1].to, 'new-reserved@example.invalid');
  await f.recovery.confirmEnrollment(session, f.otpBody(start));
  assert.equal((await f.store.read('xiongan:tester')).recoveryProfile.email, 'new-reserved@example.invalid');
});

test('a bad existing TOTP does not consume an otherwise valid old-profile reset proof', async () => {
  const f = fixture({ withProfile: true, withTotp: true }), session = f.session(), proof = await f.prove(session);
  f.state.now += 60000;
  await assert.rejects(f.recovery.startEnrollment(session, f.enrollBody({ resetProof: proof.resetProof, existingCode: 'bad' })), /REFUSED/);
  // The same proof still authorizes only this original session/profile. Use it
  // at the transactional current-code check, rather than retrying send cooldown.
  f.recovery.consumeProof(session, proof.resetProof, await f.store.read('xiongan:tester'));
});

test('OTP wrong-purpose, wrong-session, expiry, replay and five failed attempts fail closed', async () => {
  const f = fixture({ withProfile: true }), session = f.session(), start = await f.recovery.startReset(session, { answer });
  await assert.rejects(f.recovery.confirmEnrollment(session, f.otpBody(start)), /REFUSED/);
  await assert.rejects(f.recovery.confirmReset(f.session(), f.otpBody(start)), /REFUSED/);
  for (let n = 0; n < 5; n++) await assert.rejects(f.recovery.confirmReset(session, { challengeId: start.challengeId, code: 'invalid' }), /REFUSED/);
  await assert.rejects(f.recovery.confirmReset(session, f.otpBody(start)), /REFUSED/);
  const e = fixture({ withProfile: true }), s = e.session(), expired = await e.recovery.startReset(s, { answer });
  e.state.now = expired.expiresAt;
  await assert.rejects(e.recovery.confirmReset(s, e.otpBody(expired)), /REFUSED/);
});

test('concurrent valid OTP confirms issue one proof and concurrent proof uses authorize one mutation', async () => {
  const f = fixture({ withProfile: true }), session = f.session(), start = await f.recovery.startReset(session, { answer });
  const results = await Promise.allSettled([f.recovery.confirmReset(session, f.otpBody(start)), f.recovery.confirmReset(session, f.otpBody(start))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const proof = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
  const update = () => f.store.transaction('xiongan:tester', (prior: any) => { f.recovery.consumeProof(session, proof.resetProof, prior); return { ...prior, used: true }; });
  const uses = await Promise.allSettled([update(), update()]); assert.equal(uses.filter((result: any) => result.status === 'fulfilled').length, 1);
});

test('expired proofs, clock reversal and explicit cancel invalidate pending authorization', async () => {
  const f = fixture({ withProfile: true }), session = f.session(), proof = await f.prove(session);
  f.state.now = proof.expiresAt; assert.throws(() => f.recovery.consumeProof(session, proof.resetProof, { revision: 1, recoveryProfile: profile() }), /REFUSED/);
  const c = fixture({ withProfile: true }), s = c.session(), p = await c.prove(s); c.recovery.cancel(s);
  assert.throws(() => c.recovery.consumeProof(s, p.resetProof, { revision: 1, recoveryProfile: profile() }), /REFUSED/);
  const r = fixture({ withProfile: true }), rs = r.session(), start = await r.recovery.startReset(rs, { answer }); r.state.now--;
  await assert.rejects(r.recovery.confirmReset(rs, r.otpBody(start)), /REFUSED/);
});

test('mail unavailability and partial recovery state fail closed, without changing active credentials', async () => {
  const f = fixture({ noMail: true }), session = f.session();
  assert.equal(f.recovery.status(await f.store.read('xiongan:tester')).emailOtpAvailable, false);
  await assert.rejects(f.recovery.startEnrollment(session, f.enrollBody()), /EMAIL_UNAVAILABLE/);
  const failed = fixture({ sendOtp: async () => { throw Error('synthetic secret provider detail'); } });
  await assert.rejects(failed.recovery.startEnrollment(failed.session(), failed.enrollBody()), (error: any) => error.message === 'AUTH_EMAIL_UNAVAILABLE');
  assert.equal((await failed.store.read('xiongan:tester')).recoveryProfile, undefined);
  assert.throws(() => f.recovery.status({ recoveryProfile: {} }), /RECOVERY_STATE_REFUSED/);
});

test('account-wide send cooldown applies across sessions and attempts stay bounded', async () => {
  const f = fixture({ withProfile: true }); await f.recovery.startReset(f.session(), { answer });
  await assert.rejects(f.recovery.startReset(f.session(), { answer }), /RATE_LIMITED/);
  assert.equal(f.messages.length, 1);
  const bounded = fixture({ withProfile: true });
  for (let n = 0; n < 5; n++) { bounded.state.now += 60000; await bounded.recovery.startReset(bounded.session(), { answer }); }
  bounded.state.now += 60000; await assert.rejects(bounded.recovery.startReset(bounded.session(), { answer }), /RATE_LIMITED/);
  assert.equal(bounded.messages.length, 5);
});

function gate() {
  let release!: () => void, entered!: () => void;
  return { waiting: new Promise<void>(r => { release = r; }), started: new Promise<void>(r => { entered = r; }), release: () => release(), entered: () => entered() };
}
test('cancel/logout while mail is in flight cannot revive enrollment or disclose a usable challenge', async () => {
  const pause = gate(), f = fixture({ sendOtp: async () => { pause.entered(); await pause.waiting; } }), session = f.session();
  const result = f.recovery.startEnrollment(session, f.enrollBody()); await pause.started;
  f.recovery.cancel(session); session.active = false; pause.release();
  await assert.rejects(result, /REFUSED/); assert.equal((await f.store.read('xiongan:tester')).recoveryProfile, undefined);
});

test('cancel wins before queued confirmation commit; a commit already persisting is reported honestly', async () => {
  class GatedStore extends MemoryCredentialStore {
    constructor(initial: any) { super(initial); }
    nextTransaction: ReturnType<typeof gate> | null = null; nextPersist: ReturnType<typeof gate> | null = null;
    async transaction(key: string, update: any) { const pause = this.nextTransaction; this.nextTransaction = null; if (pause) { pause.entered(); await pause.waiting; } return super.transaction(key, update); }
    async persist(data: any) { const pause = this.nextPersist; this.nextPersist = null; if (pause) { pause.entered(); await pause.waiting; } return super.persist(data); }
  }
  for (const stage of ['transaction', 'persist']) {
    const store = new GatedStore({ 'xiongan:tester': { revision: 1 } }), f = fixture({ store }), session = f.session();
    const start = await f.recovery.startEnrollment(session, f.enrollBody()), pause = gate();
    if (stage === 'transaction') store.nextTransaction = pause; else store.nextPersist = pause;
    const result = f.recovery.confirmEnrollment(session, f.otpBody(start)); await pause.started;
    assert.deepEqual(f.recovery.cancel(session), { cancelled: stage === 'transaction', confirmationInProgress: stage === 'persist' }); pause.release();
    if (stage === 'transaction') { await assert.rejects(result, /REFUSED/); assert.equal((await store.read('xiongan:tester')).recoveryProfile, undefined); }
    else { assert.equal((await result).configured, true); assert.equal((await store.read('xiongan:tester')).revision, 2); }
  }
});

test('reserved email and slow-hashed answer survive encrypted restart without plaintext or pending OTP replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-recovery-test-')); t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, 'synthetic.enc'), key = Buffer.alloc(32, 73), store = await openEncryptedStore(path, key);
  await store.transaction('xiongan:tester', () => ({ revision: 1 }));
  const f = fixture({ store }), session = f.session(), start = await f.recovery.startEnrollment(session, f.enrollBody());
  await f.recovery.confirmEnrollment(session, f.otpBody(start)); await store.close();
  assert.doesNotMatch(await readFile(path, 'utf8'), /reserved|example|synthetic|answerHash|questionId|scrypt/);
  const restored = await openEncryptedStore(path, key);
  const later = fixture({ store: restored }); assert.equal(later.recovery.status(await restored.read('xiongan:tester')).configured, true);
  await assert.rejects(later.recovery.confirmEnrollment(later.session({ revision: 2 }), f.otpBody(start)), /REFUSED/); await restored.close();
});

function fakeSmtp(options: any = {}) {
  const wire: string[] = [], connection: any[] = []; let data = false;
  class Socket extends Duplex {
    encrypted = true; authorized = options.authorized !== false;
    getProtocol() { return options.protocol ?? 'TLSv1.3'; }
    override _read() {}
    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
      const line = chunk.toString(); wire.push(line);
      const reply = (value: string) => queueMicrotask(() => { if (!this.destroyed) this.push(`${value}\r\n`); });
      if (data) { data = false; if (!options.missingAcceptance) reply(options.rejectData ? '550 rejected' : '250 queued'); }
      else if (line.startsWith('EHLO')) reply(options.noAuth ? '250 hello' : '250-mail.example.invalid\r\n250-AUTH PLAIN\r\n250 SIZE 100000');
      else if (line.startsWith('AUTH')) reply(options.rejectAuth ? '535 failed synthetic-private-detail' : '235 authenticated');
      else if (line.startsWith('MAIL') || line.startsWith('RCPT')) reply('250 ok');
      else if (line.startsWith('DATA')) { data = true; reply('354 continue'); }
      done();
    }
  }
  const connect = (config: any) => { connection.push(config); const socket = new Socket(); queueMicrotask(() => { socket.emit('secureConnect'); socket.push('220 synthetic SMTP\r\n'); }); return socket; };
  return { connect, wire, connection };
}
const emailMessage = () => ({ to: 'reserved@example.invalid', code: '12345678', purpose: 'reset', expiresAt: initialNow + 300000,
  tenant: 'xiongan', origin: 'https://wallet.example.invalid' });
test('fake SMTP proves fixed sender/host, verified implicit TLS, authenticated envelope and bounded reset-only content', async () => {
  const smtp = fakeSmtp(), send = createSmtpOtpSender({ port: 465, username: 'synthetic-user', password: 'synthetic-password', connect: smtp.connect });
  assert.equal(smtp.connection.length, 0); assert.deepEqual(await send(emailMessage()), { accepted: true });
  assert.deepEqual(smtp.connection[0], { host: OTP_HOST, port: 465, servername: OTP_HOST, minVersion: 'TLSv1.2', rejectUnauthorized: true });
  assert.match(smtp.wire.join(''), new RegExp(`MAIL FROM:<${OTP_FROM}>`));
  assert.match(smtp.wire.join(''), /RCPT TO:<reserved@example.invalid>/); assert.match(smtp.wire.join(''), /AUTH PLAIN /);
  assert.match(smtp.wire.join(''), /cannot log you in or approve a transaction/);
  assert.doesNotMatch(smtp.wire.join(''), /answerHash|questionId|AUTH LOGIN|STARTTLS/);
});
test('fake SMTP accepts registration purpose only as email verification with the fixed sender', async () => {
  const smtp = fakeSmtp(), send = createSmtpOtpSender({ port: 465, username: 'synthetic', password: 'synthetic', connect: smtp.connect });
  assert.deepEqual(await send({ ...emailMessage(), purpose: 'registration' }), { accepted: true });
  assert.match(smtp.wire.join(''), /Subject: 8415wallet account email verification/);
  assert.match(smtp.wire.join(''), /Your account email verification code is: 12345678/);
  assert.match(smtp.wire.join(''), /cannot log you in or approve a transaction/);
  assert.equal(smtp.connection.length, 1);
});
test('SMTP rejects invalid TLS, missing AUTH and rejected delivery without fallback or raw diagnostic leakage', async () => {
  for (const options of [{ authorized: false }, { protocol: 'TLSv1.1' }, { noAuth: true }, { rejectAuth: true }, { rejectData: true }]) {
    const smtp = fakeSmtp(options), send = createSmtpOtpSender({ port: 465, username: 'synthetic', password: 'synthetic', connect: smtp.connect });
    await assert.rejects(send(emailMessage()), (error: any) => error.message === 'AUTH_EMAIL_UNAVAILABLE');
    assert.equal(smtp.connection.length, 1);
    if (options.authorized === false || options.protocol || options.noAuth) assert.doesNotMatch(smtp.wire.join(''), /AUTH PLAIN/);
  }
});
test('mail adapter refuses header/SMTP injection, login-purpose OTP and incomplete runtime configuration', async () => {
  assert.equal(createOtpSenderFromEnvironment({}), null);
  for (const env of [{ WALLET_AUTH_SMTP_PORT: '465' }, { WALLET_AUTH_SMTP_PORT: '443', WALLET_AUTH_SMTP_USERNAME: 'test', WALLET_AUTH_SMTP_PASSWORD: 'test' }]) {
    assert.throws(() => createOtpSenderFromEnvironment(env), /EMAIL_UNAVAILABLE/);
  }
  for (const address of ['victim@example.invalid\r\nBcc: attacker@example.invalid', 'x@localhost', 'a..b@example.invalid', 'a@-bad.invalid', '<x@example.invalid>']) assert.throws(() => normalizeEmail(address));
  assert.equal(normalizeEmail('User+tag@EXAMPLE.INVALID'), 'User+tag@example.invalid');
  const smtp = fakeSmtp(), send = createSmtpOtpSender({ port: 465, username: 'synthetic', password: 'synthetic', connect: smtp.connect });
  for (const input of [{ ...emailMessage(), purpose: 'login' }, { ...emailMessage(), code: '1234\r\n' }, { ...emailMessage(), tenant: 'x\r\nBcc: attacker' }]) await assert.rejects(send(input), /EMAIL_UNAVAILABLE/);
  assert.equal(smtp.connection.length, 0);
});

test('SMTP timeout after DATA is a single failed attempt, with no resend or plaintext fallback', async () => {
  const smtp = fakeSmtp({ missingAcceptance: true }), send = createSmtpOtpSender({ port: 465, username: 'synthetic', password: 'synthetic', connect: smtp.connect, timeoutMs: 100 });
  await assert.rejects(send(emailMessage()), /EMAIL_UNAVAILABLE/);
  assert.equal(smtp.connection.length, 1); assert.equal(smtp.wire.filter(line => line.startsWith('DATA')).length, 1);
});

async function httpFixture(options: any = {}) {
  const signer = Wallet.createRandom(), state = { now: initialNow }, messages: any[] = [];
  const initial = { revision: 1, ...(options.empty ? {} : { secret, lastStep: -1, recoveryHashes: [], recoveryProfile: profile() }) };
  const store = new MemoryCredentialStore({ 'xiongan:tester': initial }); let handler: any;
  const server = createServer((req, res) => handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  handler = createAuthService({ origin, tenant: 'xiongan', store, now: () => state.now,
    accounts: [{ username: 'tester', wallets: [{ account: signer.address, chainId: '1' }] }],
    sendOtp: async (message: any) => { messages.push(message); } });
  const client = () => {
    const jar = new Map<string, string>(); let csrf = '';
    const call = async (path: string, body?: any, headers: Record<string, string> = {}) => {
      const response = await fetch(`${origin}/auth/${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: origin, 'X-Wallet-Tenant': 'xiongan', 'X-Wallet-CSRF': csrf,
          Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const cookie of response.headers.getSetCookie()) { const [key, value] = cookie.split(';')[0]!.split('='); if (value) jar.set(key!, value); else jar.delete(key!); }
      const data = await response.json() as any; if (response.ok && data.csrf) csrf = data.csrf;
      return { status: response.status, data, headers: response.headers };
    };
    const login = async () => {
      await call('bootstrap'); const selected = { account: signer.address, chainId: '1' };
      const challenge = await call('challenge', { ...selected, method: 'wallet' });
      const result = await call('proof', { ...selected, id: challenge.data.id, signature: await signer.signMessage(challenge.data.message) });
      assert.equal(result.status, 200); return result;
    };
    return { call, login };
  };
  const prove = async (c: ReturnType<typeof client>) => {
    const start = await c.call('recovery/reset/start', { answer }); assert.equal(start.status, 200);
    const result = await c.call('recovery/reset/confirm', { challengeId: start.data.challengeId, code: messages.at(-1).code });
    assert.equal(result.status, 200); return result.data;
  };
  return { store, state, messages, client, prove, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('HTTP recovery requires authenticated CSRF/origin/tenant-bound fresh sessions and never exposes a login route', async t => {
  const f = await httpFixture({ empty: true }); t.after(f.close); const c = f.client();
  assert.equal((await c.call('recovery/reset/start', { answer })).status, 401);
  await c.login();
  for (const headers of [{ 'X-Wallet-CSRF': 'wrong' }, { Origin: 'https://evil.invalid' }, { 'X-Wallet-Tenant': 'other' }]) {
    assert.notEqual((await c.call('recovery/enroll/start', { email: 'new@example.invalid', questionId: 'recovery-phrase', answer }, headers)).status, 200);
  }
  assert.equal(f.messages.length, 0);
  const start = await c.call('recovery/enroll/start', { email: 'new@example.invalid', questionId: 'recovery-phrase', answer });
  assert.equal(start.status, 200); assert.equal(start.headers.get('cache-control'), 'no-store');
  const confirm = await c.call('recovery/enroll/confirm', { challengeId: start.data.challengeId, code: f.messages.at(-1).code });
  assert.equal(confirm.status, 200); assert.equal(confirm.data.loggedOut, true); assert.equal((await c.call('session')).status, 401);
  await c.login(); const account = await c.call('account'); assert.equal(account.data.recovery.configured, true);
  assert.doesNotMatch(JSON.stringify(account.data), /answerHash|new@example|synthetic reserved/);
  const methods = await c.call('capabilities'); assert.equal(methods.data.methods.includes('email'), false);
  f.state.now += 300000; assert.equal((await c.call('recovery/reset/start', { answer })).status, 403);
});

test('HTTP TOTP replacement needs all configured reset factors and preserves recovery profile after confirmation', async t => {
  const f = await httpFixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.login(); await other.login();
  const code = hotp(secret, Math.floor(f.state.now / 30000));
  assert.equal((await c.call('totp/enroll/start', { purpose: 'replace', existingCode: code })).status, 401);
  assert.equal((await f.store.read('xiongan:tester')).lastStep, -1);
  const proof = await f.prove(c);
  assert.equal((await c.call('totp/enroll/start', { purpose: 'replace', existingCode: 'bad', resetProof: proof.resetProof })).status, 401);
  assert.equal((await other.call('totp/enroll/start', { purpose: 'replace', existingCode: code, resetProof: proof.resetProof })).status, 401);
  assert.equal((await f.store.read('xiongan:tester')).lastStep, -1);
  const setup = await c.call('totp/enroll/start', { purpose: 'replace', existingCode: code, resetProof: proof.resetProof }); assert.equal(setup.status, 200);
  const confirmation = await c.call('totp/enroll/confirm', { enrollmentId: setup.data.enrollmentId, code: hotp(setup.data.secret, Math.floor(f.state.now / 30000)) });
  assert.equal(confirmation.status, 200); assert.equal(confirmation.data.recoveryCodes.length, 8);
  assert.deepEqual((await f.store.read('xiongan:tester')).recoveryProfile, profile());
  assert.equal((await other.call('session')).status, 401); await c.login(); f.state.now += 30000;
  assert.equal((await c.call('totp/enroll/start', { purpose: 'replace', existingCode: hotp(setup.data.secret, Math.floor(f.state.now / 30000)), resetProof: proof.resetProof })).status, 401);
});

test('HTTP method preference changes revoke pending reset proofs without discarding reserved recovery factors', async t => {
  const f = await httpFixture(); t.after(f.close); const c = f.client(), other = f.client(); await c.login(); await other.login();
  const proof = await f.prove(c);
  const change = await other.call('account/methods', { enabledMethods: ['wallet'], existingCode: hotp(secret, Math.floor(f.state.now / 30000)) });
  assert.equal(change.status, 200); assert.equal(change.data.loggedOut, true); assert.equal((await c.call('session')).status, 401);
  await c.login(); const account = await c.call('account'); assert.equal(account.data.recovery.configured, true); assert.equal(account.data.methods.totp.enabled, false);
  assert.deepEqual((await f.store.read('xiongan:tester')).recoveryProfile, profile());
  f.state.now += 30000;
  const reset = await c.call('totp/enroll/start', { purpose: 'replace', existingCode: hotp(secret, Math.floor(f.state.now / 30000)), resetProof: proof.resetProof });
  assert.equal(reset.status, 401);
});
