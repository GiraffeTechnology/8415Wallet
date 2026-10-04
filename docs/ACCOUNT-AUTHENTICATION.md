# Password, authenticator and token login

The owner changed the OTP requirement on 2026-10-04: **authenticator-generated
TOTP**, such as Google Authenticator or FreeOTP, replaces email OTP entirely.
There is no email-code endpoint, email transport or resend-email control.

## Implemented boundaries

The public entry remains open. Protected asset/history panels accept one of:

1. **Local wallet / private-key signature.** The existing in-tab ERC-4361 /
   EIP-191 proof and ERC-1271 verification remain available without a server.
   A private key stays inside the user's wallet/provider, never an input field,
   request, log or browser storage. This static route is a display-privacy gate.
2. **Password.** A server verifies an account's password and an independently
   provisioned account-to-wallet/chain binding. Passwords use salted scrypt
   (N=32768, r=8, p=3, 32-byte output; fixed versioned parameters). Password
   provisioning requires 12–1024 characters/bytes as enforced by the hash helper.
3. **Authenticator code.** Server-side RFC 6238 TOTP, SHA-1, six digits,
   30-second period and a ±1-step clock window. Codes are consumed once across
   concurrent requests, sessions and service restarts. The Google Authenticator
   / FreeOTP provisioning format is `otpauth://totp`, with the tenant in issuer
   and label. Manual secret entry and the URI are displayed locally; no remote
   QR service receives a secret. These are alternative login methods; this
   implementation does not claim mandatory two-factor authentication.
4. **Registered wallet token.** A server-issued, two-minute, one-use SIWE
   challenge binds origin, tenant, account, chain, request and login purpose.
   The selected local wallet signs it without exporting its private key. This
   server route verifies EOA recovery. Existing ERC-1271 support remains on the
   local route; server ERC-1271/6492 account enrollment is not claimed.
5. **Hardware CA token.** A configured device bridge signs the exact server
   challenge. The server verifies the signature and a configured X.509 chain,
   clientAuth purpose, validity, CA constraints, cryptographic strength and
   current CRLs for the full chain. Certificate SHA-256 fingerprints map to
   pre-provisioned accounts; a subject name or email is never account authority.

A connected provider is still needed to select the registered wallet account
and chain and to perform chain reads. Password, authenticator and CA login do
not import or create a wallet, grant spending authority, enable automatic
signing, or turn a certificate into an Ethereum key. Every transaction retains
its existing review and explicit wallet confirmation. Existing recovery journals
and raw ERC-8415 temporal-finality semantics remain unchanged.

## Server and sessions

`server/auth-service.mjs` is a small same-origin Node service. A static host alone
cannot verify passwords or authenticator codes. The browser calls `/auth/` only
on its own origin, checks the release tenant and fails closed if the service is
absent or mismatched. No token is stored in localStorage or IndexedDB.

- Fifteen-minute, random, opaque sessions use HttpOnly, SameSite=Strict cookies.
  HTTPS uses a Secure `__Host-` cookie; insecure HTTP is accepted only on loopback
  for synthetic development. Only hashes of cookie tokens are kept in memory.
- Every state-changing request requires an exact configured Origin, Host,
  tenant header, JSON content type and per-browser CSRF token. Bootstrap is
  short-lived and cookie-bound. No cross-origin/CORS access is enabled.
- The browser keeps only current session metadata in memory. Reload does not
  restore it. Provider disconnect/account/chain changes, logout and expiry lock
  the UI. Every protected provider operation checks server session validity.
  Server cancellation also invalidates a login already being verified.
- Explicit logout revokes the server session when its request reaches the
  service. If the network is unavailable, the UI locks immediately, but server
  revocation cannot be confirmed; the server's maximum lifetime still applies.
  Page exit uses a keepalive logout. A request already submitted cannot be unsent.
- Sessions and pending challenges die on restart. Credential changes revoke
  existing account sessions. No session authorizes a private register record
  or new API entitlement; any future private endpoint needs its own checks.
- Password/TOTP failures have the same account-independent public error.
  Password verification performs the same fixed-cost derivation for unknown
  accounts. Account attempts are bounded to 10 per 15 minutes, IP login traffic
  to 100, bootstrap requests to 60, and expensive password/CA work to two
  concurrent operations. These are in-process bounds, not a distributed WAF.

## Authenticator enrollment and recovery

Use a password, registered-wallet or CA session issued within five minutes.
Select **Start authenticator setup**, add the displayed secret to the app, then
submit a generated code. Until that succeeds, the pending secret is not an
active credential; it expires after five minutes, can be cancelled, and has
at most five confirmation attempts. No enrollment or code is sent by email.

A replacement also requires a valid code from the current authenticator or
one saved recovery code. The old credential remains active until confirmation.
Confirmation stores the new credential, consumes its initial counter, revokes
all account sessions and displays eight independent 128-bit recovery codes
once. Recovery codes are stored only as salted SHA-256 digests and are each
consumed once. Save them privately before dismissing the output. A recovery or
TOTP login cannot enroll another authenticator without an independent recent
login. There is no unauthenticated reset endpoint. If every recovery method is
lost, use the operator's separately authorized identity-recovery process;
this change does not invent one or bypass it.

