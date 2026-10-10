# Bounded task authorization service

The same-origin `/auth/tasks/` service authorizes an exact bounded parent task
with an enrolled authenticator TOTP. Account login and task authorization remain
separate. Human-facing HTTP routes require a current owner-bound session. After
approval, a service-owned background runner can continue the bounded grant
without a browser, a cookie, session renewal or another human TOTP. It cannot
create, approve, enlarge or renew a task.

## Trust and persistence

`server/task-authorization.mjs` imports the canonical task contract from
`src/agent/taskContract.ts`. It does not maintain a second policy parser. The
runtime uses the existing Node >=22.18.0 native TypeScript support and includes
the precise 12-source-file contract/receipt closure enumerated by
`TASK_RUNTIME_SOURCE_PATHS` in the package verifier, plus the server receipt
adapter. These explicit paths have source-object and file-hash verification;
unlisted `src/` paths are refused. There is no runtime compiler or download.

Preparation stores an owner-bound pending proposal. The task ID cannot later
name a different digest. A two-minute challenge binds the session, principal,
origin, tenant, account, chain, immutable task digest, fixed executor identity digest, explicit observation policy and verifier identity, and expiry. Authorizing
consumes the existing TOTP counter and writes the grant in one `transactionMany`.
A caller-provided status, approval flag, quote or authorization reference is not
authority. Recovery codes are not accepted as task approval. OTP failures are
bounded by the existing per-account HTTP rate limiter and challenge attempts.

Grants, budgets and the append-only approved-task queue survive restart. Queue
registration shares the same atomic transaction as OTP consumption and grant
creation. Logout invalidates the HTTP session and its
approval challenges; it does not revoke an approved task. The prepared and displayed executor includes a fixed agent ID/version, adapter
ID/version and implementation digest. Its canonical SHA-256 digest is approved
together with the task digest by the same TOTP. Server configuration supplies
this identity; HTTP requests cannot invent it. Changing the executor binding
suspends old grants instead of transferring authority to another implementation.
An unknown attempt can only be recovered by its recorded executor identity.
The stored approval
credential revision is audit evidence, separate from the grant policy version.
A changed credential revision suspends new reservations and sends for that
principal without enlarging, renewing or silently reapproving its old grants.
Revalidation of a suspended grant is not implemented. Explicit revoke and recovery
of an already attempted operation remain available after fresh login.

The store is the existing encrypted, atomic-replace, single-writer store. Its
4 MiB encrypted-envelope limit remains explicit: HTTP `507 TASK_STORE_CAPACITY`
rejects the entire update without consuming a TOTP, discarding a reservation or
evicting a tombstone. A failed or uncertain durable write poisons the store until
recovery/restart. `readMany` returns one queued snapshot without rewriting it.
Independent replicas and separate per-tenant stores cannot coordinate execution.
All tenants sharing a signing account must use the same atomic nonce ledger;
this candidate proves that rule only for one shared store and writer.

Operation IDs are durable tombstones at account + chain scope. Nonces are also
claimed at account + chain scope, across tasks and tenants using that store.
Cancelling a definitely unattempted reservation releases its nonce claim, keeps
its operation ID and releases its proposed quota. Before the sole signer call,
an atomic update rechecks the live grant, credential revision, expiry, child
scope, budget CAS revision and nonce ownership, then persists `outcome-unknown`
and a permanent nonce claim. Unknown/submitted quota is never released by a
client claim, timeout, logout, revocation, restart or a reverted receipt.

The current parent scope authorizes one complete non-cancelled operation:
`exact-operation` reserves one unit; an NFT sale reserves its full declared
quantity. Multiple operation IDs in its history represent cancelled, definitely
unattempted proposals, not permission for multiple successful steps. A terminal
resume does not call the planner or poll receipts. Explicit `observe` can refresh
canonical/reorg evidence without changing spent quota. Multi-step parent policies
and general market workflows need a separately versioned scope contract.

## Background continuation

`server/task-background-runner.mjs` uses a process-internal continuation port.
Its entries come only from the durable approved queue, never browser JSON. The
service reads each grant's original principal and creates a closure-only internal
context; it does not manufacture an HTTP session or accept an API key. Every
resume checks current principal/account binding, grant policy, factor revision,
expiry and the same execution/receipt identities. Atomic budget and nonce gates
remain the sole send boundary. Logout cancels interactive sessions/challenges
without revoking the approved task; revocation or factor changes stop new sends.
Read-only recovery for an already attempted operation remains available.

