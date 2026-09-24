# Independent controls — development checkpoint, 2026-09-25

Status: **IMPLEMENTATION_IN_PROGRESS / UNTESTED / NOT_RELEASE_READY**.
PR #3 remains unmerged. This record is not an acceptance report.

## Execution order

The user requires all development to finish before the unified test campaign.
During this increment no compilation, typecheck, unit/EVM test, CI trigger,
testnet RPC, signature, deployment or transaction was executed. Source reading
and implementation are not passing tests. The later user instruction requests
one new draft PR per stage: use development HEAD commits marked `[skip ci]`
with the unchanged push/pull_request workflow. This defers execution, never
waives verification. Once all development is complete, new commits without
skip directives must trigger CI. Do not disable workflows. Inserted cooperation
and checkpoint reports do not complete the task.

After implementation is complete: freeze the candidate; run the complete local
and adversarial suites; obtain independent security review and resolve findings;
then perform the real public-testnet deployment/transaction and UI acceptance
campaign. Local tests, simulation or old chain receipts cannot replace that run.
Keep compiler/runtime/lock hashes, deployment addresses, chain IDs, transaction
hashes, canonical receipts, state readbacks and W-01–W-21 verdicts. Never retain
keys, credentials or raw consent signatures in reports.

## Source now written, not validated

- `contracts/controls/ControlledWallet.sol`: immutable owner/controller token
  account, controller-only protected transfer and standalone withdrawal only
  outside an open responsibility sequence; no arbitrary execution or approval
  surface.
- `ControlSignatures.sol`: EOA low-s and ERC-1271 consent validation.
- `ResponsibilityController.sol`: exact typed acceptance of current/inherited
  obligations; revision/nonce/expiry; atomic token movement; admitted occurrence
  binding; irreversible completed prefix; bounded reverse hops; retained history
  and close/reopen lifecycle. Maximum 128 on-chain legs, not the model's 4096.
- `NativeResponsibilityPayments.sol`: optional per-leg native payment record,
  allocation only after completion/actual return, exact-recipient withdrawal.
  It cannot authorize or undo responsibility; a failed payout remains due.
- `src/controls/authorization.ts`: pinned deployment, EIP-712 payload, explicit
  provider consent request and bounded RPC waits. Timeout is an uncertain wallet
  outcome, not proof that signing/submission did not occur; never auto-retry.
- `client.ts`: fixed controller calls, coherent block-hash snapshots, explicit
  transaction submission, canonical receipt/event checks and a strict recovery
  journal containing hashes/public metadata only. A pending hash is not success.
- `view.ts`: pinned projection/control reader connected to existing linked-mode
  presentation, with explicit authority-trust disclosure. No automatic execution.
- `index.ts`: isolated experimental entry point; the stable root wallet surface
  and legacy standalone behavior have not been replaced.
- `accounts.ts`: factory-registered account discovery, explicit account creation,
  pinned-token deposit and policy-checked standalone withdrawal with actual
  Transfer-event receipt reconciliation.
- `payments.ts`: independent optional adapter binding, exact funded terms,
  allocation and exact-recipient withdrawal; unfunded/due/paid states remain
  distinct from responsibility outcomes. These sources are also untested.

## Stage PR tracking

- PR #3 remains the unchanged foundation at `bc99ff0` and is not merged.
- Stage 4B draft: PR #4, remote `a7cd45a5cc0203db8ba4fb92ef931f3679fd224e`,
  tree `e52c4332db5f2ad2f3360f16251699bbc6281369`, base PR #3 branch.
- Stage 5A draft: PR #5, initially remote `c4bae7dd239b72429466cfe5194ee91cdee4e415`,
  tree `41a3aa4d07e17bb52d366c8ce8a34bfec858a329`, base Stage 4B branch.
- Initial local commits `96caa1f` and `7b095a9` have identical trees to their
  respective remote commits. Direct git push timed out; GitHub Git Data API
  published the exact trees with different commit metadata. Do not force-push
  local divergent history. Use verified remote heads for subsequent updates.
- Initial PR workflow queries returned no runs for either remote head. No
  CI configuration was changed. This is a scheduling fact, not validation.

## Explicit implementation assumptions — not audited guarantees

1. The accepted evidence authority must also be a protocol settlement authority.
   It attests an admitted entry's specific occurrence. The token confirms entry
   bytes, but cannot itself prove the external association. Repeated addresses
   are not enough; a dishonest authority is still a trust risk. Do not describe
   this profile as trustless proof verification or verified legal identity.
2. Callback is an explicitly accepted authority-attested condition profile.
   A condition hash/evidence commitment is not proof that a legal remedy is due.
   Ordinary lag, RPC errors and cancelled gaps never automatically trigger it.
3. Runtime-code/register/profile pins do not prove an unchanged implementation
   behind an upgradeable token proxy. Deployment compatibility and audit must
   cover the selected token's complete trust/upgrade model.
4. Optional funding currently follows protected forwarding in a separate
   transaction. Until funded, the leg is UNFUNDED; do not show principal as
   reserved or imply atomic delivery-versus-payment. Complete funded-flow UX and
   validation before claiming W-01/W-02.
5. The SDK relies on an authenticated intended-chain provider and EIP-1898
   canonical block reads. A malicious RPC is not defeated by hash comparisons
   alone. Missing capability or inconsistent observations must fail closed.
6. Contract-owner signing needs a provider that can supply a valid ERC-1271
   signature; the SDK does not synthesize one or hold a private key.

## Remaining development (not acceptance claims)

- Complete application-facing setup/payment/recovery presentation around the
  newly written account/payment clients. Do not label them validated yet.
- Finish acceptance display/recovery integration and exact action workflows;
  never surface speculative state as executed state.
- Write unified regression, adversarial/EVM and public-testnet run tooling for
  each W-01–W-21 scenario, signature replay, alternate paths, returned history,
  failures, canonical receipt recovery and payment reentrancy/failure.
- Complete deployment manifest and independent audit package for the actual
  contracts/accounts/evidence profile. None has been security approved.
- Execute no tests until development is complete. Subsequently perform genuine
  standalone and linked desktop/mobile flows against deployed testnet contracts.

The real Sepolia deployment/test from 2026-09-19 remains historical fact. The
bc99ff0 increment's 607 Node/14 legacy EVM tests also remain historical; neither
is evidence for these new files. No new deployment is asserted here.
