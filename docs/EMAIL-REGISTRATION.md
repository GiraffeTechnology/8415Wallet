# Verified-email ordinary-account registration

The 2026-10-06 owner instruction requires email at wallet registration. This
extends the earlier operator-only binding rule for **ordinary user accounts**.
An unauthenticated visitor can create one ordinary EOA wallet/chain account after
proving both email ownership and wallet control. There is no invitation or
pre-existing login requirement. Operator configuration still owns bootstrap and
privileged bindings; these routes cannot grant administrator/tenant permissions,
CA bindings, spending authority or access to private register records.

Email OTP is **not a login method**. It verifies a registration/migration email
or supplements the separately reserved security-reset factors. Existing password,
authenticator TOTP, registered wallet and configured hardware-CA login remain.
The static wallet display-privacy route and every transaction approval stay
separate from server account registration.

## New ordinary user

1. Obtain the existing cookie-bound `/auth/bootstrap` CSRF token.
2. Send and confirm an eight-digit email code. Email verification does not issue
   a session and cannot authenticate any existing account.
3. Select an EOA and chain in the wallet provider. Sign the server's exact,
   short-lived registration challenge. It binds the configured origin and
   tenant, EOA, chain, unique request, registration purpose, email-identity digest
   and verified-email flow. A login-purpose signature cannot register an account.
4. Optionally choose a 12–1024-byte password (minimum 12 JavaScript characters).
   The server hashes it with the existing randomly salted scrypt-v1 parameters,
   N=32768, r=8, p=3. A successful atomic commit creates a generated account name,
   the ordinary EOA binding and its mandatory verified email, then issues the
   existing `kind: "wallet"` session. The server never receives a private key.

The generated account name remains usable. The verified email is also an alias
for password/TOTP login, still requiring the chosen wallet/chain and valid
password or authenticator/recovery proof. The email itself is not a credential.
Only the established EOA signature verifier is supported on this server route;
server ERC-1271/6492 registration is not claimed.

## Existing accounts and email changes

Old account-name/password, wallet, TOTP/recovery and CA login are not disabled by
migration. Authenticated account state reports whether verified-email migration
is required, allowing the user to reach management without losing access.

Migration requires an independently authenticated wallet/password/CA session
issued within five minutes. If TOTP is enrolled, supply a current TOTP or unused
saved recovery code even when its login method is disabled. If reserved reset
factors exist, first prove the old security answer and old stored-email OTP,
then supply that single-use reset proof. The new address needs its own distinct
registration OTP. No arbitrary recipient is accepted by a reset endpoint.

Confirmation updates email identity and, if present, the recovery profile email
in the same atomic transaction. It preserves the account name, wallet/chain
bindings, password hash, CA fingerprints, authenticator secret, remaining
recovery codes, method choices, unrelated credential data and existing store
key. The submitted existing code is consumed as intended. The credential revision
increments and every account session/pending factor setup is revoked.

Once registered, recovery enrollment must use exactly the authenticated account's
registered email. It cannot independently redirect recovery to another identity.
Changing a registered email uses the same protected registration-email routes;
it requires an existing reserved recovery profile so the old answer/address can
be proved first. If none exists, reserve recovery factors at the current verified
email before changing it. A successful change atomically replaces both email
fields and moves the login alias; the old alias stops resolving.

## API contract

All state changes require exact Host, Origin and tenant, JSON content type and
the appropriate per-browser CSRF token. There is no CORS endpoint. Signup uses
the bootstrap HttpOnly cookie. Migration uses the authenticated HttpOnly session.

`GET /auth/capabilities` adds:

```json
{ "registration": { "available": true, "emailRequired": true } }
```

Availability indicates the configured mail adapter, not a deliverability probe
or whether an email/account exists. No SMTP connection is made by construction.

Signup endpoints, with Unix millisecond expiration times:

- `POST /auth/registration/start` `{ email }` returns
  `{ challengeId, expiresAt, emailMasked, digits: 8 }`.
- `POST /auth/registration/verify` `{ challengeId, code }` returns
  `{ verified: true, registrationId, expiresAt }`.
- `POST /auth/registration/challenge`
  `{ registrationId, account, chainId }` returns
  `{ id, message, origin, tenant, account, chainId, method: "wallet", nonce,
  issuedAt, expiresAt }`.
- `POST /auth/registration/confirm`
  `{ registrationId, id, account, chainId, signature, password? }` returns
  `{ registered: true, session }`, where `session` has the existing account
  session schema and its new session-CSRF token.
- `POST /auth/registration/cancel` `{}` returns
  `{ cancelled, confirmationInProgress }`.

These endpoints reject extra account/privilege selectors. A username is generated
by the service; arbitrary client usernames, roles, tenants and CA fields cannot
be installed. The browser must retain the original preauth CSRF for signup
cancellation until it accepts the final session.

Authenticated migration/change endpoints:

- `POST /auth/registration/email/start`
  `{ email, existingCode?, recovery?, resetProof? }` returns the OTP challenge
  metadata above. `recovery: true` identifies a saved recovery code.
- `POST /auth/registration/email/confirm` `{ challengeId, code }` returns
  `{ registered: true, loggedOut: true }`.
- `POST /auth/registration/email/cancel` `{}` returns the cancellation metadata.

`GET /auth/account` retains `schema: "8415wallet-account/1"` and adds:

