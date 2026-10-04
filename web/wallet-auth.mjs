import { WalletLogin, WalletLoginError } from './login-core.mjs';
import { AccountAuthClient } from './account-auth.mjs';
import { verifyMessage, getAddress, hashMessage, Interface } from '../dist/browser/vendor/ethers.js';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';

export { WalletLoginError };
export const walletLogin = new WalletLogin({ crypto: { verifyMessage, getAddress, hashMessage, Interface }, origin: () => globalThis.location.origin });
const el = id => document.getElementById(id);
let timer = null, signing = false, attemptRevision = 0, accountClient = null, enrollmentTimer = null;
walletLogin.subscribe((session, reason) => {
  clearTimeout(timer);
  el('auth-enrollment').hidden = !session?.serverId || !['password', 'wallet', 'ca'].includes(session?.kind);
  for (const id of ['auth-password', 'auth-code', 'auth-existing-code', 'auth-enroll-code']) el(id).value = '';
  if (!session) { clearTimeout(enrollmentTimer); el('auth-enroll-secret').textContent = ''; }
  el('auth-recovery-output').hidden = true; el('auth-recovery-codes').textContent = '';
  el('wallet-private').hidden = !session; el('wallet-private').inert = !session;
  el('wallet-logout').hidden = !session && !signing;
  el('wallet-login').hidden = !!session;
  el('wallet-login-status').textContent = session ? `Logged in: ${session.account} · chain ${session.chainId}. This tab expires at ${new Date(session.expiresAt).toISOString()}.` :
    reason === 'LOGIN_EXPIRED' ? 'Login expired. Log in again to view assets and history.' : 'Log in to view assets and history. Connecting an account alone is not login.';
  if (session) timer = setTimeout(() => walletLogin.logout('LOGIN_EXPIRED'), Math.max(0, session.expiresAt - Date.now()));
});
el('wallet-login').addEventListener('click', async () => {
  if (signing) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  const currentAttempt = ++attemptRevision;
  signing = true; el('wallet-login').disabled = true; el('wallet-logout').hidden = false;
  try {
    const profile = await getReleaseProfile();
    if (currentAttempt !== attemptRevision) throw new WalletLoginError('LOGIN_CANCELLED');
    el('wallet-login-status').textContent = 'Check this site, account, chain and expiry in your wallet. Approve only the login message. No transaction is requested.';
    const method = el('wallet-login-method').value || 'wallet-local';
    const credentials = { username: el('auth-username').value, password: el('auth-password').value, code: el('auth-code').value, recovery: el('auth-recovery').checked === true };
    if (method === 'wallet-local') { accountClient = null; await walletLogin.signIn(globalThis.ethereum); }
    else {
      accountClient = new AccountAuthClient({ tenant: profile.tenant.id });
      const adapter = accountClient.adapter(method, credentials);
      // Clear DOM secrets before awaiting a provider or network response.
      el('auth-password').value = ''; el('auth-code').value = '';
      await walletLogin.signIn(globalThis.ethereum, adapter);
    }
  } catch (error) {
    if (currentAttempt !== attemptRevision) return;
    el('wallet-login-status').textContent = error instanceof WalletLoginError && error.code === 'LOGIN_REJECTED' ?
      'Login cancelled in your wallet. No assets were loaded. You can try again.' :
      error instanceof WalletLoginError ? error.code : 'LOGIN_SERVICE_OR_CONFIG_UNAVAILABLE';
  } finally {
    signing = false; el('wallet-login').disabled = false; releaseWalletUi(lock);
    try { walletLogin.assert(); } catch { el('wallet-logout').hidden = true; }
  }
});
function cancelLogin() { attemptRevision++; walletLogin.logout(); }
el('wallet-logout').addEventListener('click', cancelLogin);
globalThis.addEventListener('pagehide', cancelLogin);
globalThis.addEventListener('pageshow', event => { if (event.persisted) cancelLogin(); });
globalThis.addEventListener('focus', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });
document.addEventListener('visibilitychange', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });

function methodChanged() {
  cancelLogin();
  const method = el('wallet-login-method').value;
  el('account-login-fields').hidden = !['password', 'totp'].includes(method);
  el('auth-password-label').hidden = method !== 'password';
  el('auth-code-label').hidden = method !== 'totp'; el('auth-recovery-label').hidden = method !== 'totp';
  el('auth-password').value = ''; el('auth-code').value = '';
  el('auth-method-help').textContent = method === 'wallet-local' ? 'Your private key stays in your wallet. Never paste a seed phrase or private key into this page.' :
    method === 'ca' ? 'Requires your configured hardware CA middleware. The device signs a site-bound challenge; its private key never leaves the device. Unsupported devices fail closed.' :
    'Requires the same-origin authentication service and a pre-registered account-to-wallet binding. Connect the registered wallet account and chain. No automatic account linking.';
}
el('wallet-login-method').addEventListener('change', methodChanged);
async function enroll(action) {
  if (signing || !accountClient) return;
  const lock = acquireWalletUi(); if (lock === null) return;
  signing = true; const currentAttempt = attemptRevision;
  try {
    const binding = walletLogin.capture();
    await walletLogin.check(); walletLogin.assert(binding);
    if (action === 'start') {
      const result = await accountClient.startEnrollment(el('auth-existing-code').value, el('auth-existing-recovery').checked === true);
      walletLogin.assert(binding);
      el('auth-enroll-secret').textContent = `Enter this secret manually in Google Authenticator or FreeOTP:\n${result.secret}\n\nProvisioning URI (keep private):\n${result.uri}\nExpires: ${new Date(result.expiresAt).toISOString()}`;
      clearTimeout(enrollmentTimer); enrollmentTimer = setTimeout(() => { el('auth-enroll-secret').textContent = ''; }, Math.max(0, result.expiresAt - Date.now()));
    } else if (action === 'confirm') {
      const result = await accountClient.confirmEnrollment(el('auth-enroll-code').value);
      walletLogin.assert(binding); cancelLogin();
      el('auth-recovery-codes').textContent = result.recoveryCodes.join('\n'); el('auth-recovery-output').hidden = false;
    } else {
      await accountClient.cancelEnrollment(); walletLogin.assert(binding); clearTimeout(enrollmentTimer); el('auth-enroll-secret').textContent = '';
    }
  } catch (error) {
    if (currentAttempt === attemptRevision) el('wallet-login-status').textContent = error instanceof WalletLoginError ? error.code : 'AUTH_SETUP_UNAVAILABLE';
  } finally {
    el('auth-existing-code').value = ''; el('auth-enroll-code').value = ''; signing = false; releaseWalletUi(lock);
  }
}
el('auth-enroll-start').addEventListener('click', () => enroll('start'));
el('auth-enroll-confirm').addEventListener('click', () => enroll('confirm'));
el('auth-enroll-cancel').addEventListener('click', () => enroll('cancel'));
el('auth-recovery-dismiss').addEventListener('click', () => { el('auth-recovery-codes').textContent = ''; el('auth-recovery-output').hidden = true; });
