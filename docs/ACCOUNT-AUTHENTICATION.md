# Password, authenticator and token login

The owner changed the OTP requirement on 2026-10-04: **authenticator-generated
TOTP**, such as Google Authenticator or FreeOTP, replaces email OTP for login.
Email codes are never a login method. The 2026-10-06 management extension adds
reserved, verified email OTP and a reserved security answer exclusively for
security-reset verification. Separate registration-purpose email ownership OTP
is mandatory for ordinary signup and legacy migration. Reset factors do not
replace fresh independent login or the old authenticator/recovery proof. There is no email-code login endpoint.

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
  concurrent operations. Behind the same-origin local proxy the remote-address
  bucket is shared by the tenant, including Unix-socket clients; it is not an
  independently verified per-end-user IP identity. Arbitrary forwarded IP headers
  are not trusted. These are in-process bounds, not a distributed WAF.

## Authenticator enrollment and recovery

The authenticated **Security and login methods** panel reports password,
registered-wallet, hardware CA and authenticator states independently for the
current account. Several methods can be configured concurrently. The public
method selector chooses a login attempt; it does not globally disable the other
methods. Operator/CA bindings remain separately provisioned. Ordinary signup
can establish its wallet and optional password only after email ownership and
wallet-control verification. An existing account can set its first password or
replace its password after fresh independent server authentication and any
already configured recovery checks; there is no public administration endpoint.

`GET /auth/account` requires the current HttpOnly session and its CSRF header,
checks tenant/origin/selected account/chain binding, and returns
`schema: "8415wallet-account/1"`, `tenant`, `origin`, `username`, `account`,
`chainId`, `methods`, `authenticator`, `recovery`, `registration` and `management`. Each of
`methods.password`,
`methods.wallet`, `methods.ca` and `methods.totp` has boolean `enabled` and `bound`
fields, plus `available` for server runtime support. CA `available` reports
verifier availability independently of its account fingerprint binding. `bound`
reports provisioned/enrolled state; `enabled` combines availability, binding and
the account's persisted method selection. Authenticator `enrolled`, `pending`,
`expiresAt` and `replacement` report only this account and this session's pending setup. No
password hash, authenticator secret, certificate fingerprint, recovery code or
session token appears in this response. It accepts no account lookup parameter
and provides no unauthenticated account enumeration.

`management.freshIndependentLogin`, `reauthenticateBy` and
`existingCodeRequired` describe whether a fresh independent login or the existing
authenticator/recovery proof is needed. A TOTP or recovery login can inspect these
states but cannot enroll or replace an authenticator. A local-only wallet display
session does not authorize server account management; use a registered wallet,
password or configured CA login for that account.

Use a password, registered-wallet or CA session issued within five minutes.
Select **Set up authenticator**, add the displayed secret to the app, then
submit a generated code. Until that succeeds, the pending secret is not an
active credential; it expires after five minutes or when the independent-login
freshness deadline arrives, whichever is earlier, can be cancelled, and has at
most five confirmation attempts. Authenticator enrollment seeds and TOTP codes
are never sent by email.

Choose **Replace authenticator** to replace an enrolled app. A replacement also
requires a valid code from the current authenticator or one saved recovery code.
When reserved recovery factors are configured, replacement additionally requires
the reserved security answer and a one-use OTP sent to the previously verified
email. A new email supplied during reset is refused. The old credential remains
active until confirmation.
Confirmation stores the new credential, consumes its initial counter, revokes
all account sessions and displays eight independent 128-bit recovery codes
once. Recovery codes are stored only as salted SHA-256 digests and are each
consumed once. Save them privately before dismissing the output. A recovery or
TOTP login cannot enroll another authenticator without an independent recent
login. There is no unauthenticated reset endpoint. Public ordinary-account registration
is a separate email-plus-wallet-proof flow; it cannot reset an existing account. If every recovery method is
lost, use the operator's separately authorized identity-recovery process;
this change does not invent one or bypass it.

### Initial password setup and replacement

`GET /auth/capabilities` advertises `passwordManagement: true` only for a runtime
implementing this flow. The client must not infer password-management support or
an account's password binding from the generic `methods: ["password", ...]`
capability. An old or absent server requires a reviewed same-origin deployment
update, not an unauthenticated password fallback.

