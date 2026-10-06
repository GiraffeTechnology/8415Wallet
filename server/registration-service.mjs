/** Verified email + EOA control creates ordinary accounts, never operator authority. */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { verifyMessage } from 'ethers';
import { randomToken, digest, equal, hashPassword } from './crypto.mjs';
import { loginMessage } from '../web/login-core.mjs';
import { emailIdentity, emailKey, maskEmail, registrationFor } from './account-directory.mjs';
const LIFE = 5 * 60_000, CHALLENGE = 2 * 60_000;
export class RegistrationError extends Error {
  constructor(code = 'AUTH_REFUSED', status = 401) { super(code); this.status = status; }
}
const requireThat = (ok, code = 'AUTH_REFUSED', status = 401) => { if (!ok) throw new RegistrationError(code, status); };
const fields = (body, allowed) => requireThat(Object.keys(body).every(key => allowed.includes(key)), 'AUTH_REGISTRATION_INPUT_REFUSED', 400);
export function createRegistrationService({ origin, tenant, store, directory, sendOtp, now, identity,
  assertPreauth, assertRecent, credentialFor, withConsumedCode, consumeResetProof, revokeAccount }) {
  const pending = new Map(), limits = new Map(), pepper = randomBytes(32); let expensive = 0;
  const stamp = () => { const value = now(); requireThat(Number.isSafeInteger(value) && value >= 0, 'AUTH_CLOCK_REFUSED', 503); return value; };
  function sweep() {
    const time = stamp();
    for (const map of [pending, limits]) for (const [key, value] of map) {
      if (!value.committing && (time < value.issuedAt || time >= value.expiresAt)) map.delete(key);
    }
  }
  function limit(key, max, life = 15 * 60_000) {
    sweep(); let value = limits.get(key), time = stamp();
    if (!value) { requireThat(limits.size < 10000, 'AUTH_BUSY', 503); value = { issuedAt: time, expiresAt: time + life, count: 0 }; limits.set(key, value); }
    requireThat(++value.count <= max, 'AUTH_RATE_LIMITED', 429);
  }
  const slotKey = (context, migration) => `${migration ? 'session' : 'preauth'}:${context.id}`;
  function current(context, slot) {
    requireThat(slot);
    if (slot.migration) assertRecent(context); else assertPreauth(context);
    sweep(); requireThat(pending.get(slot.key) === slot && !slot.cancelled && stamp() >= slot.issuedAt && stamp() < slot.expiresAt);
    requireThat(slot.binding === JSON.stringify([origin, tenant, context.id, slot.migration ?
      [context.username, context.account, context.chainId, context.revision] : null, 'registration', slot.email]));
  }
  function cancel(context, migration = false) {
    const key = slotKey(context, migration), slot = pending.get(key);
    if (slot) slot.cancelled = true;
    pending.delete(key);
    return { cancelled: !slot?.committing, confirmationInProgress: Boolean(slot?.committing) };
  }
  function reserve(context, email, migration, ip) {
    if (migration) assertRecent(context); else assertPreauth(context);
    requireThat(sendOtp, 'AUTH_EMAIL_UNAVAILABLE', 503); sweep();
    const key = slotKey(context, migration);
    requireThat(!pending.get(key)?.committing, 'AUTH_SETUP_STATE_CHANGED', 409);
    limit(`ip:${ip}`, 20); limit(`email:${digest(emailKey(email))}`, 5); limit(`cooldown:${digest(emailKey(email))}`, 1, 60_000);
    limit(`context:${key}`, 5); requireThat(pending.size < 10000, 'AUTH_BUSY', 503);
    const issuedAt = stamp(), expiresAt = Math.min(issuedAt + LIFE, migration ? context.issuedAt + LIFE : context.expiresAt);
    const slot = { id: randomToken(), key, email, migration, issuedAt, expiresAt, attempts: 0, stage: 'sending', salt: randomToken(),
      binding: JSON.stringify([origin, tenant, context.id, migration ? [context.username, context.account, context.chainId, context.revision] : null, 'registration', email]) };
    pending.set(key, slot); return slot;
  }
  function otpHash(slot, code) { return createHmac('sha256', pepper).update(JSON.stringify([slot.binding, slot.id, slot.salt, code])).digest('hex'); }
  async function send(context, slot) {
    current(context, slot); const code = randomInt(100_000_000).toString().padStart(8, '0'); slot.codeHash = otpHash(slot, code);
    try { await sendOtp({ to: slot.email, code, purpose: 'registration', expiresAt: slot.expiresAt, tenant, origin }); }
    catch { if (pending.get(slot.key) === slot) pending.delete(slot.key); throw new RegistrationError('AUTH_EMAIL_UNAVAILABLE', 503); }
    current(context, slot); slot.stage = 'otp';
    return { challengeId: slot.id, expiresAt: slot.expiresAt, emailMasked: maskEmail(slot.email), digits: 8 };
  }
  function takeOtp(context, body, migration) {
    const slot = pending.get(slotKey(context, migration)); current(context, slot);
    requireThat(slot.stage === 'otp' && body.challengeId === slot.id);
    limit(`verify:${slot.key}`, 10); requireThat(slot.attempts++ < 5);
    if (!(typeof body.code === 'string' && /^\d{8}$/.test(body.code) && equal(otpHash(slot, body.code), slot.codeHash))) {
      if (slot.attempts >= 5) pending.delete(slot.key); throw new RegistrationError();
    }
    slot.stage = 'verified'; delete slot.codeHash; return slot;
  }
  function inputEmail(body) {
    try { return emailIdentity(body.email); } catch { throw new RegistrationError('AUTH_REGISTRATION_INPUT_REFUSED', 400); }
  }
  function status(username, credential) {
    const registration = directory.checkCredential(username, credential);
    return { required: !registration, complete: Boolean(registration), email: registration?.email ?? null,
      emailMasked: registration ? maskEmail(registration.email) : null, emailOtpAvailable: Boolean(sendOtp) };
  }
  async function signup(path, body, context, ip) {
    // Revocation must remain possible even when the attempt budget is exhausted.
    if (path === 'registration/cancel') { fields(body, []); return cancel(context); }
    limit(`operations:${ip}`, 100);
    if (path === 'registration/start') {
      fields(body, ['email']); const slot = reserve(context, inputEmail(body), false, ip);
      return send(context, slot); // Existing addresses have the identical delivery/response path.
    }
    if (path === 'registration/verify') {
      fields(body, ['challengeId', 'code']); const slot = takeOtp(context, body, false);
      slot.registrationId = randomToken(); return { verified: true, registrationId: slot.registrationId, expiresAt: slot.expiresAt };
    }
    const slot = pending.get(slotKey(context, false)); current(context, slot);
    requireThat(body.registrationId === slot.registrationId && typeof slot.registrationId === 'string');
    if (path === 'registration/challenge') {
      fields(body, ['registrationId', 'account', 'chainId']); requireThat(['verified', 'challenge'].includes(slot.stage));
      const selected = identity(body), issuedAt = stamp(), expiresAt = Math.min(issuedAt + CHALLENGE, slot.expiresAt), id = randomToken();
      const challenge = { ...selected, origin, tenant, method: 'wallet', id, nonce: randomToken().replace(/[-_]/g, ''), issuedAt, expiresAt };
      challenge.message = loginMessage(challenge).replace('Log in to 8415wallet to view assets and history.',
        'Register an ordinary 8415wallet account using the verified email and this wallet. No administrator or tenant-management authority is granted.') +
        `\nResources:\n- urn:8415wallet:tenant:${tenant}\n- urn:8415wallet:purpose:registration\n- urn:8415wallet:request:${id}\n- urn:8415wallet:registration:${slot.registrationId}\n- urn:8415wallet:email:${digest(emailKey(slot.email))}`;
      slot.challenge = challenge; slot.stage = 'challenge'; return challenge;
    }
    requireThat(path === 'registration/confirm', 'AUTH_ROUTE_REFUSED', 404);
    fields(body, ['registrationId', 'id', 'account', 'chainId', 'signature', 'password']);
    const selected = identity(body), challenge = slot.challenge;
    requireThat(slot.stage === 'challenge' && challenge && body.id === challenge.id && challenge.account === selected.account && challenge.chainId === selected.chainId);
    slot.stage = 'confirming'; // Claim before password hashing or any store await.
    try {
      requireThat(stamp() >= challenge.issuedAt && stamp() < challenge.expiresAt);
      requireThat(typeof body.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(body.signature));
      let recovered; try { recovered = verifyMessage(challenge.message, body.signature); } catch { throw new RegistrationError(); }
      requireThat(recovered === selected.account);
      let passwordHash;
      if (body.password !== undefined) {
        requireThat(typeof body.password === 'string' && body.password.length >= 12 && Buffer.byteLength(body.password) <= 1024, 'AUTH_REGISTRATION_INPUT_REFUSED', 400);
        requireThat(expensive < 2, 'AUTH_BUSY', 503); expensive++;
        try { passwordHash = await hashPassword(body.password); } finally { expensive--; }
      }
      current(context, slot);
      const username = `user-${digest(randomToken()).slice(0, 24)}`, registration = { version: 1, email: slot.email, verifiedAt: stamp() };
      const user = { username, wallets: [selected], caFingerprints: [], ...(passwordHash ? { passwordHash } : {}) };
      await directory.commit(username, registration, user, prior => {
        current(context, slot); requireThat(stamp() < challenge.expiresAt && prior === null); slot.committing = true;
        return { revision: 1, enabledMethods: [...(passwordHash ? ['password'] : []), 'wallet'] };
      });
      // Closing/cancelling after the durable boundary cannot undo creation, but
      // must prevent a late automatic login in the dismissed browser flow.
      current(context, slot);
      return { registered: true, user, selected, bootstrapId: context.id, authorizeSession: () => {
        current(context, slot); requireThat(stamp() < challenge.expiresAt); pending.delete(slot.key);
      } };
    } catch (error) {
      if (pending.get(slot.key) === slot) pending.delete(slot.key);
      if (error instanceof RegistrationError) throw error;
      if (['AUTH_REGISTRATION_CONFLICT', 'AUTH_REGISTRATION_STATE_REFUSED'].includes(error.message)) throw new RegistrationError();
      throw error;
    }
  }
  async function migration(path, body, context, ip) {
    if (path === 'registration/email/cancel') { fields(body, []); return cancel(context, true); }
    assertRecent(context);
    if (path === 'registration/email/start') {
      fields(body, ['email', 'existingCode', 'recovery', 'resetProof']);
      const email = inputEmail(body), slot = reserve(context, email, true, ip);
      try {
        const credential = await credentialFor(context); current(context, slot);
        const registered = registrationFor(credential);
        // Changing an established email needs proof of its old reserved address
        // and answer. Establish those factors first if none have been reserved.
        requireThat(!registered || credential?.recoveryProfile, 'AUTH_RECOVERY_REQUIRED', 409);
        await store.transaction(`${tenant}:${context.username}`, prior => {
          current(context, slot); requireThat((prior?.revision ?? 0) === context.revision);
          const next = prior?.secret ? withConsumedCode(prior, body.existingCode, body.recovery === true) : { ...prior };
          consumeResetProof(context, body.resetProof, prior); return next;
        });
        current(context, slot); return await send(context, slot);
      } catch (error) { if (pending.get(slot.key) === slot) pending.delete(slot.key); throw error; }
    }
    requireThat(path === 'registration/email/confirm', 'AUTH_ROUTE_REFUSED', 404); fields(body, ['challengeId', 'code']);
    const slot = takeOtp(context, body, true);
    try {
      await credentialFor(context); current(context, slot);
      await directory.commit(context.username, { version: 1, email: slot.email, verifiedAt: stamp() }, null, prior => {
        current(context, slot); requireThat((prior?.revision ?? 0) === context.revision); slot.committing = true;
        return { ...prior, ...(prior?.recoveryProfile ? { recoveryProfile: { ...prior.recoveryProfile, email: slot.email, emailVerifiedAt: stamp() } } : {}), revision: context.revision + 1 };
      });
      pending.delete(slot.key); revokeAccount(context.username); return { registered: true, loggedOut: true };
    } catch (error) {
      if (pending.get(slot.key) === slot) pending.delete(slot.key);
      if (['AUTH_REGISTRATION_CONFLICT', 'AUTH_REGISTRATION_STATE_REFUSED'].includes(error.message)) throw new RegistrationError();
      throw error;
    }
  }
  return Object.freeze({ status, signup, migration, cancel });
}
