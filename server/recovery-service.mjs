/** Reserved recovery factors. No email login or unauthenticated account lookup. */
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { randomToken, digest, equal, hashPassword, verifyPassword } from './crypto.mjs';
import { normalizeEmail } from './mail-otp.mjs';
import { registrationFor } from './account-directory.mjs';

const FRESH = 5 * 60_000, OTP_LIFE = 5 * 60_000, PROOF_LIFE = 2 * 60_000;
const QUESTIONS = Object.freeze(['recovery-phrase', 'first-school', 'childhood-place']);
export class RecoveryError extends Error {
  constructor(code = 'AUTH_REFUSED', status = 401) { super(code); this.status = status; }
}
const requireThat = (ok, code = 'AUTH_REFUSED', status = 401) => { if (!ok) throw new RecoveryError(code, status); };
function answerText(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return null;
  const text = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return text.length >= 12 && Buffer.byteLength(text) <= 512 && !/[\u0000-\u001f\u007f]/u.test(text) ? text : null;
}
function maskedEmail(email) { const [name, host] = email.split('@'); return `${name.slice(0, 1)}***@${host}`; }
function profileFor(credential) {
  registrationFor(credential);
  const profile = credential?.recoveryProfile;
  if (profile === undefined) return null;
  // Corrupt or partial factors must never silently become an unenrolled account.
  requireThat(profile?.version === 1 && QUESTIONS.includes(profile.questionId) &&
    typeof profile.answerHash === 'string' && /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(profile.answerHash) &&
    Number.isSafeInteger(profile.emailVerifiedAt) && profile.emailVerifiedAt >= 0,
  'AUTH_RECOVERY_STATE_REFUSED', 503);
  try { requireThat(normalizeEmail(profile.email) === profile.email, 'AUTH_RECOVERY_STATE_REFUSED', 503); }
  catch { throw new RecoveryError('AUTH_RECOVERY_STATE_REFUSED', 503); }
  return profile;
}

/**
 * All sessions are trusted server objects, never request-body identities.
 * consumeExistingCode calls validateExtra(prior) synchronously after a successful
 * old-code match, inside the same serialized store transaction.
 */
