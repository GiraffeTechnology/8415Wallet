/** Same-origin account login client. Passwords/codes are never persisted. */
import { WalletLoginError } from './login-core.mjs';
export class AccountAuthClient {
  #tenant; #fetch; #csrf = null; #session = null; #origin;
  constructor({ tenant, origin = globalThis.location.origin, fetcher = globalThis.fetch.bind(globalThis) }) { this.#tenant = tenant; this.#fetch = fetcher; this.#origin = origin; }
  async request(path, body, { keepalive = false } = {}) {
    const response = await this.#fetch(new URL(`/auth/${path}`, this.#origin), { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      headers: { 'X-Wallet-Tenant': this.#tenant, ...(this.#csrf ? { 'X-Wallet-CSRF': this.#csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); if (text.length > 16384) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
    let result; try { result = JSON.parse(text); } catch { throw new WalletLoginError('LOGIN_SERVICE_UNAVAILABLE'); }
    if (!response.ok) throw new WalletLoginError(typeof result.error === 'string' && /^AUTH_[A-Z_]+$/.test(result.error) ? result.error : 'LOGIN_SERVICE_UNAVAILABLE');
    return result;
  }
  async capabilities() {
    const value = await this.request('capabilities');
    if (value.schema !== '8415wallet-auth/1' || value.tenant !== this.#tenant || value.origin !== this.#origin) throw new WalletLoginError('LOGIN_SERVICE_BINDING_REFUSED');
    return value;
  }
  adapter(method, credentials = {}, caBridge = globalThis.walletCaBridge) {
    return {
      authenticate: async (identity, provider) => {
        const available = await this.capabilities();
        if (!available.methods.includes(method)) throw new WalletLoginError('LOGIN_METHOD_UNAVAILABLE');
        const bootstrap = await this.request('bootstrap'); this.#csrf = bootstrap.csrf;
        let session;
        if (['password', 'totp'].includes(method)) {
          try { session = await this.request(method, { ...credentials, ...identity }); }
          finally { credentials.password = ''; credentials.code = ''; }
        }
        else {
          const challenge = await this.request('challenge', { ...identity, method });
          if (challenge.tenant !== this.#tenant || challenge.origin !== this.#origin || challenge.account !== identity.account || challenge.chainId !== identity.chainId || challenge.method !== method)
            throw new WalletLoginError('LOGIN_CHALLENGE_BINDING_REFUSED');
          let proof;
          if (method === 'wallet') {
            const encoded = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
            proof = { signature: await provider.request({ method: 'personal_sign', params: [encoded, identity.account] }) };
          } else {
            if (caBridge?.version !== '8415wallet-ca/1' || typeof caBridge.signChallenge !== 'function') throw new WalletLoginError('LOGIN_CA_BRIDGE_REQUIRED');
            // The bridge must display the full challenge, get local user consent,
            // and sign UTF-8 bytes using a non-exportable hardware-held key.
            const signed = await caBridge.signChallenge(Object.freeze({ ...challenge }));
            proof = { signature: signed.signature, certificateChain: signed.certificateChain, algorithm: signed.algorithm };
          }
          session = await this.request('proof', { ...identity, id: challenge.id, ...proof });
        }
        if (session.tenant !== this.#tenant || session.origin !== this.#origin) throw new WalletLoginError('LOGIN_SERVICE_BINDING_REFUSED');
        this.#csrf = session.csrf; this.#session = session; return session;
      },
      check: async () => this.request('session'),
      logout: async () => this.logout(),
    };
  }
  async logout() {
    if (!this.#csrf) return;
    try { await this.request('logout', {}, { keepalive: true }); } finally { this.#csrf = null; this.#session = null; }
  }
  async startEnrollment(existingCode, recovery = false) {
    if (!this.#session) throw new WalletLoginError('LOGIN_REQUIRED');
    return this.request('totp/enroll/start', { existingCode, recovery });
  }
  async confirmEnrollment(code) { const result = await this.request('totp/enroll/confirm', { code }); this.#session = null; return result; }
  async cancelEnrollment() { return this.request('totp/enroll/cancel', {}); }
}