The encrypted credential store uses AES-256-GCM with a separately supplied
32-byte key, random IV and authenticated format version, restrictive file modes,
atomic replace plus fsync, a single-writer lock, and serialized replay/recovery
updates. Keys are not generated or saved by the service. A storage error leaves
the store unhealthy and fails subsequent authentication closed until restart.
Never restore an older credential-store snapshot as a routine rollback: doing
so could revive used TOTP counters/recovery codes. Re-enroll affected accounts
and revoke sessions under the operator's approved recovery process instead.

## Explicit deployment inputs, no deployment performed

The template `config/auth.example.json` is deliberately invalid and contains no
secret, port allocation or real account. Before an authorized installation:

- Confirm the exact web origin, tenant, same-origin `/auth/` reverse-proxy route
  and a free, approved loopback service port. **TCP 443 remains reserved for SSH.**
  The service listens on 127.0.0.1 only and refuses port 443. Preserve the original
  Host header. Do not trust or forward client-supplied identity headers.
- Supply an operator-owned account directory containing unique account names,
  salted password hashes as needed, independently verified wallet/chain pairs
  and explicitly authorized certificate fingerprints. No endpoint automatically
  links an arbitrary wallet or trusts a client-supplied authenticated flag.
- Choose a private state path and supply `WALLET_AUTH_STORE_KEY` from the approved
  secret manager, separately from ciphertext and backups. Supply the configuration
  path through `WALLET_AUTH_CONFIG`. Do not put either in `web/`, Git or logs.
  `server/crypto.mjs` exports `hashPassword` for an approved provisioning process;
  do not enter a password in command-line arguments or commit a bootstrap secret.
- Install the lockfile's Node runtime dependency using `npm ci --omit=dev` and
  start `npm run wallet:auth:serve`. Building the DApp/source still requires the
  development dependencies and the normal build commands.
- Use one service process per state file. A second writer refuses to start.
  Do not remove a lock until the old process has been confirmed stopped.
  Multiple replicas require a separately designed transactional shared store,
  shared rate limits and revocation, not copying this file between instances.
- To revoke an account or change its password/wallet/certificate bindings,
  update the authorized account configuration and restart the service. Restart
  invalidates all server sessions. Protect configuration and encrypted state
  using the deployment's existing access-control process.

No production key, account, OTP seed, trust grant, listener, TLS/DNS/firewall
setting, real email or transaction is created by this source change. Static
DApp artifacts include the UI; the companion server ships in the source archive,
not the public static web directory. An old immutable Beta ZIP is unchanged.

## Hardware CA bridge contract

The application expects an installed, origin-restricted middleware adapter:

```js
window.walletCaBridge = {
  version: '8415wallet-ca/1',
  async signChallenge(challenge) {
    // Show challenge.message and require user presence / PIN on the device.
    // Sign its exact UTF-8 bytes through the device's own middleware.
    return {
      algorithm: 'ECDSA-SHA256', // or 'RSA-PSS-SHA256' with 32-byte PSS salt
      signature: 'canonical base64 signature',
      certificateChain: 'PEM leaf followed by any intermediate certificates'
    };
  }
};
```

This is an integration boundary, not a universal hardware driver. No DApp code
may export/import a hardware private key. The adapter must obtain signatures
through its actual vendor/PKCS#11/CSP bridge, restrict callers to the approved
origin, and never expose PINs to the page. ECDSA uses DER signatures on P-256,
P-384 or P-521. RSA/PSS requires at least 2048 bits. Configure `ca.trustRootsPath`
and `ca.crlPath` to operator-approved local PEM files; optional `ca.opensslPath`
selects the installed OpenSSL 3 executable. Missing/expired/revoked/untrusted
chains or unavailable revocation evidence refuse login. System trust and network
AIA/OCSP fetching are deliberately not implicit fallback paths.

An X.509 signature proves possession of the certified key, not that every device
protects keys identically. Acceptance needs the exact CA vendor, device model,
middleware/version, trust/CRL distribution and physical-device tests. No device
has been claimed tested merely because a synthetic certificate verified. The
service checks revocation at login; sessions have a maximum 15-minute lifetime.
An urgent certificate revocation also requires terminating existing sessions
(e.g. authorized service restart), not only replacing the CRL file.

## Verification

- `npm run test:auth`: RFC vectors, password hashing, HTTP session/CSRF/origin/
  tenant boundaries, TOTP enrollment/replay/recovery/concurrency, encrypted
  persistence, server-backed display sessions, real synthetic CA signatures,
  expiry, EKU and CRL refusal.
- `node scripts/controls/login-methods-ui-smoke.cjs`: real page plus HTTP service
  for both profiles at desktop/mobile viewports, using only synthetic accounts.
  This is included in the existing Node 22/24 CI matrix. Viewport emulation is
  not physical-device acceptance.
- Existing static-login, asset transfer/recovery, local EVM and package tests
  remain required. Never replace them with only the focused auth suite.

References: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238),
[ERC-4361](https://eips.ethereum.org/EIPS/eip-4361), and
[OpenSSL verification options](https://docs.openssl.org/3.0/man1/openssl-verification-options/).
