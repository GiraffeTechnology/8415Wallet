/** Server-only password and RFC 6238 primitives. Never import into the browser. */
import { randomBytes, scrypt, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('PASSWORD_LENGTH_REFUSED');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 });
  return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}
const DUMMY = `scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(64)}`;
export async function verifyPassword(password, stored) {
  const valid = typeof stored === 'string' && /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored);
  const [, salt, expected] = (valid ? stored : DUMMY).split('$');
  const acceptable = typeof password === 'string' && Buffer.byteLength(password) <= 1024;
  const actual = await derive(acceptable ? password : '', salt, 32, { N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 });
  return equal(actual.toString('hex'), expected) && valid && acceptable;
}
export function base32(bytes) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += B32[(value >>> (bits -= 5)) & 31]; } }
  if (bits) result += B32[(value << (5 - bits)) & 31];
  return result;
}
export function unbase32(text) {
  if (typeof text !== 'string' || !/^[A-Z2-7]{32,128}$/.test(text)) throw new Error('TOTP_SECRET_REFUSED');
  let bits = 0, value = 0; const result = [];
  for (const char of text) { value = (value << 5) | B32.indexOf(char); bits += 5; if (bits >= 8) result.push((value >>> (bits -= 8)) & 255); }
  const decoded = Buffer.from(result);
  if (base32(decoded) !== text) throw new Error('TOTP_SECRET_REFUSED');
  return decoded;
}
export const newTotpSecret = () => base32(randomBytes(20));
export function hotp(secret, step, digits = 6) {
  if (!Number.isSafeInteger(step) || step < 0 || ![6, 8].includes(digits)) throw new Error('TOTP_COUNTER_REFUSED');
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', unbase32(secret)).update(counter).digest(), offset = mac[19] & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).toString().padStart(digits, '0');
}
export function matchTotp(secret, code, now, lastStep = -1) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) || !Number.isSafeInteger(now) || now < 0) return null;
  const current = Math.floor(now / 30000); let matched = null;
  // Evaluate every permitted counter without an early-match timing shortcut.
  for (const step of [current - 1, current, current + 1]) {
    if (step >= 0 && equal(hotp(secret, step), code) && step > lastStep) matched = step;
  }
  return matched;
}
export function provisioningUri(secret, tenant, username) {
  unbase32(secret);
  const issuer = `8415wallet (${tenant})`;
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
export function recoveryCodes() {
  const salt = randomToken();
  const codes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex').match(/.{4}/g).join('-'));
  return { codes, salt, hashes: codes.map(code => digest(`${salt}:${code}`)) };
}
