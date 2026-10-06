// Pixels are decoded by an independent, test-only local decoder; never saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderEnrollmentQr, clearEnrollmentQr } from '../web/enrollment-qr.mjs';
const decode = createRequire(import.meta.url)('./vendor/jsqr.cjs');
function canvasFixture() {
  let pixels = new Uint8ClampedArray(0), width = 0, height = 0;
  const context = { fillStyle: '', fillRect(x, y, w, h) {
    const value = this.fillStyle === '#ffffff' ? 255 : 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const offset = (row * width + col) * 4; pixels.fill(value, offset, offset + 3); pixels[offset + 3] = 255;
    }
  } };
  return { hidden: true,
    get width() { return width; }, set width(value) { width = value; pixels = new Uint8ClampedArray(width * height * 4); },
    get height() { return height; }, set height(value) { height = value; pixels = new Uint8ClampedArray(width * height * 4); },
    getContext: () => context, pixels: () => pixels };
}
const secret = 'A'.repeat(32); // Artificial, never a real enrollment credential.
for (const username of ['synthetic-user', '%E6%B5%8B%E8%AF%95', 'long-synthetic-username-for-mobile']) test(`independent pixel decoding roundtrip ${username}`, () => {
  const uri = `otpauth://totp/8415wallet%20%28xiongan%29%3A${username}?secret=${secret}&issuer=8415wallet%20%28xiongan%29&algorithm=SHA1&digits=6&period=30`;
  const canvas = canvasFixture(); renderEnrollmentQr(canvas, uri);
  assert.equal(decode(canvas.pixels(), canvas.width, canvas.height)?.data === uri, true, 'synthetic QR must decode to exact server URI');
  assert.equal(canvas.hidden, false); clearEnrollmentQr(canvas);
  assert.equal(canvas.width, 0); assert.equal(canvas.height, 0); assert.equal(canvas.pixels().length, 0); assert.equal(canvas.hidden, true);
});
for (const uri of ['https://external.invalid/qr', 'otpauth://hotp/test?secret=' + secret, 'otpauth://totp/test?secret=invalid']) test('invalid provisioning URI is refused without leaving pixels', () => {
  const canvas = canvasFixture(); assert.throws(() => renderEnrollmentQr(canvas, uri), /AUTH_QR_URI_REFUSED/);
  assert.equal(canvas.width, 0); assert.equal(canvas.hidden, true);
});
test('canvas unavailable leaves manual fallback possible and no pixels', () => {
  const canvas = canvasFixture(); canvas.getContext = () => null;
  assert.throws(() => renderEnrollmentQr(canvas, `otpauth://totp/test?secret=${secret}`), /AUTH_QR_CANVAS_UNAVAILABLE/);
  assert.equal(canvas.width, 0); assert.equal(canvas.hidden, true);
});