The runner uses a bounded, fair append-only cursor, a per-store process mutex,
waiting/error backoff and no automatic retry of a send. Start follows successful
listener startup; shutdown waits for its in-flight work before closing the store.
Terminal results are parked; an explicit owner observation may recheck reorgs.
Separate processes/stores still require a reviewed distributed coordinator.
Default runtime configuration has no genuine execution adapter and reports a
blocker without signing or inventing progress. Real signer/custody and supported
market integrations remain deployment prerequisites.

## HTTP contract

Every route is a POST and retains the existing same-origin Host/Origin,
`X-Wallet-Tenant`, `X-Wallet-CSRF` and HttpOnly session checks. Unknown request
fields are refused. No route accepts a provider object or execution configuration.

- `tasks/prepare { policy }`: persists a pending proposal and returns the exact
  `{ task: { policy, digest }, executor, observationPolicy, receiptVerifier, challengeId, expiresAt, purpose }`. `expiresAt`
  here is milliseconds; policy/child expiry remains integer seconds.
- `tasks/authorize { challengeId, taskDigest, executorDigest, observationPolicyDigest, code }`: confirms that prepared
  parent using one TOTP and returns its canonical view with the original persisted executor identity.
- `tasks/list {}`: up to 50 owner-bound task views, `revision` and `nextCursor`.
  Further `{ cursor, revision }` pages fail if the list revision changed.
- `tasks/status { taskDigest }`: exact owner-bound task view, including full
  logical budget, effective status and missing execution capabilities.
- `tasks/revoke { taskDigest, expectedGrantPolicyVersion }`: revokes future work
  without pretending to undo an already attempted transaction.
- `tasks/reserve { taskDigest, child, expectedBudgetRevision }`: atomic declared
  scope/quota/nonce reservation. This is not proof of encoding or market facts.
- `tasks/cancel-reservation`, `tasks/execute`, `tasks/recover`, `tasks/observe` take
  `{ taskDigest, operationId, childDigest, expectedBudgetRevision }`.
- `tasks/resume { taskDigest }`: at most one continuation step. An unknown
  operation is recovered first; a reserved child may execute; otherwise an
  optional trusted planner proposes one next child. All paths use the same
  canonical validation, durable CAS and one-send boundary. A submitted hash
  is observed through the bound receipt verifier on a later call. No polling
  loop or timer is installed by the route.
- `tasks/observe-replacement` takes the same operation binding plus
  `replacementHash`, an untrusted locator independently verified against the
  original actor, nonce, chain and canonical replacement receipt. A verified
  locator is saved for read-only rechecks after a disappearance or reorg.

Pending task views have `authorization: null` and `budget: null`. Effective
states are `pending`, `authorized`, `suspended`, `revoked` and `expired`. Exposed
references/status are display data only. `capabilities.executable` remains false
in a view; `adapterConfigured` reports configuration only, not verified support
for a particular child, market or price. Actual operation verification is a
separate boundary. Absence of a signer returns
`TASK_EXECUTION_ADAPTER_NOT_CONNECTED`; absence of receipt verification returns
`TASK_RECEIPT_VERIFIER_NOT_CONNECTED`. No successful send is fabricated.

## Server-controlled execution adapter

`createAuthService({ taskExecution, taskExecutorIdentity, taskObservationPolicy, taskReceipt })` can receive a
server-owned adapter and its reviewed identity. Configured adapters require
explicit identity metadata; the no-signer default identifies only the local task
service and cannot silently become a configured signing adapter. Identity fields
are canonicalized in order: `schema`, `agentId`, `agentVersion`, `adapterId`,
`adapterVersion`, `implementationDigest`. The digest is `0x` plus SHA-256 over
UTF-8 JSON with that key order. The schema is `8415-task-executor/1`. The
implementation digest is reviewed server-supplied provenance, not a claim that
a client reference or status attests to third-party code. Methods are captured
at service creation; mutating the original configuration object cannot swap the
verifier/signer beneath an existing grant. The
installed `server/main.mjs` does not configure one. Runtime deployment, custody,
key storage and a genuine user-controlled signer remain separate integrations.
No new credential, account, long-lived key or authority is created by wiring this
interface. Authentication-method setup/replacement is a separate service unit.

