/** Same-origin, single-process account authentication. No transaction signing authority. */
import { randomToken, digest, equal, verifyPassword, matchTotp, newTotpSecret, provisioningUri, recoveryCodes } from './crypto.mjs';
import { loginOrigin, loginMessage } from '../web/login-core.mjs';
import { verifyMessage, getAddress } from 'ethers';
import { isIP } from 'node:net';
const LIFE = 15 * 60_000, CHALLENGE = 2 * 60_000, ENROLL = 5 * 60_000;
const chains = new Set(['1', '8453', '11155111', '84532', '560048', '31337']);
export class AuthError extends Error {
  constructor(code = 'AUTH_REFUSED', status = 401) { super(code); this.status = status; }
}
const requireThat = (condition, code = 'AUTH_REFUSED', status = 401) => { if (!condition) throw new AuthError(code, status); };
const validUsername = name => typeof name === 'string' && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
function identity(value) {
  requireThat(value && typeof value.account === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.account) &&
    typeof value.chainId === 'string' && chains.has(value.chainId));
  const account = getAddress(value.account.toLowerCase()); requireThat(!/^0x0+$/.test(account));
  return { account, chainId: value.chainId };
}
function cookies(request) {
  const result = new Map();
  for (const entry of (request.headers.cookie ?? '').split(';')) {
    const [name, value, ...extra] = entry.trim().split('=');
    if (name && value && !extra.length && !result.has(name)) result.set(name, value);
  }
  return result;
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function createAuthService({ origin, tenant, accounts, store, verifyCa = null, now = Date.now, trustedProxyHeader = null }) {
  const url = loginOrigin(origin);
  requireThat(trustedProxyHeader === null || (typeof trustedProxyHeader === 'string' && /^x-[a-z0-9-]{1,40}$/.test(trustedProxyHeader)),
    'AUTH_CONFIG_REFUSED', 500);
  // Behind the same-origin proxy every connection comes from loopback, so per-address
  // limits would be shared by all clients. Only the local proxy may name the client,
  // through one configured header that it overwrites; anything else is ignored.
  function clientAddress(req) {
    const socketAddress = req.socket.remoteAddress ?? 'unknown';
    if (!trustedProxyHeader || !LOOPBACK.has(socketAddress)) return socketAddress;
    const named = req.headers[trustedProxyHeader];
    return typeof named === 'string' && isIP(named.trim()) ? named.trim() : socketAddress;
  }
  requireThat(typeof tenant === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(tenant), 'AUTH_CONFIG_REFUSED', 500);
  requireThat(Array.isArray(accounts) && accounts.length > 0 && accounts.length <= 10000 && store, 'AUTH_CONFIG_REFUSED', 500);
  const users = new Map();
  for (const input of accounts) {
    requireThat(validUsername(input.username) && !users.has(input.username) && Array.isArray(input.wallets) && input.wallets.length > 0 && input.wallets.length <= 64,
      'AUTH_CONFIG_REFUSED', 500);
    requireThat(input.passwordHash === undefined || /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(input.passwordHash), 'AUTH_CONFIG_REFUSED', 500);
    requireThat(input.caFingerprints === undefined || (Array.isArray(input.caFingerprints) && input.caFingerprints.every(v => /^[a-f0-9]{64}$/.test(v))), 'AUTH_CONFIG_REFUSED', 500);
    users.set(input.username, Object.freeze({ username: input.username, passwordHash: input.passwordHash,
      wallets: input.wallets.map(identity), caFingerprints: input.caFingerprints ?? [] }));
  }
  const secure = url.protocol === 'https:', sessionName = secure ? '__Host-8415session' : '8415session-local', preauthName = secure ? '__Host-8415preauth' : '8415preauth-local';
  const sessions = new Map(), preauth = new Map(), challenges = new Map(), enrollments = new Map(), limits = new Map();
  let expensive = 0;
  const stamp = () => { const time = now(); requireThat(Number.isSafeInteger(time) && time >= 0, 'AUTH_CLOCK_REFUSED', 503); return time; };
  function sweep() {
    const time = stamp();
    for (const collection of [sessions, preauth, challenges, enrollments, limits]) {
      for (const [key, entry] of collection) if (time < entry.issuedAt || time >= entry.expiresAt) collection.delete(key);
    }
  }
  function capacity(collection) { sweep(); requireThat(collection.size < 10000, 'AUTH_BUSY', 503); }
  function limit(key, maximum, duration = 15 * 60_000) {
    const time = stamp(); let value = limits.get(key);
    if (!value || time >= value.expiresAt || time < value.issuedAt) {
      capacity(limits); value = { count: 0, issuedAt: time, expiresAt: time + duration }; limits.set(key, value);
    }
    requireThat(++value.count <= maximum, 'AUTH_RATE_LIMITED', 429);
  }
  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  function publicSession(session) {
    return { id: session.id, tenant, origin, username: session.username, account: session.account, chainId: session.chainId,
      kind: session.kind, issuedAt: session.issuedAt, expiresAt: session.expiresAt, csrf: session.csrf };
  }
  const boundUser = (name, selected) => {
    const user = validUsername(name) ? users.get(name) : null;
    return user?.wallets.some(wallet => wallet.account === selected.account && wallet.chainId === selected.chainId) ? user : null;
  };
  async function sessionFor(req) {
    sweep(); const token = cookies(req).get(sessionName), session = token ? sessions.get(digest(token)) : null;
    requireThat(session && equal(req.headers['x-wallet-csrf'], session.csrf));
    const credential = await store.read(`${tenant}:${session.username}`);
    requireThat((credential?.revision ?? 0) === session.revision);
    return session;
  }
  function preauthFor(req) {
    sweep(); const token = cookies(req).get(preauthName), state = token ? preauth.get(digest(token)) : null;
    requireThat(state && equal(req.headers['x-wallet-csrf'], state.csrf), 'AUTH_CSRF_REFUSED', 403);
    return state;
  }
  async function issue(req, res, user, selected, kind, expectedRevision) {
    const credential = await store.read(`${tenant}:${user.username}`), time = stamp(), token = randomToken(); capacity(sessions);
    preauthFor(req); // Logout/cancellation also revokes an in-flight login.
    requireThat(expectedRevision === undefined || expectedRevision === (credential?.revision ?? 0));
    const prior = cookies(req).get(sessionName); if (prior) sessions.delete(digest(prior));
    const session = { ...selected, username: user.username, id: randomToken(), csrf: randomToken(), kind,
      issuedAt: time, expiresAt: time + LIFE, revision: credential?.revision ?? 0 };
    sessions.set(digest(token), session); res.setHeader('Set-Cookie', cookie(sessionName, token, LIFE / 1000));
    return publicSession(session);
  }
  async function consumeCode(username, code, recovery = false) {
    let accepted = false, revision;
    await store.transaction(`${tenant}:${username}`, value => {
      if (!value?.secret) throw new AuthError();
      const next = structuredClone(value);
      if (recovery) {
        requireThat(typeof code === 'string' && /^[a-f0-9]{4}(?:-[a-f0-9]{4}){7}$/.test(code));
        const hash = digest(`${value.recoverySalt}:${code}`), index = value.recoveryHashes.findIndex(v => equal(v, hash));
        requireThat(index >= 0); next.recoveryHashes.splice(index, 1);
      } else {
        const step = matchTotp(value.secret, code, stamp(), value.lastStep); requireThat(step !== null); next.lastStep = step;
      }
      accepted = true; revision = next.revision; return next;
    });
    requireThat(accepted); return revision;
  }
  async function readBody(req) {
    requireThat(req.headers['content-type'] === 'application/json', 'AUTH_REQUEST_REFUSED', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; requireThat(size <= 100000, 'AUTH_REQUEST_TOO_LARGE', 413); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); requireThat(value && typeof value === 'object' && !Array.isArray(value)); return value; }
    catch { throw new AuthError('AUTH_REQUEST_REFUSED', 400); }
  }
  async function route(req, res) {
    requireThat(req.headers.host === url.host, 'AUTH_ORIGIN_REFUSED', 403);
    requireThat(req.headers['x-wallet-tenant'] === tenant, 'AUTH_TENANT_REFUSED', 403);
    requireThat(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'AUTH_ORIGIN_REFUSED', 403);
    requireThat(req.url?.startsWith('/auth/') && !req.url.includes('?'), 'AUTH_ROUTE_REFUSED', 404);
    const path = req.url.slice(6), ip = clientAddress(req);
    if (req.method === 'GET' && path === 'capabilities') return { schema: '8415wallet-auth/1', tenant, origin,
      methods: ['password', 'totp', 'wallet', ...(verifyCa ? ['ca'] : [])], totp: { algorithm: 'SHA1', digits: 6, period: 30 }, hardwareCa: verifyCa ? 'bridge-v1' : null };
    if (req.method === 'GET' && path === 'bootstrap') {
      limit(`bootstrap:${ip}`, 60); capacity(preauth);
      const token = randomToken(), csrf = randomToken(), time = stamp();
      const prior = cookies(req).get(preauthName); if (prior) preauth.delete(digest(prior));
      preauth.set(digest(token), { id: randomToken(), csrf, issuedAt: time, expiresAt: time + LIFE });
      res.setHeader('Set-Cookie', cookie(preauthName, token, LIFE / 1000)); return { csrf };
    }
    if (req.method === 'GET' && path === 'session') return publicSession(await sessionFor(req));
    requireThat(req.method === 'POST', 'AUTH_ROUTE_REFUSED', 404);
    requireThat(req.headers.origin === origin, 'AUTH_ORIGIN_REFUSED', 403);
    const body = await readBody(req);
    if (path === 'logout') {
      // A cancelled pre-auth attempt may need to revoke a late-issued session.
      try { await sessionFor(req); } catch { preauthFor(req); }
      const token = cookies(req).get(sessionName); if (token) sessions.delete(digest(token));
      const state = cookies(req).get(preauthName); if (state) preauth.delete(digest(state));
      res.setHeader('Set-Cookie', [cookie(sessionName, '', 0), cookie(preauthName, '', 0)]); return { loggedOut: true };
    }
    if (path.startsWith('totp/enroll/')) {
      const session = await sessionFor(req);
      requireThat(['password', 'wallet', 'ca'].includes(session.kind) && stamp() - session.issuedAt < ENROLL, 'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED', 403);
      limit(`enroll:${session.username}`, 10);
      if (path === 'totp/enroll/start') {
        const credential = await store.read(`${tenant}:${session.username}`);
        if (credential?.secret) await consumeCode(session.username, body.existingCode, body.recovery === true);
        capacity(enrollments); const secret = newTotpSecret(), time = stamp();
        enrollments.set(session.id, { username: session.username, secret, issuedAt: time, expiresAt: time + ENROLL, attempts: 0 });
        return { secret, uri: provisioningUri(secret, tenant, session.username), expiresAt: time + ENROLL };
      }
      if (path === 'totp/enroll/cancel') { enrollments.delete(session.id); return { cancelled: true }; }
      if (path === 'totp/enroll/confirm') {
        sweep(); const pending = enrollments.get(session.id);
        requireThat(pending && pending.username === session.username && ++pending.attempts <= 5);
        const step = matchTotp(pending.secret, body.code, stamp()); requireThat(step !== null);
        // Consume before an asynchronous write: concurrent confirmations cannot
        // activate different recovery sets or reuse the same enrollment.
        enrollments.delete(session.id); const recovery = recoveryCodes();
        await store.transaction(`${tenant}:${session.username}`, prior => ({ secret: pending.secret, lastStep: step,
          recoverySalt: recovery.salt, recoveryHashes: recovery.hashes, revision: (prior?.revision ?? 0) + 1 }));
        for (const [key, current] of sessions) if (current.username === session.username) sessions.delete(key);
        res.setHeader('Set-Cookie', cookie(sessionName, '', 0));
        return { enrolled: true, recoveryCodes: recovery.codes, loggedOut: true };
      }
      throw new AuthError('AUTH_ROUTE_REFUSED', 404);
    }
    const bootstrap = preauthFor(req), selected = identity(body);
    limit(`ip:${ip}`, 100); // Client headers are trusted only from the configured local proxy.
    if (path === 'password' || path === 'totp') {
      requireThat(validUsername(body.username)); limit(`account:${body.username}`, 10);
      const user = boundUser(body.username, selected); let revision;
      if (path === 'password') {
        requireThat(expensive < 2, 'AUTH_BUSY', 503); expensive++;
        let verified;
        try { verified = await verifyPassword(body.password, user?.passwordHash); } finally { expensive--; }
        requireThat(verified && user);
      } else {
        requireThat(user); revision = await consumeCode(user.username, body.code, body.recovery === true);
      }
      return issue(req, res, user, selected, path === 'totp' && body.recovery === true ? 'recovery' : path, revision);
    }
    if (path === 'challenge') {
      requireThat(['wallet', 'ca'].includes(body.method) && (body.method !== 'ca' || verifyCa));
      capacity(challenges); const id = randomToken(), time = stamp(), nonce = randomToken().replace(/[-_]/g, '');
      const context = { ...selected, origin, nonce, issuedAt: time, expiresAt: time + CHALLENGE };
      const message = body.method === 'wallet' ? loginMessage(context) + `\nResources:\n- urn:8415wallet:tenant:${tenant}\n- urn:8415wallet:purpose:login\n- urn:8415wallet:request:${id}` :
        `8415wallet hardware CA login\nOrigin: ${origin}\nTenant: ${tenant}\nAccount: ${selected.account}\nChain ID: ${selected.chainId}\nPurpose: login only; no transaction authority\nRequest: ${id}\nNonce: ${nonce}\nIssued At: ${new Date(time).toISOString()}\nExpiration Time: ${new Date(time + CHALLENGE).toISOString()}`;
      challenges.set(id, { ...context, id, method: body.method, bootstrapId: bootstrap.id, message });
      return { ...context, id, tenant, method: body.method, message };
    }
    if (path === 'proof') {
      sweep(); const challenge = typeof body.id === 'string' ? challenges.get(body.id) : null;
      requireThat(challenge && challenge.bootstrapId === bootstrap.id && challenge.account === selected.account && challenge.chainId === selected.chainId);
      challenges.delete(body.id);
      let user;
      if (challenge.method === 'wallet') {
        requireThat(typeof body.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(body.signature));
        let recovered; try { recovered = verifyMessage(challenge.message, body.signature); } catch { throw new AuthError(); }
        requireThat(recovered === selected.account);
        const matches = [...users.values()].filter(candidate => candidate.wallets.some(w => w.account === selected.account && w.chainId === selected.chainId));
        requireThat(matches.length === 1); user = matches[0];
      } else {
        requireThat(expensive < 2, 'AUTH_BUSY', 503); expensive++;
        let proof;
        try { proof = await verifyCa({ message: challenge.message, signature: body.signature, certificateChain: body.certificateChain, algorithm: body.algorithm }); }
        catch { throw new AuthError(); } finally { expensive--; }
        const matches = [...users.values()].filter(candidate => candidate.caFingerprints.includes(proof.fingerprint) && candidate.wallets.some(w => w.account === selected.account && w.chainId === selected.chainId));
        requireThat(matches.length === 1); user = matches[0];
      }
      requireThat(stamp() >= challenge.issuedAt && stamp() < challenge.expiresAt);
      return issue(req, res, user, selected, challenge.method);
    }
    throw new AuthError('AUTH_ROUTE_REFUSED', 404);
  }
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff');
    // No Access-Control-Allow-Origin: only the configured same-origin UI can read.
    try { const result = await route(req, res); res.statusCode = 200; res.end(JSON.stringify(result)); }
    catch (error) { res.statusCode = error instanceof AuthError ? error.status : 503;
      res.end(JSON.stringify({ error: error instanceof AuthError ? error.message : 'AUTH_UNAVAILABLE' })); }
  };
}