export function createRecoveryService({ origin, tenant, store, sendOtp = null, now = Date.now,
  assertRecent, credentialFor, consumeExistingCode, revokeAccount }) {
  requireThat(typeof origin === 'string' && typeof tenant === 'string' && store &&
    [assertRecent, credentialFor, consumeExistingCode, revokeAccount].every(v => typeof v === 'function') &&
    (sendOtp === null || typeof sendOtp === 'function'), 'AUTH_RECOVERY_CONFIG_REFUSED', 500);
  const pending = new Map(), proofs = new Map(), limits = new Map();
  // Ephemeral OTP digest pepper is unrelated to the persistent encryption key.
  // Restart invalidates every challenge/proof; no pending OTP is persisted.
  const pepper = randomBytes(32); let expensive = 0;
  const stamp = () => { const time = now(); requireThat(Number.isSafeInteger(time) && time >= 0, 'AUTH_CLOCK_REFUSED', 503); return time; };
  function sweep() {
    const time = stamp();
    for (const entries of [pending, proofs, limits]) for (const [key, value] of entries) {
      if (!value.committing && (time < value.issuedAt || time >= value.expiresAt)) entries.delete(key);
    }
  }
  function capacity(entries) { sweep(); requireThat(entries.size < 10000, 'AUTH_BUSY', 503); }
  function limit(key, maximum, life = 15 * 60_000) {
    sweep(); let entry = limits.get(key); const time = stamp();
    if (!entry) { capacity(limits); entry = { count: 0, issuedAt: time, expiresAt: time + life }; limits.set(key, entry); }
    requireThat(++entry.count <= maximum, 'AUTH_RATE_LIMITED', 429);
  }
  function binding(session, purpose) {
    return JSON.stringify([origin, tenant, session.username, session.account, session.chainId, session.id, session.revision, purpose]);
  }
  function requireRecent(session) {
    assertRecent(session);
    requireThat(session && typeof session.id === 'string' && typeof session.username === 'string' &&
      typeof session.account === 'string' && typeof session.chainId === 'string' &&
      Number.isSafeInteger(session.revision) && session.revision >= 0 && Number.isSafeInteger(session.issuedAt) &&
      stamp() >= session.issuedAt && stamp() - session.issuedAt < FRESH,
    'AUTH_RECENT_INDEPENDENT_LOGIN_REQUIRED', 403);
  }
  function current(session, slot) {
    requireRecent(session); sweep();
    requireThat(slot && pending.get(session.id) === slot && slot.binding === binding(session, slot.purpose));
  }
  function checkRevision(session, prior) { requireRecent(session); requireThat((prior?.revision ?? 0) === session.revision); }
  function otpHash(slot, code) {
    return createHmac('sha256', pepper).update(JSON.stringify([slot.binding, slot.id, slot.salt, code])).digest('hex');
  }
  async function costly(operation) {
    requireThat(expensive < 2, 'AUTH_BUSY', 503); expensive++;
    try { return await operation(); } finally { expensive--; }
  }
  function newSlot(session, purpose) {
    requireRecent(session); requireThat(sendOtp, 'AUTH_EMAIL_UNAVAILABLE', 503);
    requireThat(!pending.get(session.id)?.committing, 'AUTH_SETUP_STATE_CHANGED', 409);
    limit(`send:${session.username}`, 5); limit(`cooldown:${session.username}:${purpose}`, 1, 60_000);
    capacity(pending);
    const issuedAt = stamp(), slot = { id: randomToken(), purpose, binding: binding(session, purpose),
      username: session.username, sessionId: session.id, issuedAt,
      expiresAt: Math.min(issuedAt + OTP_LIFE, session.issuedAt + FRESH), salt: randomToken(), attempts: 0, ready: false };
    pending.set(session.id, slot);
    // Starting over invalidates previous reset authorization in this session.
    for (const [key, proof] of proofs) if (proof.sessionId === session.id) proofs.delete(key);
    return slot;
  }
  async function deliver(session, slot, email) {
    current(session, slot); limit(`destination:${digest(email.toLowerCase())}`, 5);
    const code = randomInt(100_000_000).toString().padStart(8, '0'); slot.codeHash = otpHash(slot, code);
    try { await sendOtp({ to: email, code, purpose: slot.purpose, expiresAt: slot.expiresAt, tenant, origin }); }
    catch { if (pending.get(session.id) === slot) pending.delete(session.id); throw new RecoveryError('AUTH_EMAIL_UNAVAILABLE', 503); }
    current(session, slot); slot.ready = true;
    return { challengeId: slot.id, expiresAt: slot.expiresAt, emailMasked: maskedEmail(email), digits: 8 };
  }
  function takeOtp(session, body, purpose) {
    requireRecent(session); sweep(); const slot = pending.get(session.id);
    current(session, slot);
    requireThat(slot.purpose === purpose && slot.ready && body.challengeId === slot.id && !slot.committing);
    limit(`verify:${session.username}`, 10);
    requireThat(slot.attempts++ < 5);
    const valid = typeof body.code === 'string' && /^\d{8}$/.test(body.code) && equal(slot.codeHash, otpHash(slot, body.code));
    if (!valid) { if (slot.attempts >= 5) pending.delete(session.id); throw new RecoveryError(); }
    // Claim before any await. Concurrent confirms cannot both pass.
    slot.ready = false; return slot;
  }
  function status(credential) {
    const profile = profileFor(credential);
    return { configured: Boolean(profile), emailMasked: profile ? maskedEmail(profile.email) : null,
      questionId: profile?.questionId ?? null, emailOtpAvailable: Boolean(sendOtp), questions: [...QUESTIONS] };
  }
  function consumeProof(session, token, prior) {
    checkRevision(session, prior); const profile = profileFor(prior);
    if (!profile) return;
    sweep(); const key = typeof token === 'string' ? digest(token) : '', proof = proofs.get(key);
    requireThat(proof && proof.binding === binding(session, 'reset') && proof.profileHash === digest(JSON.stringify(profile)));
    proofs.delete(key);
  }
  async function startEnrollment(session, body) {
    requireRecent(session);
    let email; try { email = normalizeEmail(body.email); } catch { throw new RecoveryError('AUTH_RECOVERY_INPUT_REFUSED', 400); }
    const answer = answerText(body.answer);
    requireThat(answer && QUESTIONS.includes(body.questionId), 'AUTH_RECOVERY_INPUT_REFUSED', 400);
    // Preserve a submitted old-profile proof while reserving this new operation.
    // newSlot's normal replacement invalidation is deferred until proof consumption.
    const oldProofKey = typeof body.resetProof === 'string' ? digest(body.resetProof) : null;
    const oldProof = oldProofKey ? proofs.get(oldProofKey) : null;
    const slot = newSlot(session, 'enroll');
    if (oldProof) proofs.set(oldProofKey, oldProof);
    try {
      const credential = await credentialFor(session); current(session, slot);
      const registration = registrationFor(credential);
      requireThat(!registration || registration.email === email, 'AUTH_REGISTRATION_EMAIL_MISMATCH', 409);
      const authorize = prior => { current(session, slot); checkRevision(session, prior); consumeProof(session, body.resetProof, prior); };
      if (credential?.secret) await consumeExistingCode(session, body.existingCode, body.recovery === true, authorize);
      else await store.transaction(`${tenant}:${session.username}`, prior => { authorize(prior); return prior ?? { revision: 0 }; });
      current(session, slot);
      slot.profile = { version: 1, email, questionId: body.questionId,
        answerHash: await costly(() => hashPassword(answer)), emailVerifiedAt: 0 };
      current(session, slot); return await deliver(session, slot, email);
    } catch (error) { if (pending.get(session.id) === slot) pending.delete(session.id); throw error; }
  }
  async function confirmEnrollment(session, body) {
    const slot = takeOtp(session, body, 'enroll');
    try {
      await store.transaction(`${tenant}:${session.username}`, prior => {
        current(session, slot); checkRevision(session, prior);
        const registration = registrationFor(prior);
        requireThat(!registration || registration.email === slot.profile.email, 'AUTH_REGISTRATION_EMAIL_MISMATCH', 409);
        slot.committing = true;
        return { ...prior, recoveryProfile: { ...slot.profile, emailVerifiedAt: stamp() }, revision: session.revision + 1 };
      });
    } catch (error) { if (pending.get(session.id) === slot) pending.delete(session.id); throw error; }
    pending.delete(session.id); revokeAccount(session.username);
    return { configured: true, loggedOut: true };
  }
  async function startReset(session, body) {
    requireRecent(session);
    // Never accept a supplied recipient or account selector at reset time.
    requireThat(body.email === undefined && body.to === undefined && body.username === undefined && body.account === undefined &&
      body.chainId === undefined && body.questionId === undefined, 'AUTH_RECOVERY_INPUT_REFUSED', 400);
    limit(`answer:${session.username}`, 5);
    const slot = newSlot(session, 'reset');
    try {
      const credential = await credentialFor(session); current(session, slot); const profile = profileFor(credential);
      const answer = answerText(body.answer);
      const valid = await costly(() => verifyPassword(answer ?? '', profile?.answerHash));
      current(session, slot); requireThat(profile && answer && valid);
      slot.profileHash = digest(JSON.stringify(profile));
      return await deliver(session, slot, profile.email);
    } catch (error) { if (pending.get(session.id) === slot) pending.delete(session.id); throw error; }
  }
  async function confirmReset(session, body) {
    const slot = takeOtp(session, body, 'reset');
    try {
      const prior = await credentialFor(session); current(session, slot); checkRevision(session, prior);
      requireThat(slot.profileHash === digest(JSON.stringify(profileFor(prior))));
      const token = randomToken(), issuedAt = stamp(); capacity(proofs);
      const expiresAt = Math.min(issuedAt + PROOF_LIFE, slot.expiresAt, session.issuedAt + FRESH);
      proofs.set(digest(token), { binding: binding(session, 'reset'), profileHash: slot.profileHash,
        sessionId: session.id, issuedAt, expiresAt });
      pending.delete(session.id); return { resetProof: token, expiresAt };
    } catch (error) { if (pending.get(session.id) === slot) pending.delete(session.id); throw error; }
  }
  function cancel(session) {
    const slot = pending.get(session.id), committing = Boolean(slot?.committing);
    pending.delete(session.id);
    for (const [key, proof] of proofs) if (proof.sessionId === session.id) proofs.delete(key);
    return { cancelled: !committing, confirmationInProgress: committing };
  }
  async function handler(path, body, session) {
    const handlers = { 'recovery/enroll/start': startEnrollment, 'recovery/enroll/confirm': confirmEnrollment,
      'recovery/reset/start': startReset, 'recovery/reset/confirm': confirmReset, 'recovery/cancel': cancel };
    requireThat(Object.hasOwn(handlers, path), 'AUTH_ROUTE_REFUSED', 404);
    return handlers[path](session, body);
  }
  return Object.freeze({ status, handler, consumeProof, cancel, startEnrollment, confirmEnrollment, startReset, confirmReset });
}