The adapter implements `verify`, `send`, `recover`, and optionally `plan`:

- `plan({ task, budget, executor, grantPolicyVersion })` returns one child proposal or null.
  It is called once per resume, never for unknown/submitted work. A new proposal
  still passes canonical scope, budget CAS and nonce exclusion.
- `verify({ task, child, executor, grantPolicyVersion })` independently reconstructs the
  complete wire transaction, validates the live chain/account/nonce and, for a
  sale, trusted price evidence and atomic NFT-for-consideration settlement. A
  quote supplied in the child is only a claim. Required current signing and
  external-state checks must also be enforced at the actual signer boundary.
- `send` receives the same immutable task/child/version after durable unknown
  state, and may return a transaction hash only for that exact transaction.
- `recover` receives the immutable task/child and recorded attempt policy version.
  It must independently observe the same chain, actor, nonce and transaction,
  rather than trusting a caller's receipt or hash. It returns submission evidence
  only. Settlement/finality and budget release are not inferred.

The three verification/result methods return exact `taskDigest`, `childDigest`,
`chainId`, `actor`, `nonce`, `executorDigest`, and `grantPolicyVersion` bindings. Submission also
returns `transactionHash`; recovery requires `state: 'submitted'`. Mismatched
results fail closed. The service never replaces a verified child with a later
planner payload. Any uncertain send result stays recoverable with the full quota
and nonce claim retained. No actual signer, encoding verifier, market-price
verifier or atomic-sale adapter is included. Before planning or sending new work,
a bound receipt verifier must also be configured, and its captured
`assessChild({ task, child, executor, observationPolicy })` must establish the
exact child, executor, policy and verifier tuple before execution verification or
the durable send boundary. Its absence or unsupported child is an explicit
blocker. The current capability is `exact-operation-observable`; configured
object presence does not establish support for an NFT sale. This check does not introduce another human approval per child.

## Read-only outcome observations

`taskObservationPolicy` is explicitly supplied as `{ minimumConfirmations }`
with canonical decimal depth 1–1024. There is no default depth. Its canonical
Keccak JSON digest is displayed and bound to the same task/executor TOTP approval.
When execution is absent the policy is null. Changing policy or verifier identity
suspends future work under the old grant; an attempt retains its original policy,
executor identity, verifier identity and grant policy version.

The separately configured `taskReceipt` implements the read-only adapter in
`server/task-receipt-adapter.mjs`. It reuses canonical receipt, event and nonce
replacement checks. Requests cannot supply providers, verification flags or
observations. Receipt outputs are strictly normalized and bound again by the
service. Atomic market sale verification remains explicitly unsupported.

Views expose full `observations`, an independent `observationRevision` and
`completion`. Each observation entry contains `{ operationId, observation,
available }`; null or unavailable evidence cannot establish completion. A failed
refresh marks earlier evidence as historical before reporting an error. Snapshot
reads set `completion.fresh: false`; only successful current observation returns
fresh evidence. Completion at the approved observation depth is distinguished
from protocol or economic finality, both of which remain `not-evaluated`.
Successful, reverted, superseded and reorged observations never release spent
quota or permanent nonce/operation tombstones. The budget remains the complete
spending journal; read-only outcome data uses its own CAS revision.

A submitted original hash permits explicit replacement observation. If a send
lost its original hash and a different-intent transaction replaced its nonce,
this version cannot safely express that replacement proof. It stays
`outcome-unknown` with full quota/nonce occupancy. Neither a missing receipt nor
an unverified hash permits retry or refund. Recovery first needs trusted matching
original-intent submission evidence; a broader replacement schema is a future
versioned integration, not completed functionality.

## Evidence limits

Tests use synthetic factors, test-only in-process adapters, isolated encrypted
files and loopback HTTP. They establish service behavior, not real-wallet,
physical-authenticator, deployed-chain or independent-security acceptance.
Actual minimum Node 22.18.0 and Node 24 package import/start checks are required
for the integrated release. No existing user's authenticator bindings are read,
replaced or reinitialized by these tests.

Task HTTP rate-limit responses expose only `Retry-After` and matching integer
`retryAfterSeconds` (1–900), computed from the current window. These values allow
client scheduling, not authority or success inference. Approval is never replayed
on a rate limit; background continuation does not consume the interactive HTTP
request budget.