`POST /auth/account/password` accepts only `password`, mandatory
`purpose: "initial" | "replace"`, and optional `existingCode`, `recovery` and
`resetProof`. It accepts no username, email, wallet, role or other identity
selector; the authenticated session determines the account. It requires:

- A password, registered-wallet or configured CA server session issued within
  five minutes. Local-only wallet display login, TOTP/recovery-only login,
  registration email OTP or a security answer alone cannot authorize this route.
- The actual current password state must match `purpose`. An existing
  passwordless account can authenticate with its registered wallet or CA and
  choose `initial`; no old password or never-enrolled authenticator is required.
- If an authenticator is already enrolled, a current TOTP or unused recovery
  code is required even when TOTP login is disabled. If reserved recovery factors
  exist, their current security-answer/email verification must supply the
  existing one-use `resetProof`. This applies to both initial and replacement
  operations, and requires only factors that actually exist.
- A password of at least 12 JavaScript characters and at most 1024 UTF-8 bytes,
  with the same fixed-cost salted scrypt parameters used at signup. The UI
  requires matching confirmation and clears the password fields on dismissal,
  submission, identity change and logout. Passwords must never enter logs,
  browser persistence, URLs or source.

Password management is limited to ten attempts per account/15 minutes and shares
the two-concurrent-derivation bound with password/CA authentication. Hashing occurs
before the serialized credential transaction. Transaction entry rechecks the live
session, freshness, current revision, purpose and required factors. TOTP/recovery
consumption, the new hash and revision increment commit together. A queued request
cannot revive logout or overwrite another credential change. Once an atomic
write has been submitted to durable storage, closing the UI cannot undo it;
sign in again to determine the result of an interrupted response.

Successful writes return `{ updated: true, loggedOut: true }` and revoke every
session and pending setup/reset proof for that account. Initial setup adds the
password method while preserving other selections; replacement preserves the
entire method selection, including a password intentionally left disabled.
All other credential fields, registered email, wallet/chain/CA bindings,
authenticator seed, remaining recovery codes and the independent store key are
preserved. The new hash lives at the account's encrypted `passwordHash` field.
Authentication and account status prefer it to the original operator-configured
or signup-directory hash; a malformed encrypted override fails closed. Password
login also binds the verified hash to its credential revision so an in-flight
old-password attempt cannot issue a session after replacement.

