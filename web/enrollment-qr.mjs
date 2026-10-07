/** Browser-local pixels only. No URI attribute, image URL, network or storage. */
import qrcode from './qr-generator.mjs';
export function clearEnrollmentQr(canvas) {
  canvas.width = 0; canvas.height = 0; canvas.hidden = true;
}
export function renderEnrollmentQr(canvas, uri) {
  clearEnrollmentQr(canvas);
  if (typeof uri !== 'string' || uri.length > 2048 || !/^[\x21-\x7e]+$/.test(uri)) throw Error('AUTH_QR_URI_REFUSED');
  const parsed = new URL(uri);
  if (parsed.protocol !== 'otpauth:' || parsed.hostname !== 'totp' || parsed.hash ||
    !/^[A-Z2-7]{32,128}$/.test(parsed.searchParams.get('secret') ?? '')) throw Error('AUTH_QR_URI_REFUSED');
  const code = qrcode(0, 'M'); code.addData(uri, 'Byte'); code.make();
  const count = code.getModuleCount(), scale = 4, quiet = 4, size = (count + quiet * 2) * scale;
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) { clearEnrollmentQr(canvas); throw Error('AUTH_QR_CANVAS_UNAVAILABLE'); }
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
  context.fillStyle = '#000000';
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    if (code.isDark(row, col)) context.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
  }
  canvas.hidden = false;
}
