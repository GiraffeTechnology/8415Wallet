# Agent task data contract (review candidate)

Base: `da7e5478e1de1407e566149813108f8afa4c9342`.

This module restores the task-level division between an agent operator and a
human authorizer. It is an additive, pure data/proposal module, not a connected
authorization service or executable wallet workflow. Existing source, public
exports, journals, browser behavior and artifacts are unchanged.

## Shared contract

- `freezeTaskPolicy` / `parseTaskPolicy` normalize a parent task and return a
  deeply frozen policy plus its Keccak-256 UTF-8 JSON digest. Canonical key order
  is produced by the normalizer, not caller insertion order. Integer quantities
  are canonical decimal strings. ERC-55 input validation precedes lowercasing.
- A parent is either an exact existing operation, or a bounded NFT sale policy.
  A sale states NFT identity, sell direction, quantity, USD minor-unit floor,
  strict/inclusive comparison, gross/net basis, allowed market-adapter identities,
  expiry and native-chain fee limits. These fields have no implicit defaults.
- `freezeChildOperation` / `parseChildOperation` bind an operation ID to the parent
  digest, an existing operation, nonce, expiry, unsigned wire-field hashes, fees
  and optional market evidence references. A new nonce or in-scope quote changes
  the child digest, not the parent authorization. Child validity remains bounded
  by the existing 900-second request window and the parent's expiry.
- The nine operation kinds are the existing four external-asset transfers and
  five agent control operations. External assets retain Ethereum/Base and their
  selected testnets; control operations retain Sepolia/Hoodi. There is no approval,
  operator delegation, arbitrary calldata or new marketplace transaction kind.
- `assessChildScope` checks declared bounds. Its only positive outcome is
  `requires-trusted-verification`, with `executable: false`. Market references,
  claimed prices and a plain NFT transfer do not prove an executed sale. A real
  configured market adapter must verify price denomination/conversion and the
  settlement's enforceable NFT/consideration effects. This module supplies no
  exchange, quote service or price authority. It must not reinterpret a market
  fulfillment call as an ordinary NFT transfer. Its current child set therefore
  does not yet encode a marketplace settlement transaction.
- Native transfers require the Keccak-256 hash of empty calldata bytes, the exact
  recipient and value. Token transfers target the token; create/complete/return
  target the controller; deposit targets the token. Standalone withdrawal targets
  a dynamically resolved controlled account and requires independent registration,
  owner/controller and runtime binding. Every operation still needs the existing
  adapter to reconstruct and compare the complete encoded call before signing.
- `normalizeAuthorizationReference` reads an untrusted status/reference only.
  `credentialRevisionAtApproval` records the factor version used, while
  `grantPolicyVersion` governs authorization lifecycle; these are not synonyms.
  Neither an `authorized` string nor a reference constitutes a verified grant.
- `executionAvailability` always reports the missing authorization, encoding and
  user-controlled-signing capabilities. Sale tasks also require trusted price and
  atomic-settlement verification. No booleans can switch these capabilities on.

## Budget and uncertainty contract

`emptyTaskBudget`, `reserveTaskBudget`, `markTaskSendAttempt`,
`noteTaskSubmission` and `cancelUnattemptedReservation` return immutable proposals.
They do not write a store or authorize an action. The task budget binds the
parent digest, revision, operation IDs, maximum native-chain fee reservations and
asset quantity reservations. Cancelled pre-send proposals retain an ID tombstone.
An exact-operation task reserves one execution; an ERC-1155 sale currently binds
the entire stated quantity, rather than inventing proportional split-sale pricing.

There is no 128-attempt or lifetime history limit. `normalizeTaskBudget` represents
the complete logical snapshot. `PagedTaskBudgetJournal` supports fixed-revision
reads and a durable operation-ID index covering archived and cancelled entries.
`normalizeTaskBudgetPage` / `parseTaskBudgetPage` enforce **transport** limits of
128 entries and 32 KiB per page; the store may emit smaller pages. These are parser
resource limits, unrelated to the ERC-8415 unresolved window. `assembleTaskBudgetPages`
rejects truncated cursor chains, mixed revisions and duplicate IDs. The service
must read all pages, or apply equivalent indexed transactional checks, before any
reservation. Archiving must never erase the anti-replay tombstone or hide occupied
fees/units. A browser-supplied snapshot or page chain is not authoritative storage.

