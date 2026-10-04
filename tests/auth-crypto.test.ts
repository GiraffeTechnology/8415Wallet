import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, base32, unbase32, hotp, matchTotp, provisioningUri } from '../server/crypto.mjs';
const secret = base32(Buffer.from('12345678901234567890'));
for (const [time, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']] as const)
  test(`RFC 6238 SHA-1 vector at ${time}`, () => assert.equal(hotp(secret, Math.floor(time / 30), 8), expected));
test('TOTP bounded clock window, canonical Base32 and consumed-counter replay checks', () => {
  assert.deepEqual(unbase32(secret), Buffer.from('12345678901234567890'));
  const step = 1000, now = step * 30000;
  for (const offset of [-1, 0, 1]) assert.equal(matchTotp(secret, hotp(secret, step + offset), now), step + offset);
  for (const offset of [-2, 2]) assert.equal(matchTotp(secret, hotp(secret, step + offset), now), null);
  assert.equal(matchTotp(secret, hotp(secret, step), now, step), null);
  assert.equal(matchTotp(secret, '12345a', now), null);
  assert.throws(() => unbase32('Z'.repeat(33)), /REFUSED/);
  const uri = new URL(provisioningUri(secret, 'xiongan', 'tester'));
  assert.equal(uri.protocol, 'otpauth:'); assert.equal(uri.searchParams.get('secret'), secret);
  assert.equal(uri.searchParams.get('issuer'), '8415wallet (xiongan)'); assert.equal(uri.searchParams.get('digits'), '6');
});
test('passwords have independent random salts, bounded scrypt encoding and safe refusals', async () => {
  const password = 'synthetic-password-only', first = await hashPassword(password), second = await hashPassword(password);
  assert.notEqual(first, second); assert.match(first, /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect', first), false);
  assert.equal(await verifyPassword(password, 'untrusted-hash-parameters'), false);
  await assert.rejects(hashPassword('short'), /LENGTH/);
});
