/** Server-only, fixed-sender OTP mail. No implicit plaintext or retry fallback. */
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { validateMailConfig, pinnedMailLookup } from './mail-config.mjs';

export const OTP_FROM = 'noreply@8415wallet.com';
export const OTP_HOST = 'mail.8415wallet.com';
const refused = () => new Error('AUTH_EMAIL_UNAVAILABLE');
export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || value !== value.trim() || /[^\x21-\x7e]/u.test(value)) throw refused();
  const parts = value.split('@');
  if (parts.length !== 2) throw refused();
  const [local, rawDomain] = parts, domain = rawDomain.toLowerCase();
  if (!local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
    local.startsWith('.') || local.endsWith('.') || local.includes('..') || domain.length > 253 || !domain.includes('.') ||
    !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw refused();
  return `${local}@${domain}`;
}
function messageFor({ to, code, purpose, expiresAt, tenant, origin }) {
  const email = normalizeEmail(to);
  if (typeof code !== 'string' || !/^\d{8}$/.test(code) || !['enroll', 'reset', 'registration', 'method-change'].includes(purpose) || !Number.isSafeInteger(expiresAt) || expiresAt < 0 ||
    typeof tenant !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(tenant)) throw refused();
  let site; try { site = new URL(origin); } catch { throw refused(); }
  if (!['http:', 'https:'].includes(site.protocol) || site.origin !== origin || /[\r\n]/.test(origin)) throw refused();
  const subject = purpose === 'method-change' ? '8415wallet account method change verification' : purpose === 'registration' ? '8415wallet account email verification' : purpose === 'enroll' ? '8415wallet reserved email verification' : '8415wallet security reset verification';
  return { email, data: [
    `From: 8415wallet <${OTP_FROM}>`, `To: <${email}>`, `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@8415wallet.com>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '',
    `Your ${purpose === 'method-change' ? 'account method change verification' : purpose === 'registration' ? 'account email verification' : purpose === 'enroll' ? 'reserved email enrollment' : 'security reset'} code is: ${code}`,
    `Expires: ${new Date(expiresAt).toISOString()}`, `Tenant: ${tenant}`, `Requested at: ${origin}`, '',
    'This code cannot log you in or approve a transaction. Do not share it.',
    'If you did not request it, ignore this message and review your account security.', '',
  ].join('\r\n') };
}

/** Bounded SMTP reply reader. Server replies are never returned/logged verbatim. */
function replies(socket) {
  let buffer = '', closed = false, failure = null, waiter = null, multiline = null, lines = [];
  const ready = []; let total = 0;
  const fail = () => {
    if (failure) return; failure = refused(); closed = true;
    if (waiter) { const current = waiter; waiter = null; current.reject(failure); }
  };
  const emit = reply => {
    if (waiter) { const current = waiter; waiter = null; current.resolve(reply); }
    else if (ready.length < 32) ready.push(reply); else fail();
  };
  socket.on('error', fail); socket.on('close', fail); socket.on('end', fail);
  socket.on('data', chunk => {
    if (closed) return;
    total += chunk.length; if (total > 64 * 1024) { fail(); socket.destroy(); return; }
    buffer += chunk.toString('ascii');
    if (buffer.length > 16 * 1024) { fail(); socket.destroy(); return; }
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const match = /^(\d{3})([ -])([^\r\n]*)$/.exec(line);
      if (!match || line.length > 1000 || (multiline !== null && multiline !== match[1]) || lines.length >= 64) { fail(); socket.destroy(); return; }
      multiline = match[1]; lines.push(match[3]);
      if (match[2] === ' ') { emit({ code: Number(multiline), lines }); multiline = null; lines = []; }
    }
  });
  return {
    next() {
      if (failure) return Promise.reject(failure);
      if (ready.length) return Promise.resolve(ready.shift());
      if (waiter) return Promise.reject(refused());
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    }, fail,
  };
}

/**
 * Implicit TLS SMTP submission, AUTH PLAIN only after verified TLS >=1.2.
 * connect is an in-process test seam, never read from HTTP or environment input.
 * No SMTP operation is attempted merely by creating this sender.
 */
export function createSmtpOtpSender({ port, username, password, addresses, connect = tls.connect, timeoutMs = 10000 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    typeof username !== 'string' || !username || Buffer.byteLength(username) > 256 || /[\x00-\x1f\x7f]/.test(username) ||
    typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024 || /[\x00\r\n]/.test(password) ||
    typeof connect !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw refused();
  const lookup = addresses === undefined ? undefined : pinnedMailLookup(addresses);
  let inFlight = 0;
  return async input => {
    const message = messageFor(input);
    if (inFlight >= 2) throw refused(); inFlight++;
    let socket, timer;
    try {
      socket = connect({ host: OTP_HOST, port, servername: OTP_HOST, minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(lookup ? { lookup } : {}) });
      const reader = replies(socket);
      const secure = new Promise((resolve, reject) => {
        const fail = () => reject(refused());
        socket.once('error', fail); socket.once('close', fail);
        socket.once('secureConnect', () => {
          socket.removeListener('error', fail); socket.removeListener('close', fail);
          if (!socket.encrypted || socket.authorized !== true || !['TLSv1.2', 'TLSv1.3'].includes(socket.getProtocol())) reject(refused()); else resolve();
        });
      });
      // Bound the whole exchange, including connect and DATA acknowledgement.
      timer = setTimeout(() => { reader.fail(); socket.destroy(); }, timeoutMs);
      await secure;
      const expect = async codes => { const reply = await reader.next(); if (!codes.includes(reply.code)) throw refused(); return reply; };
      const command = async (line, codes) => { socket.write(`${line}\r\n`); return expect(codes); };
      await expect([220]);
      const ehlo = await command('EHLO 8415wallet.com', [250]);
      if (!ehlo.lines.some(line => /^AUTH(?:=|\s)(?:.*\s)?PLAIN(?:\s|$)/i.test(line))) throw refused();
      const auth = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      await command(`AUTH PLAIN ${auth}`, [235]);
      await command(`MAIL FROM:<${OTP_FROM}>`, [250]);
      await command(`RCPT TO:<${message.email}>`, [250]);
      await command('DATA', [354]);
      socket.write(`${message.data.replace(/(^|\r\n)\./g, '$1..')}\r\n.\r\n`);
      await expect([250]);
      // Acceptance is final. Do not retry after DATA or let QUIT failure cause a
      // duplicate delivery. Destroy rather than waiting on an optional reply.
      try { socket.write('QUIT\r\n'); } catch { /* The DATA acceptance already succeeded. */ }
      return { accepted: true };
    } catch { throw refused(); }
    finally { if (timer) clearTimeout(timer); socket?.destroy(); inFlight--; }
  };
}

/** Mail task/operator supplies secrets through the existing approved runtime. */
export function createOtpSenderFromEnvironment(env = process.env, installedMail) {
  const keys = ['WALLET_AUTH_SMTP_PORT', 'WALLET_AUTH_SMTP_USERNAME', 'WALLET_AUTH_SMTP_PASSWORD'];
  const mail = installedMail === undefined ? undefined : validateMailConfig(installedMail);
  if (mail?.transport === 'disabled') {
    if (keys.some(key => env[key] !== undefined)) throw refused();
    return null;
  }
  if (mail?.transport === 'smtp' && env.WALLET_AUTH_SMTP_PORT !== String(mail.port)) throw refused();
  if (keys.every(key => env[key] === undefined)) return null;
  if (keys.some(key => typeof env[key] !== 'string' || !env[key]) || !/^\d{1,5}$/.test(env.WALLET_AUTH_SMTP_PORT)) throw refused();
  return createSmtpOtpSender({ port: Number(env.WALLET_AUTH_SMTP_PORT), username: env.WALLET_AUTH_SMTP_USERNAME,
    password: env.WALLET_AUTH_SMTP_PASSWORD, ...(mail?.transport === 'smtp' ? { addresses: mail.addresses } : {}) });
}