`TaskBudgetJournal.compareAndSwap` is a persistence interface, not an implementation.
The authorization service must atomically validate the parent grant, enforce its
policy and reserve budget using durable state. The executor must durably record
`outcome-unknown` **before** calling the signer. A returned hash is only `submitted`.
Unknown/submitted reservations cannot be cancelled, reused or released by this
module. `reconcileTaskBudget` refuses until a trusted receipt verifier is integrated;
claimed cancellation, elapsed time and a hash never release funds. Final budget
settlement and the wider user/asset/period allowance policy remain separate work.

The browser journal and server store are separate commit boundaries. A crash
between them must retain conservative uncertainty, never authorize another send.
The existing exact-transaction, event and canonical-chain receipt verifiers are
the intended basis for the next integration, not caller-supplied success flags.

## Next implementation units and invariants

1. The core component owns this module and the shared fixture. The authorization
   service and mobile UI consume the same versioned data contract; schema changes
   require corresponding fixture and consumer compatibility checks.
2. Auth extends the existing same-origin service and `transactionMany`: TOTP
   consumption, task approval and budget reservation commit durably. Factor
   lifecycle changes require independent combined step-up verification, bound to
   that specific change and consumed once. A new device cannot attest its own
   trust; a session, single OTP, User-Agent or IP address is insufficient. Existing
   recovery methods remain independent of transaction authority. Credential changes
   must not silently enlarge, renew or erase historical task grants. A changed
   credential revision suspends that principal's unexecuted grants pending
   revalidation; grant policy version remains a separate lifecycle control.
3. Mobile UI keeps the request in the original task. Google Authenticator/FreeOTP
   provide standard TOTP codes; transaction details and confirmation remain on the
   wallet's authorization page. Do not assume custom transaction push approval.
   Bind/replace/unbind workflows reuse the existing enrollment/recovery services;
   newly verified state replaces old state atomically. No native app is introduced.

Missing real signing capability must remain an explicit integration gap. Reuse
the existing `TransactionSigner` and EIP-1193 adapter boundaries after confirming
the user's existing signing facility. No custodial service or long-lived key is
selected or created here. A synthetic provider cannot establish genuine signing,
market settlement, physical-device acceptance, deployment or production readiness.

## Review evidence

The bounded test file is `tests/agent-task-contract.test.ts`. Cross-runtime test
vectors are in `tests/fixtures/agent-task-contract-v1.json`; they contain synthetic
public data only. The fixture fixes canonical parent/child digests for both task
types. Run the focused test and TypeScript checks on any subsequent contract change.

## Consumer integration boundary

The stable client/server surface is `TaskPolicy`/`FrozenTask`,
`ChildOperation`/`FrozenChild`, `AuthorizationReference`, `TaskBudget`/`Reservation`
and the optional fixed-revision `TaskBudgetPage` transport. Use the normalizers,
parsers and shared vectors rather than duplicating canonicalization. The only
transitive modules are `xiongan/address.ts` and `codec/keccak.ts`; a narrow TypeScript
build can emit these three files for a packaged server runtime. No Node-only
dependency, signer, RPC provider or runtime credential is imported.

The service binds an authenticated principal and same-origin/tenant context to
the frozen parent digest, then consumes its task-bound TOTP challenge exactly
once. Its durable grant remains authoritative for later in-scope children;
`AuthorizationReference` is presentation data only. The server checks the grant,
child bounds and cross-task account+chain+nonce occupancy in one storage transaction
with the reservation. A cancelled, never-attempted reservation may release that
nonce occupancy; its operation ID must remain unusable. Unknown/submitted attempts
retain occupancy until independently verified reconciliation. Tenant prefixes
must not allow the same account nonce to be occupied twice across tenants.

The mobile authorization page displays the normalized parent and returns to the
same task after verification. It does not supply trusted price/settlement facts,
issue grants or infer signing capability from provider connection. Server/UI
components may progress locally while configured signer acceptance remains open.
Before the execution adapter sends, it must independently rederive exact to/data/
value/from/chain/nonce/fees, validate the live parent grant and relevant market or
controlled-account facts, and durably mark uncertainty. Missing capabilities remain
explicitly unavailable; a status or reference must never bypass these checks.
