import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { validateMailConfig, pinnedMailLookup, smtpReviewOverride, installedMailEnvironment, MAIL_HOST, MAIL_FROM } from '../server/mail-config.mjs';
import { createSmtpOtpSender, createOtpSenderFromEnvironment } from '../server/mail-otp.mjs';

const selected = { transport: 'smtp', port: 465, addresses: ['192.0.2.40', '2001:db8::40'] };
const credentials = { WALLET_AUTH_SMTP_PORT: '465', WALLET_AUTH_SMTP_USERNAME: 'synthetic-user', WALLET_AUTH_SMTP_PASSWORD: 'synthetic-password' };
const lookup = (resolver, host, options = {}) => new Promise((resolve, reject) => resolver(host, options, (error, address, family) => error ? reject(error) : resolve({ address, family })));

test('installed mail defaults disabled and refuses arbitrary destinations, TLS modes and broad IP values', () => {
  assert.deepEqual(validateMailConfig(), { transport: 'disabled' });
  assert.equal(createOtpSenderFromEnvironment({}, validateMailConfig()), null);
  for (const value of [null, [], { transport: 'other' }, { transport: 'disabled', port: 465 },
    { ...selected, host: 'other.invalid' }, { ...selected, from: 'other@example.invalid' }, { ...selected, tls: false },
    ...[0, 443, 65536, '465'].map(port => ({ ...selected, port })),
    ...[[], ['mail.8415wallet.com'], ['0.0.0.0'], ['::'], ['0:0:0:0:0:0:0:0'], ['::1'], ['127.0.0.1'], ['192.0.2.0/24'],
      ['::ffff:127.0.0.1'], ['169.254.169.254'], ['224.0.0.1'], ['ff02::1'], ['fe80::1%eth0'], ['192.0.2.40', '192.0.2.40'],
      ['2001:db8::40', '2001:0db8:0:0:0:0:0:40']].map(addresses => ({ ...selected, addresses }))]) {
    assert.throws(() => validateMailConfig(value), /AUTH_MAIL_CONFIG_REFUSED/);
  }
});

test('pinned lookup implements IPv4/IPv6 and all-address callbacks with no DNS fallback', async () => {
  const resolve = pinnedMailLookup(selected.addresses);
  assert.deepEqual(await lookup(resolve, MAIL_HOST, { family: 4 }), { address: '192.0.2.40', family: 4 });
  assert.deepEqual(await lookup(resolve, MAIL_HOST, { family: 6 }), { address: '2001:db8::40', family: 6 });
  assert.deepEqual((await lookup(resolve, MAIL_HOST, { all: true })).address, [{ address: '192.0.2.40', family: 4 }, { address: '2001:db8::40', family: 6 }]);
  await assert.rejects(lookup(resolve, 'other.invalid'), /AUTH_EMAIL_UNAVAILABLE/);
  await assert.rejects(lookup(pinnedMailLookup(['192.0.2.40']), MAIL_HOST, { family: 6 }), /AUTH_EMAIL_UNAVAILABLE/);
  await assert.rejects(lookup(resolve, MAIL_HOST, { family: 5 }), /AUTH_EMAIL_UNAVAILABLE/);
});

test('review override contains fixed credential references and exact IP allowances but is never applied', () => {
  const disabled = smtpReviewOverride('fixture', { transport: 'disabled' });
  assert.match(disabled, /INERT REVIEW ONLY/); assert.match(disabled, /RestrictAddressFamilies=AF_UNIX\n/);
  assert.doesNotMatch(disabled, /smtp-username|smtp-password|AF_INET/);
  const value = smtpReviewOverride('fixture', selected);
  assert.match(value, /IPAddressDeny=any/); assert.match(value, /IPAddressAllow=192\.0\.2\.40\/32/); assert.match(value, /IPAddressAllow=2001:db8::40\/128/);
  assert.match(value, /LoadCredential=smtp-password:\/etc\/8415wallet-auth-fixture\/smtp-password/);
  assert.match(value, /LoadCredential=store-key:/); assert.doesNotMatch(value, /Environment=|synthetic-password|IPAddressAllow=any|\/0\n/);
  assert.throws(() => smtpReviewOverride('bad\nService', selected), /AUTH_MAIL_CONFIG_REFUSED/);
});

