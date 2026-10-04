import { WalletLogin, WalletLoginError } from './login-core.mjs';
import { verifyMessage, getAddress, hashMessage, Interface } from '../dist/browser/vendor/ethers.js';
import { getReleaseProfile } from './release-profile.mjs';
import { acquireWalletUi, releaseWalletUi } from './ui-lock.mjs';

export { WalletLoginError };
export const walletLogin = new WalletLogin({ crypto: { verifyMessage, getAddress, hashMessage, Interface }, origin: () => globalThis.location.origin });
const el = id => document.getElementById(id);
let timer = null, signing = false;
walletLogin.subscribe((session, reason) => {
  clearTimeout(timer);
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
  signing = true; el('wallet-login').disabled = true; el('wallet-logout').hidden = false;
  try {
    await getReleaseProfile();
    el('wallet-login-status').textContent = 'Check this site, account, chain and expiry in your wallet. Approve only the login message. No transaction is requested.';
    await walletLogin.signIn(globalThis.ethereum);
  } catch (error) {
    el('wallet-login-status').textContent = error instanceof WalletLoginError && error.code === 'LOGIN_REJECTED' ?
      'Login cancelled in your wallet. No assets were loaded. You can try again.' :
      error instanceof WalletLoginError ? error.code : 'LOGIN_RELEASE_CONFIG_REFUSED';
  } finally {
    signing = false; el('wallet-login').disabled = false; releaseWalletUi(lock);
    try { walletLogin.assert(); } catch { el('wallet-logout').hidden = true; }
  }
});
el('wallet-logout').addEventListener('click', () => walletLogin.logout());
globalThis.addEventListener('pagehide', () => walletLogin.logout());
globalThis.addEventListener('pageshow', event => { if (event.persisted) walletLogin.logout(); });
globalThis.addEventListener('focus', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });
document.addEventListener('visibilitychange', () => { try { walletLogin.assert(); } catch { /* Already locked. */ } });
