/** Ordinary account and verified-email directory, encrypted in the existing v1 store. */
import { validateAccountBindings } from './config-validation.mjs';
import { normalizeEmail } from './mail-otp.mjs';
import { getAddress } from 'ethers';
const fail = () => { throw new Error('AUTH_REGISTRATION_STATE_REFUSED'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
// Conservative uniqueness/alias policy: case-fold the entire address. Delivery
// retains the local part. This may refuse rare case-distinct RFC mailboxes.
// Do not merge dot aliases, plus aliases or mail-provider-specific identities.
export const emailIdentity = normalizeEmail;
export const emailKey = value => normalizeEmail(value).toLowerCase();
export function registrationFor(credential) {
  const value = credential?.registration;
  if (value === undefined) return null;
  if (!exact(value, ['version', 'email', 'verifiedAt']) || value.version !== 1 ||
    !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt < 0) fail();
  try { if (emailIdentity(value.email) !== value.email) fail(); } catch { fail(); }
  if (credential?.recoveryProfile && credential.recoveryProfile.email !== value.email) fail();
  return value;
}
export const maskEmail = email => { const [name, host] = email.split('@'); return `${name.slice(0, 1)}***@${host}`; };

export function createAccountDirectory({ tenant, accounts, store, users }) {
  const key = `@registration:${tenant}`;
  const configured = accounts.map(user => ({ ...user, wallets: user.wallets.map(wallet => ({ ...wallet, account: getAddress(wallet.account.toLowerCase()) })), caFingerprints: user.caFingerprints ?? [] }));
  let current;
  function validate(raw) {
    const value = raw === null ? { version: 1, records: [] } : raw;
    if (!exact(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 10000) fail();
    const names = new Set(), emails = new Map(), ordinary = [];
    for (const record of value.records) {
      if (!exact(record, ['username', 'email', 'verifiedAt', 'ordinaryAccount']) ||
        typeof record.username !== 'string' || names.has(record.username)) fail();
      registrationFor({ registration: { version: 1, email: record.email, verifiedAt: record.verifiedAt } });
      if (emails.has(emailKey(record.email))) fail(); names.add(record.username); emails.set(emailKey(record.email), record.username);
      if (record.ordinaryAccount !== undefined) {
        const user = record.ordinaryAccount;
        if (!exact(user, ['username', 'wallets', 'passwordHash', 'caFingerprints']) || user.username !== record.username ||
          !Array.isArray(user.caFingerprints) || user.caFingerprints.length !== 0 || user.wallets?.length !== 1) fail();
        ordinary.push(user);
      } else if (!configured.some(user => user.username === record.username)) fail();
    }
    try { if (configured.length + ordinary.length) validateAccountBindings([...configured, ...ordinary]); } catch { fail(); }
    return { value, emails, accounts: [...configured, ...ordinary] };
  }
  function publish(raw) {
    current = validate(raw); users.clear();
    for (const user of current.accounts) users.set(user.username, Object.freeze({ ...user,
      wallets: user.wallets.map(wallet => ({ ...wallet, account: getAddress(wallet.account.toLowerCase()) })), caFingerprints: user.caFingerprints ?? [] }));
  }
  // Startup is read-only. An old v1 credential file needs no conversion or new key.
  const ready = store.read(key).then(async raw => {
    publish(raw);
    for (const user of current.accounts) checkCredential(user.username, await store.read(`${tenant}:${user.username}`));
  }); ready.catch(() => {});
  function alias(value) {
    try { return current.emails.get(emailKey(value)) ?? null; } catch { return null; }
  }
  function checkCredential(username, credential) {
    const registration = registrationFor(credential), record = current.value.records.find(record => record.username === username);
    if (Boolean(registration) !== Boolean(record) || record && (record.email !== registration.email || record.verifiedAt !== registration.verifiedAt)) fail();
    return registration;
  }
  async function commit(username, registration, ordinaryAccount, updateCredential) {
    const credentialKey = `${tenant}:${username}`;
    const saved = await store.transactionMany([key, credentialKey], values => {
      const directory = validate(values[key]), prior = values[credentialKey];
      const existing = directory.value.records.find(record => record.username === username);
      const known = directory.accounts.find(user => user.username === username);
      const owner = directory.emails.get(emailKey(registration.email));
      if (owner && owner !== username) throw new Error('AUTH_REGISTRATION_CONFLICT');
      if (ordinaryAccount && directory.value.records.filter(record => record.ordinaryAccount).length >= 1000) throw new Error('AUTH_REGISTRATION_CAPACITY');
      if (ordinaryAccount && (known || prior !== null || existing)) throw new Error('AUTH_REGISTRATION_CONFLICT');
      if (!ordinaryAccount && !known) fail();
      const before = registrationFor(prior);
      if (Boolean(before) !== Boolean(existing) || existing && (existing.email !== before.email || existing.verifiedAt !== before.verifiedAt)) fail();
      const next = updateCredential(prior);
      const record = { username, email: registration.email, verifiedAt: registration.verifiedAt,
        ...(ordinaryAccount ? { ordinaryAccount } : existing?.ordinaryAccount ? { ordinaryAccount: existing.ordinaryAccount } : {}) };
      const directoryNext = { version: 1, records: [...directory.value.records.filter(record => record.username !== username), record] };
      // Check configured and dynamic wallet/chain uniqueness inside the commit queue.
      validate(directoryNext);
      const credentialNext = { ...next, registration };
      registrationFor(credentialNext);
      return { [key]: directoryNext, [credentialKey]: credentialNext };
    });
    publish(saved[key]); return users.get(username);
  }
  return Object.freeze({ key, ready, alias, checkCredential, commit });
}
