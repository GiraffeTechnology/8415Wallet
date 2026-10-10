# Combined account-method verification

This candidate replaces the weaker conditional HTTP management mutations while
preserving login, ordinary registration, existing encrypted credentials, and the
original store encryption key. It does not deploy, provision accounts, rotate a
real user's authenticator, or grant signing authority.

## Management entry and factors

The 8415wallet.com management page owns initial authenticator binding, replacement,
and true unbinding. The same flow is required if a native mobile app is added.
The current delivery remains a mobile DApp. An agent may bring the user to this
page; it never receives passwords, seeds, OTPs, recovery codes or change proofs.

Every management operation requires a recent independent server session **and**
fresh verification of an established independent method plus a new email OTP:

- By default, a bound original password and an OTP to the previously verified
  account email (or the existing verified reserved email for a legacy account).
- An explicitly selected registered-wallet signature over this exact change
  can be used by a passwordless account or for lost-password recovery. It still
  requires the same verified-email OTP and all applicable existing factors.
  This is wallet-control verification, not a trusted-device attestation.
- If an authenticator is already bound, its current TOTP or an unused saved
  recovery code is required even if TOTP login is disabled.
- If a reserved security answer already exists, that answer is also required.
  Its verification and the email OTP are part of this same combined flow;
  the user does not obtain a second generic reset proof for the same change.

A login session, email OTP, security answer, generic reset proof, new authenticator,
new device, user-agent string, or IP address alone is insufficient. A TOTP-only or
recovery-code-only login remains ineligible for management. A registered wallet
must already be enabled; the change cannot enable a new authority to attest to
its own prior trust.

Ordinary signup first verifies email ownership and a registration-purpose EOA
signature as before. First authenticator/password setup uses those established
bindings with a new exact-change wallet signature and a new email OTP; it does
not reuse the registration OTP or demand a never-set password/authenticator.
A legacy account lacking any verified email first completes the separately scoped
`email.initial` operation: explicit existing-password or registered-wallet proof,
any existing TOTP/recovery/security-answer factors, and verification of the new
email. The resulting identity does not supply a reusable method-change proof.
A later binding performs its own fresh combined verification.

If the old verified email is unavailable, this implementation cannot replace it
using a new address as self-asserted old identity. Independently verified operator
recovery remains a separately authorized process. No device-trust architecture,
server hardware-CA change verifier, or operator-provisioning bypass is introduced.

## Exact change API

Capabilities advertise `methodManagement: "combined-v1"`. A matching client is
required. Existing mutation URLs return `409 AUTH_CHANGE_FLOW_REQUIRED`; they do
not fall back to the previous single-session/conditional-factor behavior.

1. `POST /auth/account/change/start` prepares one immutable intent, with `action`
   and optional `identityMethod: "password" | "wallet"`. The actions are:
   - `password.initial` / `password.replace`, with `newPassword`;
   - `totp.initial` / `totp.replace` / `totp.unbind`;
   - `methods`, with `enabledMethods`;
   - `recovery.initial` / `recovery.replace`, with `email`, `questionId`, `answer`;
   - `email.initial` / `email.replace`, with `email`.
   It returns the factor requirements, expiry and change ID. A passwordless or
   explicitly selected wallet branch also returns the exact wallet challenge.
   It does not return a pending TOTP seed yet.
2. `POST /auth/account/change/verify` accepts `changeId`, the required
   `originalPassword` or `signature`, and applicable `existingCode`, `recovery`,
   and `existingAnswer`. Only after all independent checks succeed does it send
   a fresh eight-digit OTP to the server-selected address.
3. `POST /auth/account/change/confirm` accepts `changeId` and email `code`.
   It returns an opaque single-use `changeProof`. For TOTP enrollment it returns
   the new seed and local `otpauth` URI solely to the management page. The old
   authenticator remains active. For email replacement, a distinct new-address
   OTP is sent only after the old address and independent identity are verified.
4. `POST /auth/account/change/commit` accepts only the `changeProof` and, where
   required, the new authenticator `code` or `newEmailCode`. The prepared payload
   cannot be replaced at commit. A successful response reports `updated`,
   `loggedOut`, the action, and one-time recovery-code display for TOTP binding.
