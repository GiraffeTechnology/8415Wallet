# Responsibility controls — threat model and audit gate

Status: **EXPERIMENTAL_LOCAL_KERNEL / NOT_INDEPENDENTLY_AUDITED**.
No production execution adapter is present. Do not deploy this SDK as a signer
or interpret a proposal as permission. Earlier escrow audit/tests are not an
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
| Escrow treated as responsibility authority | No escrow/payment dependency or field | Test independent account execution without funding; isolate optional payment calls |
| Cross-chain/token/control replay | Exact domain and revision matching | Domain-separated signatures, expiry/nonce, contract/account identity validation |
| Fabricated consent or authority | Separate exact consent structure and actor/return-role checks | Real signer verification; full payload including inherited scope; no caller-supplied authenticated flags |
| Dropped/replaced upstream terms | Exact ordered active inherited list | Atomic receiver acceptance; alternate transfer/approval/delegation/upgrade bypass matrix |
| Fake holder or repeated address confusion | Occurrence+account checks; both positions required | Authenticated admitted-entry-to-occurrence proof; coherent atomic chain reads; malicious adapter refusal |
| Completion crosses callback / return crosses detached leg | Revision checks, exclusive callback, completed prefix, reverse-hop order | On-chain serialization, reentrancy tests, concurrent transactions and atomic revert |
| Failure reported as successful transfer | Explicit uncommitted proposal; source not mutated | State+token atomic commit, receipt reconciliation, crash/restart and reorg tests |
| Payment failure revives responsibility | No payment outcome used by kernel | Separate settlement-due/refund-due accounting; malicious payment callback tests |
| Unbounded sequence / overflow | 4,096-leg bound and uint256 revision exhaustion refusal | Measure gas/work limits for actual executor; no silent truncation |
| Return followed by new forward loses history | Refuse forward after returned history | Audited new-sequence lifecycle retaining unresolved obligations |

The kernel cannot defend against fabricated trusted state/facts or an executor
that persists `next` before a transfer succeeds. These are explicit unimplemented
security boundaries, not risks cured by a passing unit test. It accepts typed
in-process inputs; untrusted transport schema parsing is not implemented here.

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

No independent auditor has reviewed this increment. No audit certificate,
production approval, fresh testnet receipt or security guarantee is asserted.
