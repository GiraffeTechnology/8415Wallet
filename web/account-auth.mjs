/** Same-origin account login client. Passwords/codes are never persisted. */
import { WalletLoginError } from './login-core.mjs';
export class AccountAuthClient {
  #tenant; #fetch; #csrf = null; #session = null; #origin; #registrationEpoch = 0; #capabilities = null;
  constructor({ tenant, origin = globalThis.location.origin, fetcher = globalThis.fetch.bind(globalThis) }) { this.#tenant = tenant; this.#fetch = fetcher; this.#origin = origin; }
  async request(path, body, { keepalive = false } = {}) {
    const response = await this.#fetch(new URL(`/auth/${path}`, this.#origin), { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', keepalive,
      headers: { 'X-Wallet-Tenant': this.#tenant, ...(this.#csrf ? { 'X-Wallet-CSRF': this.#csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); if (text.length > (path.startsWith('tasks/') ? 4194304 : 16384)) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
    let result; try { result = JSON.parse(text); } catch { throw new WalletLoginError('LOGIN_SERVICE_UNAVAILABLE'); }
    if (!response.ok) {
      const error = new WalletLoginError(typeof result.error === 'string' && (path.startsWith('tasks/') ? /^(AUTH|TASK)_[A-Z_]+$/ : /^AUTH_[A-Z_]+$/).test(result.error) ? result.error : 'LOGIN_SERVICE_UNAVAILABLE');
      // Scheduling metadata is never authority. Only the authenticated task-route
      // limiter's explicit 429 response may delay automatic continuation.
      if (path.startsWith('tasks/') && response.status === 429 && error.code === 'AUTH_RATE_LIMITED') {
        const header = response.headers?.get?.('Retry-After');
        const seconds = typeof header === 'string' && /^[1-9][0-9]{0,2}$/.test(header) ? Number(header) : result.retryAfterSeconds;
        if (Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 900) {
          error.status = 429; error.retryAfterMs = seconds * 1000;
        }
      }
      throw error;
    }
    return result;
  }
  async capabilities() {
    const value = await this.request('capabilities');
    if (value.schema !== '8415wallet-auth/1' || value.tenant !== this.#tenant || value.origin !== this.#origin) throw new WalletLoginError('LOGIN_SERVICE_BINDING_REFUSED');
    this.#capabilities = value; return value;
  }
  get supportsMethodManagement() { return this.#capabilities?.methodManagement === "combined-v1"; }
  get supportsPasswordManagement() { return this.#capabilities?.passwordManagement === true; }
  async registrationStart(email) {
    const epoch = ++this.#registrationEpoch;
    const current = () => { if (epoch !== this.#registrationEpoch) throw new WalletLoginError('LOGIN_CANCELLED'); };
    const capabilities = await this.capabilities(); current();
    if (capabilities.registration?.available === false) throw new WalletLoginError('AUTH_EMAIL_UNAVAILABLE');
    const bootstrap = await this.request('bootstrap'); this.#csrf = bootstrap.csrf;
    if (epoch !== this.#registrationEpoch) { await this.cancelRegistration(); throw new WalletLoginError('LOGIN_CANCELLED'); }
    const result = await this.request('registration/start', { email }); current(); return result;
  }
  async registrationVerify(challengeId, code) { return this.request('registration/verify', { challengeId, code }); }
  async cancelRegistration() {
    this.#registrationEpoch++;
    if (this.#csrf) { try { return await this.request('registration/cancel', {}); } catch { return { cancelled: false, unconfirmed: true }; } }
    return { cancelled: true };
  }
  async registrationEmail(action, body = {}) {
    if (!['start', 'confirm', 'cancel'].includes(action)) throw new WalletLoginError('AUTH_ROUTE_REFUSED');
    return this.request(`registration/email/${action}`, body);
  }
  registrationAdapter(registrationId, credentials = {}) {
    return {
      authenticate: async (identity, provider) => {
        const epoch = this.#registrationEpoch;
        const current = () => { if (epoch !== this.#registrationEpoch) throw new WalletLoginError('LOGIN_CANCELLED'); };
        try {
          const challenge = await this.request('registration/challenge', { registrationId, ...identity }); current();
          if (challenge.tenant !== this.#tenant || challenge.origin !== this.#origin || challenge.account !== identity.account ||
            challenge.chainId !== identity.chainId || challenge.method !== 'wallet' || typeof challenge.message !== 'string' ||
            !challenge.message.includes('urn:8415wallet:purpose:registration')) throw new WalletLoginError('LOGIN_CHALLENGE_BINDING_REFUSED');
          const encoded = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
          const signature = await provider.request({ method: 'personal_sign', params: [encoded, identity.account] }); current();
          const result = await this.request('registration/confirm', { registrationId, id: challenge.id, ...identity, signature,
            ...(credentials.password ? { password: credentials.password } : {}) }); current();
          const session = result.session;
          if (result.registered !== true || !session || session.tenant !== this.#tenant || session.origin !== this.#origin ||
            session.account !== identity.account || session.chainId !== identity.chainId || session.kind !== 'wallet') throw new WalletLoginError('LOGIN_SERVICE_BINDING_REFUSED');
          this.#csrf = session.csrf; this.#session = session; return session;
        } finally { credentials.password = ''; }
      },
      check: async () => this.request('session'),
      logout: async () => this.logout(),
    };
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
    this.#registrationEpoch++;
    if (!this.#csrf) return;
    try { await this.request('logout', {}, { keepalive: true }); } finally { this.#csrf = null; this.#session = null; }
  }
  async account() {
    if (!this.#session) throw new WalletLoginError('LOGIN_REQUIRED');
    const value = await this.request('account');
    if (value.schema !== '8415wallet-account/1' || value.tenant !== this.#tenant || value.origin !== this.#origin ||
      value.username !== this.#session.username || value.account !== this.#session.account || value.chainId !== this.#session.chainId ||
      !['password', 'wallet', 'ca', 'totp'].every(method => typeof value.methods?.[method]?.enabled === 'boolean' && typeof value.methods?.[method]?.bound === 'boolean') ||
      typeof value.authenticator?.enrolled !== 'boolean' || typeof value.management?.freshIndependentLogin !== 'boolean' ||
      typeof value.management?.existingCodeRequired !== 'boolean' ||
      !(value.management.reauthenticateBy === null || Number.isSafeInteger(value.management.reauthenticateBy)) ||
      !value.registration || typeof value.registration.required !== 'boolean' || typeof value.registration.complete !== 'boolean' ||
      value.registration.required === value.registration.complete || typeof value.registration.emailOtpAvailable !== 'boolean' ||
      (value.registration.complete && (typeof value.registration.email !== 'string' || typeof value.registration.emailMasked !== 'string')) ||
      (!value.registration.complete && (value.registration.email !== null || value.registration.emailMasked !== null)) ||
      !value.recovery || typeof value.recovery.configured !== 'boolean' || typeof value.recovery.emailOtpAvailable !== 'boolean' ||
      (value.recovery.configured && (typeof value.recovery.emailMasked !== 'string' || !['recovery-phrase', 'first-school', 'childhood-place'].includes(value.recovery.questionId))) ||
      value.authenticator.enrolled !== value.methods.totp.bound || value.management.existingCodeRequired !== value.authenticator.enrolled)
      throw new WalletLoginError('LOGIN_SERVICE_BINDING_REFUSED');
    return value;
  }
  async change(action, body = {}) {
    if (!this.#session) throw new WalletLoginError('LOGIN_REQUIRED');
    if (!['start', 'verify', 'confirm', 'commit', 'cancel'].includes(action)) throw new WalletLoginError('AUTH_ROUTE_REFUSED');
    return this.request(`account/change/${action}`, body);
  }
  async recovery(action, body = {}) {
    if (!['enroll/start', 'enroll/confirm', 'reset/start', 'reset/confirm', 'cancel'].includes(action)) throw new WalletLoginError('AUTH_ROUTE_REFUSED');
    return this.request(`recovery/${action}`, body);
  }
  async setMethods(enabledMethods, existingCode, recovery = false) {
    return this.request('account/methods', { enabledMethods, existingCode, recovery });
  }
  async setPassword(body) {
    if (!this.#session) throw new WalletLoginError('LOGIN_REQUIRED');
    if (!this.supportsPasswordManagement) throw new WalletLoginError('AUTH_PASSWORD_MANAGEMENT_UNAVAILABLE');
    const result = await this.request('account/password', body);
    if (result.updated !== true || result.loggedOut !== true) throw new WalletLoginError('LOGIN_SERVER_RESPONSE_REFUSED');
    this.#session = null; return result;
  }
  async startEnrollment(existingCode, recovery = false, purpose, resetProof) {
    if (!this.#session) throw new WalletLoginError('LOGIN_REQUIRED');
    return this.request('totp/enroll/start', { existingCode, recovery, ...(purpose ? { purpose } : {}), ...(resetProof ? { resetProof } : {}) });
  }
  async confirmEnrollment(code, enrollmentId) { const result = await this.request('totp/enroll/confirm', { code, enrollmentId }); this.#session = null; return result; }
  async cancelEnrollment(enrollmentId) { return this.request('totp/enroll/cancel', enrollmentId ? { enrollmentId } : {}); }
}