Encrypted envelope/store format 1 is unchanged. These override semantics require
authentication-state generation 3 and its downgrade guard; see
[safe runtime transitions](AUTH-INSTALL.md#authentication-state-semantics-and-safe-code-rollback).
Restart reads the override using the original key. Never restore an older
credential snapshot or run a generation-1/2 runtime against updated state: an old
runtime could ignore the override and revive a superseded configured password.

### Per-account enabled methods

`POST /auth/account/methods` accepts an exact `enabledMethods` array drawn from
`password`, `wallet`, `ca` and `totp`. It requires a fresh independent login,
rejects duplicates, unknown methods, unbound factors and unavailable hardware CA,
and requires at least one available independent password/wallet/CA method to
remain enabled. Multiple methods can remain enabled concurrently. This route
selects existing bindings only; it cannot create passwords, wallet/chain bindings
or CA fingerprints. Use the separate password-management route for an existing
account's password, ordinary signup for a new account, and authorized operator
provisioning for privileged bindings.

Changing an enrolled TOTP method's enabled state also requires its current TOTP
or saved recovery code (`existingCode`, plus `recovery: true` for a recovery code)
in the same credential transaction. Disabling it preserves the enrolled seed;
reenabling it requires the existing proof. Disabled methods cannot issue login
sessions. A disabled TOTP login is refused before consuming its supplied code.
Records created before method selection default to all bound, runtime-available
methods enabled. The encrypted store persists the selection and a new credential
revision. Successful updates revoke all account sessions, pending enrollments
and reset proofs and return `{ updated: true, loggedOut: true }`. No other
account's selection or sessions change.

### Reserved reset verification

Authenticated recovery routes reserve a fixed security question/answer and an
email address. The email must be confirmed by an eight-digit OTP before the
pair becomes active. Answers are normalized and stored as independently salted
scrypt hashes; verified email and question state reside only in the encrypted
credential store. Account status exposes a masked email and question ID, never
the answer hash or complete address. Security answers and email access are
additional reset checks, not sufficient standalone identity proof.

- `POST /auth/recovery/enroll/start` starts reservation with `email`,
  `questionId`, `answer`, and any required existing TOTP/recovery proof.
- `POST /auth/recovery/enroll/confirm` verifies `challengeId` and email `code`,
  persists the verified pair, increments the credential revision and logs out.
- `POST /auth/recovery/reset/start` accepts the reserved `answer` and sends an
  OTP only to the already verified stored recipient.
- `POST /auth/recovery/reset/confirm` verifies `challengeId` and `code`, then
  returns a short-lived, session/account/tenant/origin/chain/revision-bound
  `resetProof`. The proof can authorize one reset start only after the old
  TOTP/recovery code also matches. It cannot log in, change bindings or sign.
- `POST /auth/recovery/cancel` discards the pending challenge and reset proof.

All these flows require the recent independent server session. Changing an
already reserved pair additionally requires its existing reset proof. OTPs,
challenges and reset proofs are short-lived, one-use, bounded for retries and
email sends, and invalidated by logout, reauthentication, account credential
changes and restart. Reserved-factor status is returned under `account.recovery`
with `configured`, `emailMasked`, `questionId`, `emailOtpAvailable` and supported
`questions`. If the mail transport is absent or unavailable, email-dependent
setup/reset fails closed; there is no console-code, alternate-recipient or
email-login fallback.

The existing `POST /auth/totp/enroll/start` endpoint accepts optional
`purpose: "initial" | "replace"`; a mismatch with the actual stored state returns
`AUTH_SETUP_STATE_CHANGED` without converting setup into a reset. Its response
adds `enrollmentId` and `purpose` alongside `secret`, `uri` and `expiresAt`. The
updated client binds confirm/cancel requests to `enrollmentId`; a supplied stale
identifier is refused. Omitted purpose/identifier retain compatibility with
older clients. A newer start supersedes an older pending start for that session.

Enrollment reads and transaction entry recheck live sessions, exact credential
revisions, setup identity and the independent-login deadline. Cancel/logout
invalidate queued starts and confirmations; a late asynchronous completion
cannot recreate a cancelled setup. Only one of concurrent confirmations can
commit, and another session's old pending enrollment cannot overwrite the new
credential. Exhausted confirmation attempts discard the pending secret.
`POST /auth/totp/enroll/cancel` ordinarily returns
`{ cancelled: true, confirmationInProgress: false }`. An atomic confirmation
already submitted to durable storage cannot be unsent; cancellation after that
boundary returns `{ cancelled: false, confirmationInProgress: true }`, and the
confirmation still revokes all account sessions when it completes. The UI must
clear dismissed secret displays and ignore late results; sign in again to check
the account if a submitted confirmation's result was lost. Logout never claims
to roll back an already submitted credential write.

The encrypted credential store uses AES-256-GCM with a separately supplied
32-byte key, random IV and authenticated format version, restrictive file modes,
atomic replace plus fsync, a single-writer lock, and serialized replay/recovery
updates. Keys are not generated or saved by the service. A storage error leaves
the store unhealthy and fails subsequent authentication closed until restart.
Never restore an older credential-store snapshot as a routine rollback: doing
so could revive used TOTP counters/recovery codes. Re-enroll affected accounts
and revoke sessions under the operator's approved recovery process instead.

## Reusable installer and legacy manual deployment

The current reusable DApp kit and tenant-scoped authentication installer are
specified in [AUTH-INSTALL.md](AUTH-INSTALL.md) and [DAPP-INSTALL.md](DAPP-INSTALL.md).
They bundle production dependencies, protect a per-tenant Unix listener from
local port takeover, and reserve real first credential provisioning for the
user's trusted terminal. Neither preparation nor package tests deploy a service.
The following environment-variable setup describes the older manual developer
entry; use the reusable installer for the bounded installation/update workflow.

The template `config/auth.example.json` is deliberately invalid and contains no
secret, port allocation or real account. Before an authorized installation:

- Confirm the exact web origin, tenant, same-origin `/auth/` reverse-proxy route
  and transport. Legacy loopback mode must use a free port outside the host's
  explicit reservedPorts configuration; the reusable installer uses a protected
  local Unix socket with no backend TCP listener. Preserve the original
  Host header. Do not trust or forward client-supplied identity headers.
- Supply an operator-owned account directory containing unique account names,
  salted password hashes as needed, independently verified wallet/chain pairs
  and explicitly authorized certificate fingerprints. No endpoint automatically
  links an arbitrary wallet or trusts a client-supplied authenticated flag.
- Choose a private state path and supply `WALLET_AUTH_STORE_KEY` from the approved
  secret manager, separately from ciphertext and backups. Supply the configuration
  path through `WALLET_AUTH_CONFIG`. Do not put either in `web/`, Git or logs.
  For the separately authorized reset-email sender, approved runtime inputs are
  `WALLET_AUTH_SMTP_PORT`, `WALLET_AUTH_SMTP_USERNAME` and
  `WALLET_AUTH_SMTP_PASSWORD`. All absent leaves reset email unavailable; partial
  configuration is refused. The server uses the fixed `mail.8415wallet.com` host
  and `noreply@8415wallet.com` sender with verified implicit TLS, never plaintext
  or opportunistic fallback. Construction does not connect or send; no SMTP
  credentials, real recipient or port are supplied by this source change.
  `server/crypto.mjs` exports `hashPassword` for an approved provisioning process;
  do not enter a password in command-line arguments or commit a bootstrap secret.
- Install the lockfile's Node runtime dependency using `npm ci --omit=dev` and
  start `npm run wallet:auth:serve`. Building the DApp/source still requires the
  development dependencies and the normal build commands.
- Use one service process per state file. A second writer refuses to start.
  Do not remove a lock until the old process has been confirmed stopped.
  Multiple replicas require a separately designed transactional shared store,
  shared rate limits and revocation, not copying this file between instances.
- Existing accounts should use the authenticated password-management route
  above for initial setup and password replacement. Changing an old configuration
  hash does not supersede a newer encrypted account password. For account
  revocation or wallet/certificate binding changes, use the separately authorized
  operator process and restart the service; restart invalidates all server
  sessions. Protect configuration and encrypted state using the deployment's
  existing access-control process. Do not remove encrypted overrides as a reset.

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

New source preparation: see [Xiongan provisioning and local QR](AUTH-PROVISIONING-PREPARATION.md).
The fixed operator initialization command, duplicate wallet/chain startup gate,
local Canvas renderer and synthetic regression sources are prepared but not
executed or activated. Real bindings and the independent store key still require
approved secure-terminal confirmation. The existing invalid example is not a
production configuration.

- `npm run test:auth`: RFC vectors, password hashing, HTTP session/CSRF/origin/
  tenant boundaries, secret-free authenticated account state, independent
  per-account method selection and revocation, initial/replacement
  setup, delayed start/confirm cancellation, concurrent-session revision guards,
  TOTP enrollment/replay/recovery/concurrency, reserved email/question HTTP
  reset verification with synthetic delivery, encrypted
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

## Required registration email

[Email registration](EMAIL-REGISTRATION.md) specifies ordinary signup and existing
account migration. Email ownership is verified before a new ordinary account is
created, and an EOA proof binds its selected wallet/chain. A user may optionally
set a password in that signup transaction. The account receives no administrative
or transaction authority. Verified email is an identifier for password/TOTP
login; an email code is never a login method.

Existing operator-provisioned accounts keep their current login methods while
settings show the required email migration. Authenticated migration preserves
TOTP counters, recovery factors, method selections and encrypted state. Changing
an established email additionally requires the existing reserved recovery proof;
new email ownership is verified before the identity and recovery recipient change
atomically. Email/wallet uniqueness and ordinary account creation are persisted
in the existing encrypted store, with no key regeneration.
