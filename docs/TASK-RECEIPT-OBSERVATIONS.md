# Bounded task receipt observations

This additive source candidate connects the existing exact-operation verifiers
to a read-only task receipt adapter. It does not configure a provider, signer,
account, key, market, deployment or transaction. Synthetic tests are local evidence,
not public-chain, device, security-review or release acceptance.

## Trusted boundary

`createTaskReceiptAdapter` takes a server-owned provider and an explicit
`{ minimumConfirmations: "…" }` policy, from 1 through 1024. There is no default.
The policy's canonical Keccak digest must be displayed and approved together with
the task and executor, then retained on the attempted operation. A changed policy
requires the authorization service's revalidation process before another send.
The adapter captures provider methods once and permits only the exact read-only
RPC methods needed by the existing verifiers. Request JSON cannot choose a provider,
reduce confirmation depth or supply a success flag.

Before an attempted send, the service must call the captured trusted
`assessChild({ task, child, executor, observationPolicy })` method. It independently
normalizes the binding and reconstructs the same supported encoding used by the
receipt path. Dynamic deposit/withdraw account resolution is read-only. It returns
only the task/child/executor/policy digests, verifier identity and
`capability: exact-operation-observable`; these fields must match the service's
stored binding. No request `supported` flag is accepted. The default adapter
explicitly refuses NFT-sale tasks before RPC, so configuring an executor cannot
send a sale whose result this verifier cannot observe. An assessment is neither
authorization nor a prediction of transaction success.

`observe` takes the frozen task and child, recorded executor, original send attempt
(executor digest, grant policy version and known transaction hash), and recorded
observation policy. It reconstructs the existing operation's encoding and compares
its destination, calldata hash and value before reading receipts. Account operations
resolve registration and owner/controller bindings through `ControlledAccountClient`.

The adapter returns the strict `8415-task-observation/1` record, bound to task,
child, chain, actor, nonce, original hash, attempted executor, attempted grant
version, approved observation-policy digest and receipt-verifier identity. The
identity hashes the exact runtime source closure. It changes when implementation
bytes change. The normalizer and binding helper are pure data checks: parsing a
record never makes it trusted or authorizes a send. Only the configured server
adapter may supply evidence to the service.

## What is established

- Native transfers require the exact canonical transaction, successful receipt,
  confirmation depth and EOA sender/recipient code at that receipt block.
- ERC-20, ERC-721 and ERC-1155 transfers reuse the external-asset verifier's exact
  transfer event checks. The private session methods now delegate to the same
  exported observer while retaining their account and connection guards.
- Account creation and responsibility completion/return reuse the existing control
  client; deposit/standalone withdrawal reuse the fixed-call verifier. They retain
  pinned code, exact calldata, actor/nonce, expected event and canonical-block
  verification. Complete/return additionally bind the sequence's token and code
  pin at the receipt block using the shared strict sequence decoder.
- Receipt log metadata must agree on transaction hash, block hash, block number
  and transaction index, with `removed: false`. A status-one receipt without the
  required operation event is insufficient. Success also checks the recorded gas
  and maximum gas price against the child's reserved limits.
- Additional receipt-block reads are followed by another canonical-chain check.
  A null, changed or lower canonical head cannot preserve a successful observation.

Exact token events are execution evidence for the supported standard behavior;
they do not promise future balances or nonstandard fee/rebase economics. No
observation claims verified legal identity, registrar finality, economic finality
or ERC-8415 temporal finality. Both finality fields remain `not-evaluated`.

## States and recovery

`pending`, `confirming`, `reorged`, `reverted-at-depth` and
`superseded-at-depth` have `effect: not-established`. Only
`confirmed-at-depth` can carry `exact-operation-observed` or the separately
reserved `atomic-sale-observed` effect. This adapter never emits the sale effect:
the current child schema does not encode an atomic marketplace fulfillment.
A plain NFT transfer or claimed quote is explicitly refused as sale verification.

Observations describe the chain at `observedAt`. Stored observations are historical
snapshots. Every continuation must read again, including after a previous result
was confirmed or superseded. Disappearing receipts degrade to pending; changed
canonical blocks degrade to reorged. Transport or binding failures must be shown as
unavailable rather than displaying old evidence as freshly verified.

`observeReplacement` accepts a transaction hash only as an untrusted locator.
It first rules out a currently mined canonical original, then reuses the existing
same-actor/chain/nonce replacement proofs. The replacement must have a different
intent and sufficient canonical depth. It never proves the original successful.
The service retains the replacement locator separately from current evidence:
a shallow/disappeared replacement becomes pending, and its reorg becomes reorged.
Only an established `superseded-at-depth` record includes `replacementHash`.

If the send response was lost and no original hash is known, both receipt methods
refuse. Existing trusted recovery must first establish a matching original-intent
hash. A different-intent replacement of a lost-hash attempt remains explicitly
unknown and occupied; this version does not invent an original hash.

The adapter never writes stores or changes budgets. Attempted operations retain
their permanent nonce/send tombstones and full conservative fee/quantity reservation
whether pending, unknown, reverted, confirmed or superseded. It does not release
unknown/reverted quota, retry a send or imply a task is complete merely because a
hash was returned.

## Exact runtime closure

`TASK_RECEIPT_RUNTIME_FILES` declares 13 files. The server uses native TypeScript
stripping on Node 22.18 or newer; no external runtime package is imported.

- `server/task-receipt-adapter.mjs`: trusted adapter, read-only RPC guard and identity
- `src/agent/receiptObservation.ts`: strict observation/policy normalization and binding
- `src/agent/taskContract.ts`: canonical frozen task/child contract
- `src/controls/accounts.ts`: existing registered-account resolution
- `src/controls/client.ts`: existing responsibility receipt and sequence decoder
- `src/controls/execution.ts`: fixed-call receipts and superseded-nonce proof
- `src/controls/authorization.ts`: pinned deployment checks, RPC and hash primitives
- `src/xiongan/externalAssets.ts`: shared external-asset receipt/replacement checks
- `src/xiongan/address.ts`: canonical input address checks
- `src/codec/abi.ts`: existing exact operation encoding/decoding
- `src/codec/keccak.ts`: canonical hashes and selectors
- `src/sdk/errors.ts`: ABI codec error classes
- `src/sdk/interfaceIds.ts`: ABI selector helper

The package test derives the real non-type import graph and requires exact equality.
A hermetic 13-file copy loads without other source files, a missing dependency
fails, and changing closure bytes changes the verifier identity. Package builders
must list these files individually and retain their source/hash checks; this list
is not permission for a broad source-directory allowlist. Type-only imports remain
compiler inputs but are not required by the native-stripping runtime.

Focused tests: `tests/task-receipt-observation.test.mjs` and
`tests/task-receipt-package-closure.test.mjs`. Extraction regressions use the
unchanged `tests/xiongan-assets.test.ts` and `tests/controls-workflow.test.ts`.
