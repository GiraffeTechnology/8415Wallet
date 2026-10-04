/** In-memory proof-of-account login for the static DApp. Not an API access token. */
export class WalletLoginError extends Error {
  constructor(code) { super(code); this.name = 'WalletLoginError'; this.code = code; }
}
const insist = (ok, code) => { if (!ok) throw new WalletLoginError(code); };
const supportedChains = new Set(['1', '8453', '11155111', '84532', '560048', '31337']);
export const LOGIN_LIFETIME_MS = 15 * 60 * 1000;
export const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;
export function loginOrigin(value) {
  const url = new URL(value);
  insist(url.origin === value && !url.username && !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'LOGIN_ORIGIN_REFUSED');
  return url;
}
export function loginMessage({ origin, account, chainId, nonce, issuedAt, expiresAt }) {
  const url = loginOrigin(origin);
  return `${url.origin} wants you to sign in with your Ethereum account:\n${account}\n\nLog in to 8415wallet to view assets and history. This does not authorize a transaction or standing access.\n\nURI: ${origin}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
}
/** EIP-191 EOA recovery or EIP-1271 verification on the selected chain. */
export async function verifyLoginSignature(provider, challenge, signature, crypto) {
  insist(typeof signature === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(signature) && signature.length <= 16386, 'LOGIN_SIGNATURE_REFUSED');
  const code = await provider.request({ method: 'eth_getCode', params: [challenge.account, 'latest'] });
  insist(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(code), 'LOGIN_VERIFICATION_UNAVAILABLE');
  if (code === '0x') {
    let recovered;
    try { recovered = crypto.verifyMessage(challenge.message, signature); } catch { throw new WalletLoginError('LOGIN_SIGNATURE_REFUSED'); }
    insist(recovered.toLowerCase() === challenge.account.toLowerCase(), 'LOGIN_SIGNATURE_REFUSED');
    return 'eoa';
  }
  const abi = new crypto.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
  let answer;
  try { answer = await provider.request({ method: 'eth_call', params: [{ to: challenge.account,
    data: abi.encodeFunctionData('isValidSignature', [crypto.hashMessage(challenge.message), signature]) }, 'latest'] }); }
  catch { throw new WalletLoginError('LOGIN_CONTRACT_SIGNATURE_REFUSED'); }
  insist(typeof answer === 'string' && /^0x1626ba7e0{56}$/i.test(answer), 'LOGIN_CONTRACT_SIGNATURE_REFUSED');
  return 'eip1271';
}
export class WalletLogin {
  #crypto; #origin; #now; #random; #epoch = 0; #session = null; #provider = null;
  #pending = null; #signing = false; #usedNonces = new Set(); #listeners = new Set(); #removeListeners = null; #observerGeneration = 0; #abort = null; #contractProof = null;
  constructor({ crypto, origin, now = Date.now, random = bytes => globalThis.crypto.getRandomValues(bytes) }) {
    this.#crypto = crypto; this.#origin = origin; this.#now = now; this.#random = random;
  }
  subscribe(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #notify(reason) { for (const listener of this.#listeners) listener(this.#session, reason); }
  logout(reason = 'LOGIN_REQUIRED') {
    this.#epoch++; this.#pending = null; this.#session = null; this.#provider = null;
    this.#abort?.abort(); this.#abort = null; this.#contractProof = null;
    // Continue observing chain/disconnect while locked so an account-switch
    // handoff cannot retain a completed consent across an unseen chain change.
    this.#notify(reason);
  }
  assert(binding) {
    const session = this.#session, now = this.#now();
    if (!session) throw new WalletLoginError('LOGIN_REQUIRED');
    if (now < session.issuedAt || now >= session.expiresAt || this.#origin() !== session.origin) {
      this.logout('LOGIN_EXPIRED'); throw new WalletLoginError('LOGIN_EXPIRED');
    }
    insist(!binding || (binding.id === session.id && binding.signal === this.#abort.signal && !binding.signal.aborted), 'LOGIN_SESSION_CHANGED');
    return session;
  }
  capture() { const session = this.assert(); return Object.freeze({ id: session.id, signal: this.#abort.signal }); }
  async #identity(provider) {
    const accounts = await provider.request({ method: 'eth_accounts', params: [] });
    const chain = await provider.request({ method: 'eth_chainId', params: [] });
    insist(Array.isArray(accounts) && typeof accounts[0] === 'string', 'LOGIN_ACCOUNT_REQUIRED');
    let account; try { account = this.#crypto.getAddress(accounts[0]); } catch { throw new WalletLoginError('LOGIN_ACCOUNT_REQUIRED'); }
    insist(!/^0x0+$/i.test(account) && typeof chain === 'string' && /^0x[0-9a-f]+$/i.test(chain), 'LOGIN_CHAIN_REFUSED');
    const chainId = BigInt(chain).toString(); insist(supportedChains.has(chainId), 'LOGIN_CHAIN_REFUSED');
    return { account, chainId };
  }
  async check() {
    const binding = this.capture(), session = this.assert(binding), provider = this.#provider;
    try {
      const current = await this.#identity(provider); this.assert(binding);
      insist(current.account === session.account && current.chainId === session.chainId, 'LOGIN_ACCOUNT_OR_CHAIN_CHANGED');
      if (this.#contractProof) {
        const proof = this.#contractProof;
        insist(await verifyLoginSignature(provider, proof.challenge, proof.signature, this.#crypto) === 'eip1271', 'LOGIN_CONTRACT_SIGNATURE_REFUSED');
        this.assert(binding);
      }
    } catch (error) {
      if (this.#session?.id === binding.id) this.logout('LOGIN_ACCOUNT_OR_CHAIN_CHANGED');
      throw error;
    }
    return session;
  }
  /** Only requests account access and the clearly scoped personal_sign challenge. */
  async signIn(provider) {
    insist(!this.#signing, 'LOGIN_ALREADY_PENDING');
    insist(provider && typeof provider.request === 'function', 'LOGIN_PROVIDER_REQUIRED');
    this.logout('LOGIN_STARTING'); this.#signing = true; const epoch = this.#epoch;
    const current = () => insist(epoch === this.#epoch, 'LOGIN_CANCELLED');
    let watching = false; // The initial account-permission event precedes the challenge.
    this.#removeListeners?.(); const observer = ++this.#observerGeneration;
    const callbacks = ['accountsChanged', 'chainChanged', 'disconnect'].map(event => [event, () => { if (watching && observer === this.#observerGeneration) this.logout(event === 'accountsChanged' ? 'LOGIN_ACCOUNT_CHANGED' : event === 'chainChanged' ? 'LOGIN_CHAIN_CHANGED' : 'LOGIN_DISCONNECTED'); }]);
    for (const [event, callback] of callbacks) provider.on?.(event, callback);
    this.#removeListeners = () => { for (const [event, callback] of callbacks) provider.removeListener?.(event, callback); };
    try {
      await provider.request({ method: 'eth_requestAccounts', params: [] }); current();
      const identity = await this.#identity(provider); current(); watching = true;
      const origin = this.#origin(); loginOrigin(origin);
      const nonce = Array.from(this.#random(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
      insist(/^[0-9a-f]{64}$/.test(nonce) && !this.#usedNonces.has(nonce) && this.#usedNonces.size < 1024, 'LOGIN_NONCE_REFUSED');
      this.#usedNonces.add(nonce);
      const issuedAt = this.#now(), expiresAt = issuedAt + LOGIN_LIFETIME_MS;
      const challenge = Object.freeze({ origin, ...identity, nonce, issuedAt, expiresAt,
        message: loginMessage({ origin, ...identity, nonce, issuedAt, expiresAt }) });
      this.#pending = challenge;
      const encoded = `0x${Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('')}`;
      const signature = await provider.request({ method: 'personal_sign', params: [encoded, challenge.account] }); current();
      insist(this.#pending === challenge, 'LOGIN_NONCE_REFUSED'); this.#pending = null;
      const timely = () => insist(this.#now() >= issuedAt && this.#now() < issuedAt + CHALLENGE_LIFETIME_MS && this.#origin() === origin, 'LOGIN_CHALLENGE_EXPIRED');
      timely();
      const kind = await verifyLoginSignature(provider, challenge, signature, this.#crypto); current(); timely();
      const latest = await this.#identity(provider); current(); timely();
      insist(latest.account === challenge.account && latest.chainId === challenge.chainId, 'LOGIN_ACCOUNT_OR_CHAIN_CHANGED');
      this.#abort = new AbortController(); this.#provider = provider;
      this.#contractProof = kind === 'eip1271' ? { challenge, signature } : null;
      // No proof is persisted or exposed as an API token. Contract proofs stay private
      // in memory solely to recheck revocable EIP-1271 authorization per operation.
      this.#session = Object.freeze({ id: epoch, account: challenge.account, chainId: challenge.chainId, origin, issuedAt, expiresAt, kind });
      this.#notify('LOGIN_VERIFIED'); return this.#session;
    } catch (error) {
      if (epoch === this.#epoch) this.logout('LOGIN_REQUIRED');
      if (error?.code === 4001 || error?.code === '4001') throw new WalletLoginError('LOGIN_REJECTED');
      if (error instanceof WalletLoginError) throw error;
      throw new WalletLoginError('LOGIN_VERIFICATION_UNAVAILABLE');
    } finally { this.#signing = false; }
  }
  /** EIP-1193 cannot cancel a request already handed to a wallet. Discard every late result. */
  provider() {
    const binding = this.capture(), provider = this.#provider;
    return Object.freeze({ request: async args => {
      this.assert(binding); await this.check(); const session = this.assert(binding);
      const result = await provider.request(args);
      this.assert(binding); await this.check(); this.assert(binding);
      if (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') {
        if (!Array.isArray(result) || result[0]?.toLowerCase() !== session.account.toLowerCase()) { this.logout('LOGIN_ACCOUNT_CHANGED'); throw new WalletLoginError('LOGIN_ACCOUNT_CHANGED'); }
      }
      if (args.method === 'eth_chainId' && (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result) || BigInt(result).toString() !== session.chainId)) {
        this.logout('LOGIN_CHAIN_CHANGED'); throw new WalletLoginError('LOGIN_CHAIN_CHANGED');
      }
      return result;
    } });
  }
}
