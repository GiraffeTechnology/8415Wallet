# Stage 5C — unified validation and deployment tooling

SOURCE_COMPLETE_PENDING_UNIFIED_VALIDATION / UNTESTED. This is prepared executable tooling,
not a claim that tests, deployments, audit or UI journeys have run.

## Execution order after implementation closure

1. Freeze the integrated source, lockfile, compiler configuration and all stage
   PR trees. Do not merge PR #3 or a downstream draft merely to start testing.
2. Run TypeScript, Node suites, browser build, legacy EVM and new control EVM
   suites as one validation batch. Fix failures honestly and re-run affected and
   full regression gates. Publish fresh no-skip commits for CI only then.
3. Review the actual enforcement/account/authority/payment boundary independently.
   Preserve findings and retest evidence; do not self-issue an audit certificate.
4. Run the public-testnet script against five distinct, funded, isolated test
   signers through an authorized signing RPC. Never paste an endpoint credential
   or key into a report. The script does not import deployment-wallet keys.
5. Use the resulting public deployment manifest for genuine standalone and
   linked desktop/mobile journeys. Include terms, wallet prompt, actual owner/
   holder divergence, detached head, callback/refund and restart/reorg displays.
6. Only after the required gates are met, merge stacked PRs in dependency order.

## Prepared programs

- `test-evm/responsibility-controls.cjs`: nine explicit EVM cases against the
  real reference projection, with signed proof-verified admission.
- `test-evm/control-payments-adversarial.cjs`: three cases for ERC-1271 owner,
  rejected/reentrant native payout, alternate paths and a clearly marked
  negative-only faulting asset. The faulting asset is not conformance evidence.
- `test-evm/control-sdk.cjs`: two actual SDK-to-EVM journeys covering review,
  upstream disclosure, typed signing, receipt reconciliation, protocol views,
  completion/exit and separate original-route payment refund.
- `scripts/controls/scenario-kit.cjs`: shared, receipt-bound real-reference
  multi-wallet journeys; no mock holder substitutions or clock manipulation.
- `scripts/controls/public-testnet.cjs`: exact frozen source/build-info/artifact
  checks, five distinct roles, chain allowlist, explicit gas/fee/total budgets,
  no automatic retries, CreateNew append/hash-chain evidence and failure result.
- `scripts/controls/serve-browser.cjs`: loopback-only static UI; strict Host and
  file allowlists, no RPC forwarding, uploads, signing or secret endpoints.

The testnet runner requires explicit `WALLET_TESTNET_EXECUTE=TEST_ONLY_NO_REAL_VALUE`,
the selected chain ID, maximum fee per gas, maximum gas per transaction, total
budget, confirmation depth and the exact source commit. RPC access is supplied
through the controlled process environment; five public actor addresses are a
separate allowlist. The output directory must be absolute and absent, with a
pre-existing approved parent. Missing funding/custody/build closure fails closed.
No defaults silently authorize cost or reuse a production account.

Temporary registrar validator keys are created in memory only for the disposable
test trust profile. They are not retained and are not an actual remote register.
Test tokens and on-chain fixtures remain on the test chain. Never claim chain
objects can be deleted or that these fixtures represent real-world legal rights.

## Requirements-to-call map (prepared, NOT results)

| PRD cases | Executable observations / remaining evidence |
| --- | --- |
| W-01/02 | Funded shared journey: three forwards and three distinct payment records |
| W-03 | Extended journey: real open gap remains open while accepted forwards proceed |
| W-04/05 | Owner D/holder B or C; complete prefix with latest interval still provisional |
| W-06 | Stale signed tail refuses after prefix revision; fresh tail retains all history |
| W-07/08 | Actual bounded D→C→B→A versus detached AB boundary at B; original-route payouts |
| W-09/10 | Unresolved descendant and callback-without-return allocation refuse |
| W-11 | Negative-only transfer fault preserves state; rejected payout stays due and resumes |
| W-12 | Duplicate revision/payout refusals; public journal restart and no resend Node cases |
| W-13 | Exact recipient EIP-712/1271 consent; malformed and invalidated consent refuse |
| W-14 | EOA approval/operator, direct control transfer and absent execute/upgrade paths refuse |
| W-15 | A→B→A→C binds an explicit occurrence; admitted version cannot be rebound |
| W-16 | Strict SDK schemas/pins, transport faults, wrong identity; more hostile RPC/UI review required |
| W-17 | Accepted callback serializes out stale and current-revision completion |
| W-18 | Late real admission leaves Returned history unchanged |
| W-19 | Owner-only refuses; admitted occurrence binding required; provisional stays visible |
| W-20 | Shared public journey is executable; genuine UI/evidence still requires actual execution |
| W-21 | Same control journey without payment; separate adapter never controls responsibility |

No aggregate PASS is computed from this mapping. The runner result explicitly
says CORE_JOURNEYS_EXECUTED_NOT_FULL_V3_ACCEPTANCE even when its own calls succeed.
UI, full negative coverage and independent audit need their own evidence.

## Source closure versus acceptance

The implementation pass now supplies independent contracts, typed SDKs, genuine
provider UI, public recovery stores and executable validation/deployment tooling.
No new V3 test has run at this source-closure checkpoint. The next work is the
unified validation campaign and repairs it identifies, not feature expansion.
PR #3 remains unmerged; no security certificate or real-chain V3 PASS is implied.
The neutral browser styling is not a claim to implement unavailable brand assets.
Actual desktop/mobile observations and external review are still acceptance gates.
