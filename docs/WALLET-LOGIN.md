# Wallet login and asset display

The public V2/V3 entry page stays accessible without login. The asset, balance,
holding, native projection, account, transaction/recovery and history panels are
hidden and inert until a wallet login proof is verified. Merely connecting a
provider or obtaining an address is insufficient. Xiongan remains a V2 tenant
of the general-purpose 8415wallet product.

## Additional account login methods

The local-wallet route described below is preserved. The account service adds
password, RFC 6238 authenticator TOTP (Google Authenticator/FreeOTP), registered
EOA challenge-signature and hardware CA certificate-proof methods. Email OTP
remains excluded from login. The owner separately authorized reserved-email OTP
for security resets and mandatory registration-email ownership on 2026-10-06;
see `AUTH-RECOVERY.md` and `EMAIL-REGISTRATION.md`. These routes use real server verification,
fixed tenant/account/wallet bindings, HttpOnly sessions and live revocation
checks. See [Account authentication](ACCOUNT-AUTHENTICATION.md) for implementation,
enrollment/recovery, operational constraints and the hardware bridge boundary.
No method imports a private key or replaces per-transaction approval.

## Static-DApp trust boundary

This is a local display-privacy gate, not server authorization or blockchain
confidentiality. Public chain records can still be read outside the DApp.
A person controlling the browser, extension, page source or device can inspect
public records and browser storage. No entitled register-record endpoint is introduced. The companion account
authentication service is not an entitlement API. A future private endpoint must independently verify a
server-issued nonce, audience, proof, expiration and entitlement and maintain a
revocable server session. A client boolean, this in-memory session or a hidden
panel must never authorize such an endpoint.

The release profile must load and pass its configured-origin check before login.
The challenge uses the current page origin, including scheme and effective port,
and the actual provider's selected account and chain. It accepts no user-typed
account, origin, chain, claimed authentication flag or imported signature.
Nonlocal insecure HTTP is refused. Serving remains subject to the existing
confirmed-endpoint and SSH port reservation requirements; no deployment is
performed by this change.

## Proof and lifetime

- The login message follows [ERC-4361](https://eips.ethereum.org/EIPS/eip-4361),
  with explicit scheme/authority, checksummed address, URI, version 1, chain ID,
  cryptographically random 256-bit nonce, issued time and expiration.
- The wallet receives only an EIP-191 `personal_sign` request for login. The
  application verifies an EOA proof with the existing lockfile-pinned ethers
  implementation bundled locally. No CDN, new backend or secret is required.
- The challenge is single-use, consumed before asynchronous verification, and
  must complete within two minutes. Rejected or cancelled attempts need a new
  nonce. A nonce collision is refused, never silently reused.
- A verified session lasts at most 15 minutes from issuance, in this tab only.
  It is never loaded from cookies, localStorage, sessionStorage or IndexedDB.
  Reload, page exit/history restoration, explicit logout, expiry, provider
  disconnect, or selected account/chain changes lock the display. Each operation
  and provider request checks expiry and session binding; the timer is only
  prompt UI cleanup. Identity is rechecked rather than inferred from connection.
- A supported contract account must supply a personal-message signature and
  pass [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) on the selected chain.
  Only the exact ABI-encoded magic value is accepted. The proof remains private
  in memory solely for revocation rechecks on every protected operation/request;
  it is discarded on logout. Reverts, missing methods and malformed results fail
  closed. Counterfactual/undeployed contracts and ERC-6492 are not supported.
  Provider-specific smart-account signing still requires genuine-wallet testing.
- Login neither grants transaction authority nor changes the existing custody
  scope. External ETH/ERC-20/ERC-721/ERC-1155 transfers remain EOA-only as before.
  Native ERC-8415, clearing and linked controls retain their existing account
  constraints. Every transaction keeps its separate review and wallet approval.

## Clearing and recovery

Logout removes rendered assets, balances, histories, receive addresses, saved
submission displays and unsigned reviews from the DOM, drops reader/session
references, and aborts the login generation. EIP-1193 has no cancellation method
for a request already delivered to a wallet. Late results are discarded, and
later calls through an old provider wrapper are refused. Logging out cannot
unsend a transaction already approved in the external wallet.

Durable recovery journals are preserved because deleting an unresolved outcome
could permit a duplicate send. Their contents are loaded into the UI only after
fresh login to the same account/chain and explicit panel connection. This is not
encrypted device storage; use a trusted device and browser profile.

Unsigned transaction/consent reviews never survive account changes. One
intentional V3 exception is an already-signed recipient ForwardConsent: its
existing chain/account/terms-bound proof may remain in private memory across an
account switch so the newly logged-in seller can forward it. The original SDK
validation and explicit forward action remain mandatory. It is never a login
credential. Explicit logout, expiry, chain changes, disconnect, page exit and
reload clear it. Rejected new login attempts also clear it.

## Test and manual acceptance

Node tests use ephemeral synthetic signers and real cryptographic verification
for wrong signatures, message fields, replay, nonce collision, pending login
cancellation, expiry, clock reversal, account/chain/origin binding, stale result
rejection, reload denial and ERC-1271 success/refusal/revocation. Browser fixtures
use a publicly documented test key, never a user credential.

CI runs the real page in Chromium at desktop and mobile viewports for both
profiles: the public entry makes zero provider calls, direct hidden-handler
invocation is denied, connection does not authenticate, cancellation and replay
fail closed, storage cannot restore login, logout/account changes/expiry clear
assets, and late ETH/ERC-20 results cannot reappear. Existing transfer,
IndexedDB recovery and native-settlement journeys log in through the same actual
proof-verification code. Mobile emulation is not physical-device acceptance.

Before genuine deployment acceptance, manually test the exact published origin
and tenant with intended EOA and contract-wallet providers, verify the displayed
message's origin/account/chain/expiry, reject once, log in, inspect all enabled
panels, log out, switch account and chain, reload, expire the session, and resume
an existing recovery journal. Never provide seed phrases or private keys to the
DApp. Real signing, chain transactions, deployment and independent security review
remain separate authorized acceptance work.

## Ordinary registration and existing-account email migration

The public registration entry verifies an email first, then requests an explicit
registration-purpose wallet signature before ordinary account creation. An
optional password is hashed server-side. Email OTP is not offered as a login
method. Existing account-name login remains supported; verified email can also
identify the same account for password/TOTP login. Ordinary signup cannot assign
a role, administrator permission, tenant or hardware-CA binding.

Existing accounts without a registered email remain able to authenticate and
complete the required migration in settings. No store key or existing factor is
recreated. Close, account/chain changes, Back, expiry and cancellation invalidate
pending registration work and refuse late automatic login. A durable account
creation already submitted cannot be undone by closing the page; check normal
registered-wallet login before starting again in that case.