5. `POST /auth/account/change/cancel` cancels pending work. Optional `changeId` or
   `changeProof` selects the exact pending attempt, so a stale cancellation cannot
   cancel a newer change. A transaction already
   submitted to durable persistence is reported as `confirmationInProgress`;
   closing the page cannot promise rollback or justify replaying an uncertain write.

The server rejects irrelevant/unknown fields, unbound or unavailable methods,
incorrect initial/replacement state, and changes leaving no available independent
password/wallet/CA method enabled. Recovery-profile email must match the verified
registration email. Registered-email replacement verifies both addresses and
atomically moves the directory alias and recovery recipient.

## Binding and commit boundary

Each challenge/proof binds purpose, action, origin, tenant, username, selected
account, chain, session, credential revision, old/new binding identifiers, nonce,
and expiry. Binding identifiers use an ephemeral server-keyed digest; raw password
hashes, recovery-answer hashes and TOTP secrets are not public identifiers.
Password inputs are hashed immediately for the prepared intent. Plaintext inputs
and OTPs are not persisted. New seeds exist only in server/UI private memory
until encrypted activation; no QR service, application log or agent context is
involved.

The original credential binding is revalidated before each stage and inside the
serialized transaction. Old TOTP/recovery-code consumption, exact proof consumption,
new credential state and revision increment occur at that atomic update. Failed
checks and cancellation before transaction entry do not consume old factors or
modify old credentials. Concurrent changes cannot overwrite a newer revision.
A newly verified TOTP counter is consumed on activation; replacement recovery
codes are independently regenerated and displayed once. True unbinding deletes
TOTP and its recovery-code fields while preserving unrelated credentials.

Every committed change revokes all account sessions and pending login-management
proofs. Existing task authorization must revalidate/suspend execution on credential
revision mismatch; it must not silently expand or renew task authority. Unknown or
already-submitted transaction outcomes remain subject to their separate recovery
rules. Credential revisions are not task-policy versions.

## Verification and integration status

The focused synthetic suites exercise combined factors, passwordless/bootstrap
paths, lost-password wallet verification, binding substitutions, replay, expiry,
concurrency, cancellation before/during commit, true unbinding, verified-email
replacement, old-factor preservation, encrypted persistence and private UI cleanup.
The real-browser script `scripts/controls/method-change-ui-smoke.cjs` targets both
V2/V3 at desktop/mobile viewports against the actual local HTTP service. It emits
boolean results only, never OTPs, seeds, passwords or QR screenshots.

The existing login-methods, account-settings, registration, password-settings,
and tenant-password browser journeys retain their cancellation, timeout,
incorrect-factor, replay, late-response, method-policy, routing, locale and privacy
checks. Account mutations now traverse the same combined dialog and HTTP API.
`method-change-test-ui.cjs` is a synthetic browser-test adapter, not a production
proof issuer. OTP budget windows are advanced only through the synthetic service
and page clocks; production rate limits are unchanged.

Reproduce after installing the project's locked dependencies:

```sh
npm run typecheck
npm run wallet:browser:build
node --test --test-timeout=45000 tests/auth-service.test.ts tests/account-login-ui.test.ts tests/auth-registration.test.ts tests/auth-recovery.test.ts tests/auth-password.test.ts tests/auth-method-change.test.ts tests/method-change-ui.test.ts
export WALLET_BROWSER_CHROMIUM="$(command -v google-chrome || command -v chromium)"
node scripts/controls/login-methods-ui-smoke.cjs
node scripts/controls/tenant-password-ui-smoke.cjs
node scripts/controls/method-change-ui-smoke.cjs
```

The first browser command chains the account-settings, registration and password
journeys. The final command belongs beside the first two in the existing
`Account authentication browser journeys` CI step for both supported Node matrix
versions. Do not attach network traces, input dumps, mail payloads, seed/QR or
recovery-code screenshots. Browser execution must occur in a supported environment;
syntax checks and deterministic UI tests do not establish a real-browser pass.

Run the full authentication, Node, typecheck, browser, package, and existing CI
matrix after integrating the task service/UI changes. Focused local results are not a full regression pass,
independent security audit, production deployment, or physical-device acceptance.