```json
{
  "registration": {
    "required": false,
    "complete": true,
    "email": "Synthetic.User@example.invalid",
    "emailMasked": "S***@example.invalid",
    "emailOtpAvailable": true
  }
}
```

The complete email is returned only for the already authenticated, session-bound
account. An incomplete account has `required: true`, `complete: false`, and null
email fields. This authenticated value allows the recovery settings to use the
same identity. No public email/account lookup or email-login endpoint exists.

## Identity, storage and concurrency

Accepted addresses use the SMTP adapter's bounded ASCII address syntax. Domains
are case-folded; delivery/display retains local-part spelling. For tenant-local
uniqueness and login aliases, **the entire address is case-folded**. This is a
conservative anti-duplicate policy: rare RFC mailboxes distinguished solely by
local-part case cannot create separate accounts in one tenant. Dots and `+tags`
are not merged, and no Gmail/provider-specific equivalence is invented.

`@registration:<tenant>` is a version-1 directory record inside the existing
AES-256-GCM encrypted credential file. It stores generated ordinary account
bindings and verified-email ownership. The credential at `<tenant>:<username>`
contains `registration: { version: 1, email, verifiedAt }`. Email and wallet/chain
indexes are derived from the validated directory, never accepted from a client.

`transactionMany` serializes directory and credential updates in one queue entry
and one fsynced atomic file replacement. Email uniqueness, configured/dynamic
wallet+chain uniqueness, account revision and live flow/session checks are
rechecked at transaction entry. Concurrent signup, migration and confirmation
cannot duplicate or overwrite a binding. Startup validates the directory against
operator configuration and all linked registration credentials; malformed,
partial, conflicting or mismatched state fails authentication closed.

An existing encrypted version-1 store is opened without conversion, replacement,
credential deletion or rekeying. The existing independent store key is unchanged.
Pending mail challenges, registration proofs and sessions remain ephemeral and
die on restart. Do not restore an older store snapshot: that could revive consumed
TOTP/recovery codes. The existing separately authorized recovery procedure still
applies to lost factors.

A tenant may create at most 1,000 dynamic ordinary accounts. Total configured plus
dynamic bindings retain the existing account limits. Before any persistence, the
store computes the exact encrypted-envelope byte size and refuses writes beyond
the same 4 MiB accepted on restart. Capacity refusal does not poison the store or
change existing data; actual uncertain storage failures still make it unhealthy.
One writer/process per state file remains mandatory; there is no distributed
registration/rate-limit/replication claim.

## One-use, cancellation and abuse controls

- Eight-digit cryptographically random registration OTPs have a maximum
  five-minute lifetime, capped by bootstrap/session lifetime. Only HMAC-SHA256
  digests using an ephemeral random pepper are kept. Binding includes origin,
  tenant, flow, email, purpose and, for migration, session/account/chain/revision.
  Registration, recovery enrollment and reset OTPs have separate state/purposes.
- Five matching-code attempts per challenge and ten verification attempts per
  flow/15 minutes. A correct code is claimed synchronously before any await;
  replay and concurrent verification are refused.
- Send attempts are limited to five per context and destination/15 minutes and
  one per destination/60 seconds. Destination limits case-fold the entire email.
  Failures count. Signup/migration send IP traffic is capped at 20/15 minutes;
  signup operations at 100/15 minutes (cancellation remains available after the
  budget is exhausted). Maps are bounded to 10,000 entries and
  signup password hashing to two concurrent derivations.
- Existing and unused email addresses follow the same public start/OTP-delivery
  path; no availability lookup is exposed. Conflict is checked at atomic commit
  after proof. Rates are single-process safeguards, not a distributed WAF.
- Wallet challenges last at most two minutes and no later than the verified-email
  flow. Reissuing supersedes the old challenge. Confirmation claims the challenge
  before password hashing/storage. Invalid or rejected confirms require a new
  flow; signatures cannot be replayed across tenants, purposes or browser flows.
- Cancel, logout, bootstrap replacement, session revocation, clock reversal,
  expiration and service restart invalidate their bound pending work. Late mail
  or hashing completion cannot recreate cancelled state. Closing a flow while an
  atomic commit is already persisting returns `cancelled: false` and
  `confirmationInProgress: true`: it cannot roll back the committed account.
  Final session issuance rechecks the live signup after any credential read;
  bootstrap-bound cancellation also revokes a just-issued signup session.
  A dismissed signup will not issue a late session; sign in normally to check
  whether creation completed. The browser must also discard stale responses.

## Mail integration and verification limits

Registration uses the same server-only adapter, fixed `mail.8415wallet.com` host
and `noreply@8415wallet.com` sender, with `purpose: "registration"`, verified
implicit TLS and no plaintext/fallback sender. Missing/failed transport refuses
signup and email migration; existing login remains available. There are no
console OTPs, alternate-recipient reset fallbacks or automatic SMTP retries.
No real account, email, SMTP secret, store key or listener is provisioned by this
source change.

`tests/auth-registration.test.ts` uses synthetic addresses, in-process fake mail,
ephemeral wallets and local temporary stores only. It covers registration and
migration, aliases, privilege rejection, proof binding, OTP/lifetime/replay,
duplicate email/wallet races, revision/cancellation boundaries, coherent email
replacement, encrypted restart, invalid state and size-capacity failures.
`npm run test:auth` includes these tests alongside the existing authentication,
recovery, CA, UI/client, provisioning and local-QR tests. Local passing results do
not establish real-mail deliverability, deployed acceptance, physical hardware-CA
compatibility or independent security review.
