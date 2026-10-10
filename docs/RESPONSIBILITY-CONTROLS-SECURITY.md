# Product security — agent authority, authentication and responsibility controls

## Scope and evidence status

8415wallet is AI-native: an authorized agent replaces the human operator for
in-scope work, while the human retains authority over task intent and boundaries.
Agent operation must meet the same permission, review and enforcement threshold.
The product remains a general-purpose, multi-asset wallet; native ERC-8415 rules,
standalone and linked operation, V2/V3 profiles and tenant isolation are unchanged.
See [PRD §6](ERC-8415-Wallet-PRD.md#6-security-requirements) for the requirements.

Evidence baseline: main `da7e5478e1de1407e566149813108f8afa4c9342`.
**PLANNED** means required but not a completed product path. **IMPLEMENTED** below
identifies a narrow source capability, not an audit or end-to-end acceptance.
Acceptance must name the exact source, test, environment and observed result.
Prior CI/package success does not accept new authorization requirements.

| Capability | Main-source evidence | Status and boundary |
| --- | --- | --- |
| Standard authenticator login | `server/auth-service.mjs`, `tests/auth-service.test.ts` | IMPLEMENTED for login; no task/transaction proof is issued |
| Credential enrollment/replacement and reserved-factor recovery | `server/auth-service.mjs`, `server/recovery-service.mjs`, `tests/auth-recovery.test.ts`, `tests/auth-password.test.ts` | IMPLEMENTED existing account-management flow; not acceptance of the stronger combined-factor, exact-change and trusted-device lifecycle below |
| Browser agent request review | `src/xiongan/agentRequest.ts`, `tests/xiongan-agent.test.ts` | IMPLEMENTED bounded JSON import for owner review; imported flags/names cannot authorize execution |
| Provider transaction path | `src/adapters/signing/eip1193Signer.ts`, `src/sdk/transactions.ts` | IMPLEMENTED external-provider path still requires separate review/confirmation; `TransactionSigner` is an interface, not a trusted autonomous signing service |
| Hardware CA verification | `server/auth-service.mjs`, `ACCOUNT-AUTHENTICATION.md` | IMPLEMENTED configured login-challenge verification; physical-device acceptance is separate and Ethereum transaction signing is not integrated |
| Budgeted test runner | `scripts/controls/public-testnet.cjs` (`BudgetSigner`) | IMPLEMENTED process-local test budgeting; no production, durable or cross-worker allowance claim |
| Parent-task grants, mobile task TOTP proof, automatic resumption and trusted execution | PRD §6.2–§6.5 | PLANNED; no end-to-end main-source acceptance |
| Combined independent method-change proof, trusted devices and complete bind/unbind/replace lifecycle | PRD §6.4 | PLANNED; existing login/reset tests do not accept this full requirement |

A local proposal schema or pure validation test can support later implementation
but cannot change these statuses without corresponding verifier, durable policy,
signer, DApp and receipt evidence. A recovery `resetProof`, login proof, reference
identifier or caller-supplied `approved=true` is never transaction authorization.

## Agent task and authentication trust boundaries

The human authorizes a parent task with an exact intent and bounded operations,
principal/agent identity, origin/tenant/account/chain, asset and quantity,
recipient/counterparty rules, amount/price/fee limits, expiry and revocation.
Separate one-use authorization from a task allowance; any included multiple steps
remain individually constrained. The execution boundary, not the agent's claim,
verifies the current grant and each child transaction. An agent may complete all
in-scope steps without another manual business action; missing or out-of-scope
authority requires a new human decision. Login is not that decision.

For the illustrative sale of one specified NFT strictly above USD 500, verify a
fresh bound quote and the accepted settlement terms, currency/decimal conversion,
price source and gross/net interpretation. The executed exchange must transfer the
specified NFT and pay the correct recipient under those terms, with bounded fees.
USD 500 exactly, a plain transfer, a mismatched receipt or an agent-declared price
cannot satisfy the sale. Preparation must not silently grant unlimited operator
approval. This is an acceptance example, not authorization for an actual sale.

The mobile DApp's 8415wallet task page displays the task and collects human
confirmation plus the required authenticator code. Standard Google Authenticator
and FreeOTP only supply TOTP codes; the product must not assume transaction display
or push approval in those apps. The server must bind the confirmation to the exact
task digest/version, verified identity, purpose, nonce and expiry. A trusted signer
still signs the checked transaction. The agent then resumes the same authorized
task. No additional native-app scope, per-button manual-operation requirement or
conversion of a TOTP code into a blockchain signature is implied.

Authenticator initial binding, replacement and unbinding belong in the management
pages of 8415wallet.com, or the equivalent management page of a future native mobile
app with the same security controls. Current delivery remains the mobile DApp;
this requirement does not introduce a native-app implementation. Initial enrollment
starts from verified registration identity and fresh independent verification
through already-established methods, such as registered wallet-control proof plus
OTP to the previously verified email. It cannot require the new authenticator,
a never-set password or an unbound device as prior authority. Confirming a new
TOTP code proves readiness to activate that method, not permission to enroll it.

Binding, unbinding, replacing, enabling or disabling an authorization-capable
method, including a password or trusted device, requires combined independent
verification. Valid patterns include the previously verified reserved-email OTP
plus another already-bound trusted device, or original password plus that email
OTP; preserve any additional required existing-factor checks. A session alone,
a single OTP, a device enrolled by the same request, or User-Agent/IP matching
cannot satisfy this requirement. The pending new method is verified separately
before activation. Losing required factors goes through independent recovery.

Method-change proofs bind the exact action and old/new binding identifiers,
origin/tenant/account, credential revision, purpose, nonce and deadline and are
consumed once inside the atomic commit. Replacement invalidates the old method;
unbinding must preserve an eligible independent method. Sessions, pending changes
and proofs affected by the change are invalidated. Credential revisions and task
policy versions are separate; credential changes never widen an agent's grant or
silently reauthorize a task. Revalidate or suspend affected grants explicitly.

The authoritative execution boundary must serialize durable principal/fee budget
reservations and one-use claims across tabs, workers and restarts. Persist intent
before send and retain an uncertain claim until exact canonical transaction and
receipt reconciliation resolves it. Cancellation, expiry, changed terms, revocation
and replay cannot restore authority; late callbacks cannot resurrect cancelled
work. Never retry an unknown transaction or free its budget merely on timeout.
Already-submitted transactions cannot be recalled by cancelling a task.

Audit task/child identifiers, scope digest, credential and policy versions,
authorization decisions, reservation changes and reconciled outcomes without keys,
passwords, TOTP seeds/codes, recovery codes or bearer proofs. Secrets must not be
included in agent prompts, telemetry or public evidence. Keep sensitive account
recovery details outside public product artifacts.

## Product-security acceptance matrix

All rows below are required acceptance for the task-authorized product path and
stronger method-change lifecycle. They are **PLANNED / NOT_ACCEPTED** at the evidence
baseline; existing narrower tests above may be reused only with their stated scope.

| ID | Required positive observation | Required refusal or recovery observation |
| --- | --- | --- |
| PS-01 | Human approves bounded intent; agent completes authorized preparation, execution and receipt check | Missing/changed/out-of-scope intent requests a new decision; no generic login or `approved=true` authority |
| PS-02 | Principal, agent, origin, tenant, account, chain and task version bind every child | Cross-account/tenant/chain/agent replay and stale versions fail before signing |
| PS-03 | One-use tasks and aggregate allowances have distinct counters and limits | Reuse, hidden recurring authority and automatic unlimited operator/delegation approval fail |
| PS-04 | Each child revalidates calldata, asset, quantity, destination, nonce, fees and active conditions | Changed payload/recipient/value/approval/upgrade or unsupported signer cannot execute |
| PS-05 | One specified NFT sells strictly above USD 500 using the agreed gross/net and currency rules | Exactly USD 500, stale/untrusted conversion, wrong token, agent price claim and transfer-only evidence fail |
| PS-06 | Bound settlement evidence proves asset exchange and actual consideration to the approved recipient | Substituted quote, wrong payment, non-atomic exchange or unrelated successful receipt cannot complete sale |
| PS-07 | Mobile 8415wallet page shows exact task/limits; Google Authenticator/FreeOTP code plus human confirmation verifies and agent resumes | App-switch interruption, changed task, cancelled code, expired/reused code and late response fail; no separate manual business operation is needed |
| PS-08 | Purpose-bound task proof is verified independently of the blockchain signer | Login/reset/registration proof cannot become task authority; TOTP and CA login cannot masquerade as Ethereum signatures |
| PS-09 | Management pages provide initial bind/unbind/replace and enable/disable with independent combined factors bound to the exact change; initial enrollment uses verified identity and existing methods | Enrollment cannot depend on its not-yet-bound authenticator, password or device; single session/OTP, agent approval, new-device self-attestation and User-Agent/IP-only trust fail |
| PS-10 | Previously verified email OTP combines with another bound trusted device or original password, retaining required existing factors | A substituted email/device, unrelated old proof or change of action/target after approval fails |
| PS-11 | New method is verified before atomic activation; replaced method and affected sessions/proofs become invalid | Failed confirmation leaves old binding intact; duplicate commit or removing the last eligible method fails |
| PS-12 | Lost-factor recovery independently establishes identity and records its own decision | Lost device/password does not create a direct reset, email-only bypass or agent-granted exception |
| PS-13 | Cancellation, expiry, revocation and material changes prevent subsequent child dispatch | In-flight approval and stale callbacks cannot revive authority; submitted transactions remain reconcilable |
| PS-14 | Concurrent children reserve principal/fees atomically under one durable budget | Racing tabs/workers, restart, duplicate requests and in-flight claims cannot double-spend an allowance |
| PS-15 | Unknown execution retains nonce/claim/budget and reconciles exact canonical receipt, replacement or reorg | Timeout/lost hash cannot trigger blind resend, premature budget release or invented success |
| PS-16 | Credential revision and task policy version evolve independently and invalidate affected work | A factor change cannot expand/reissue a grant or convert one-use authority to a budget |
| PS-17 | Audit links task, approval, child, reservation, signature path and actual outcome with source-bound evidence | Secret-bearing logs/artifacts, fabricated completion and unbound historical results fail acceptance |

Record source/tree/runtime hashes, test names, environment, exact displayed terms,
provider/signer and mobile-device versions, canonical transaction evidence where
applicable, and a result of PASS, FAIL, NOT_RUN or BLOCKED. Use synthetic credentials
for local tests. Physical-device, deployed signer and independent-review results
remain distinct from unit tests and package/CI checks. Preserve W-01–W-24 and the
existing asset/protocol negative cases alongside PS-01–PS-17.

## Responsibility-control implementation evidence

Historical control-module status:
**IMPLEMENTED_LOCAL_TESTS_PASS / NOT_INDEPENDENTLY_AUDITED**. This status does not
apply to the planned task-authority and authentication requirements above.

The recorded integrated Stage 5J batch passed 699 Node / 53 EVM locally; Stage 5I passed
693/53 and the preceding
archive-review repair passed 692/51. An input-owned mapper could bypass strict archive validation; indexed
copying and six adversarial regressions repair review 4106621481. Public archive
objects are not trusted merely because they are arrays. Fresh exact-head review
remains required; this development check is not security approval.

Stage 5J adds a surface that did not exist before and has not been reviewed: a
loopback JSON-RPC endpoint that holds five throwaway test keys so the public
journey runner has accounts to sign with. It is bound to test chain ids, a
1000 wei value ceiling, a bounded read allowlist, and the single ForwardConsent
typed domain, and it never relays `eth_sendRawTransaction` on a caller's
behalf. None of that is an audit. Treat any key it holds as disposable, and do
not point it at an account that holds value.

Local development now includes account/controller/payment contracts
and consent/receipt/view adapters. This changes the review surface, not the
approval status. See [development checkpoint](../CONTROL-DEVELOPMENT-STATUS.md)
for the authority-backed occurrence/return profile, token proxy limitations,
separate funding and remaining release gates. The first unified local campaign
completed after source closure: pre-repair Stage 5F had 651 Node and 49 EVM cases pass. This does not
replace independent review or deployed UI/testnet evidence.
Execution adapters now exist as development source; none is production
approved. Do not interpret a proposal as permission. Earlier escrow audit/tests are not an
audit of these controls. This file is an audit preparation artifact, not approval.

## Assets and attackers

Protect accepted conditions, token custody/transfer authority, control revision,
completed boundaries, evidence occurrence binding and durable execution history.
Adversaries include a malicious seller/buyer/downstream recipient, relayer, stale
or malicious RPC/indexer, replaying client and compromised optional payment
adapter. No private keys or credentials are held by this kernel. Legal identity
and entitlement are outside its claims, even when owner and holder agree.

## Trust boundaries and coverage

| Threat | Local kernel check | Required before release |
| --- | --- | --- |
| Escrow treated as responsibility authority | Unfunded control remains independent; no payment outcome authorizes completion/return | Native-payment fields are signed delivery preconditions only; test both profiles |
| Buyer exits before accepted price is reserved | Exact canonical-adapter reservation consumed atomically with forward | Missing/changed/duplicate reservations refuse; failed transfer rolls all state back |
| Registrar role changes after sequence open | Live protocol authority check within forward | Role drift refuses before token, nonce, revision or payment mutation |
| Cross-chain/token/control replay | Exact domain and revision matching | Domain-separated signatures, expiry/nonce, contract/account identity validation |
| Fabricated consent or authority | Separate exact consent structure and actor/return-role checks | Real signer verification; full payload including inherited scope; no caller-supplied authenticated flags |
| Dropped/replaced upstream terms | Exact ordered active inherited list | Atomic receiver acceptance; alternate transfer/approval/delegation/upgrade bypass matrix |
| Fake holder or repeated address confusion | Occurrence+account checks; both positions required | Authenticated admitted-entry-to-occurrence proof; coherent atomic chain reads; malicious adapter refusal |
| Completion crosses callback / return crosses detached leg | Revision checks, exclusive callback, completed prefix, reverse-hop order | On-chain serialization, reentrancy tests, concurrent transactions and atomic revert |
| Failure reported as successful transfer | Explicit uncommitted proposal; source not mutated | State+token atomic commit, receipt reconciliation, crash/restart and reorg tests |
| Payment failure revives responsibility | No payment outcome used by kernel | Separate settlement-due/refund-due accounting; malicious payment callback tests |
| Unbounded sequence / overflow | Rolling 128-unresolved-leg bound and uint256 revision exhaustion refusal | Enforce the same active-window bound in kernel and executor; detached history does not consume slots; no silent truncation |
| Return followed by new forward loses history | Refuse forward after returned history | Audited new-sequence lifecycle retaining unresolved obligations |

The pure kernel cannot defend against fabricated trusted state/facts or an executor
that persists `next` before a transfer succeeds. The new controller, strict RPC
adapters, consent reviews and receipt-bound recovery now implement those boundaries
with new local regression coverage; earlier kernel tests alone cannot validate them. Review their
actual implementations and trust assumptions, not this preparation table alone.

## Application and deployment additions to review

- Persisted public intent before every provider send; wallet errors/timeouts can
  still be uncertain. Lost-hash reconciliation must match exact transaction and
  event fields, not merely a successful receipt belonging to the same account.
- Browser origin/extension and authenticated provider remain trusted boundaries.
  Strict-durability IndexedDB transactions serialize cooperating tabs and only
  transaction completion releases the send gate. No relaxed/localStorage fallback
  is allowed; legacy localStorage records require explicit reconciliation.
  The Node store fsyncs the parent after rename and lock removal, refusing hosts
  without directory fsync before a sending session can be created. This Windows
  host exercises that negative gate, not positive POSIX power-loss recovery.
  File-store parent ACL and stale-lock recovery are
  operational controls, not protection against an already compromised host.
- Explicit nonce replacement recovery requires a different canonical transaction
  at the exact chain/actor/nonce, sufficient depth and consumed nonce at that
  block. It clears uncertainty, never claims original execution or retries it.
- UTF-8 committed terms and native-payment commitment schemas must display all
  live inherited conditions; single-use review handles cannot be caller-forged.
- Code hashes bind immutable code, not proxy implementation storage. Explicitly
  reject unsupported deployment profiles during independent deployment review.
- Test-only signer policy enforces chain and budgets, not legal entitlement. Test
  proof validators are ephemeral fixtures, never production register authorities.

## Independent audit acceptance

1. Freeze exact source/lock/build/compiler artifacts and intended deployment
   configuration; publish hashes and a requirements-to-test map.
2. Review kernel plus the actual accounts, consent/evidence adapters, atomic
   executor, recovery and optional payments as one execution boundary. Check
   ERC-8415 compatibility without modifying its frozen interfaces.
3. Reproduce positive and adversarial EVM matrices, including ownership/holder
   divergence, repeated occurrences, reorgs, callback/completion races, reentrancy,
   alternate transfer paths, upgrades, malicious recipients and payment failures.
4. Retain findings with severity, reproduction and fix commits. Independent
   retest must close critical/high issues before release; residual findings and
   accepted limitations must be explicit, never silently marked PASS.
5. Run fresh testnet W-01–W-21 and actual standalone/linked desktop/mobile flows.
   Bind results to candidate hashes and deployments. Unit/EVM tests are not a
   substitute for public-chain receipts or UI evidence.

PR #8 review found two P1 defects (post-forward funding and stale authority).
Stage 5E implements repairs; independent retest is still pending. No audit
certificate, production approval, fresh testnet receipt or security guarantee
is asserted.