test('selected installed credentials are bounded protected references; missing values reveal no bytes', async () => {
  const directory = '/run/credentials/8415wallet-auth-fixture.service';
  let calls = 0;
  assert.deepEqual(await installedMailEnvironment(undefined, directory, () => { calls++; throw Error(); }), {}); assert.equal(calls, 0);
  const buffers = [], paths = [];
  const env = await installedMailEnvironment(selected, directory, async (path, limit) => {
    paths.push([path, limit]); const value = Buffer.from(path.endsWith('smtp-username') ? 'synthetic-user' : 'synthetic-password'); buffers.push(value); return value;
  });
  assert.deepEqual(env, credentials); assert.ok(buffers.every(bytes => bytes.every(byte => byte === 0)));
  assert.deepEqual(paths, [[`${directory}/smtp-username`, 256], [`${directory}/smtp-password`, 1024]]);
  for (const reader of [async () => { throw Error('private-password-do-not-expose'); }, async () => Buffer.from('bad\nvalue'), async () => Buffer.alloc(1025, 65)]) {
    await assert.rejects(installedMailEnvironment(selected, directory, reader), error => error.message === 'AUTH_MAIL_CREDENTIAL_REQUIRED');
  }
  await assert.rejects(installedMailEnvironment(selected, '/tmp/arbitrary', async () => Buffer.from('synthetic')), /AUTH_MAIL_CONFIG_REFUSED/);
});

test('legacy explicit SMTP environment remains supported but installed disabled/mismatched/partial config refuses it', () => {
  assert.equal(typeof createOtpSenderFromEnvironment(credentials), 'function');
  assert.equal(typeof createOtpSenderFromEnvironment(credentials, selected), 'function');
  assert.throws(() => createOtpSenderFromEnvironment(credentials, { transport: 'disabled' }), /AUTH_EMAIL_UNAVAILABLE/);
  assert.throws(() => createOtpSenderFromEnvironment({}, selected), /AUTH_EMAIL_UNAVAILABLE/);
  assert.throws(() => createOtpSenderFromEnvironment({ ...credentials, WALLET_AUTH_SMTP_PORT: '587' }, selected), /AUTH_EMAIL_UNAVAILABLE/);
  assert.throws(() => createOtpSenderFromEnvironment({ WALLET_AUTH_SMTP_PORT: '465' }, selected), /AUTH_EMAIL_UNAVAILABLE/);
});

test('pinned SMTP retains fixed host/SNI, verified TLS, product purposes and sender without connecting on construction', async () => {
  const connections = [], wire = [];
  class Socket extends Duplex {
    encrypted = true; authorized = true; data = false;
    getProtocol() { return 'TLSv1.3'; }
    _read() {}
    _write(chunk, _encoding, done) {
      const line = chunk.toString(); wire.push(line);
      const reply = text => queueMicrotask(() => { if (!this.destroyed) this.push(`${text}\r\n`); });
      if (this.data) { this.data = false; reply('250 accepted'); }
      else if (line.startsWith('EHLO')) reply('250-fixture\r\n250 AUTH PLAIN');
      else if (line.startsWith('AUTH')) reply('235 authenticated');
      else if (line.startsWith('MAIL') || line.startsWith('RCPT')) reply('250 ok');
      else if (line.startsWith('DATA')) { this.data = true; reply('354 continue'); }
      done();
    }
  }
  const connect = options => { connections.push(options); const socket = new Socket(); queueMicrotask(() => { socket.emit('secureConnect'); socket.push('220 fixture\r\n'); }); return socket; };
  const send = createSmtpOtpSender({ port: 465, username: 'synthetic-user', password: 'synthetic-password', addresses: selected.addresses, connect });
  assert.equal(connections.length, 0);
  for (const purpose of ['enroll', 'reset', 'registration']) await send({ to: 'fixture@example.invalid', code: '12345678', purpose, expiresAt: Date.now() + 300000, tenant: 'fixture', origin: 'https://fixture.example.invalid:19447' });
  for (const options of connections) {
    assert.equal(options.host, MAIL_HOST); assert.equal(options.servername, MAIL_HOST); assert.equal(options.rejectUnauthorized, true); assert.equal(options.minVersion, 'TLSv1.2');
    assert.deepEqual(await lookup(options.lookup, MAIL_HOST, { family: 4 }), { address: '192.0.2.40', family: 4 });
  }
  assert.ok(wire.some(line => line === `MAIL FROM:<${MAIL_FROM}>\r\n`));
  await assert.rejects(send({ to: 'fixture@example.invalid', code: '12345678', purpose: 'login', expiresAt: Date.now(), tenant: 'fixture', origin: 'https://fixture.example.invalid:19447' }), /AUTH_EMAIL_UNAVAILABLE/);
  assert.equal(connections.length, 3);
});
