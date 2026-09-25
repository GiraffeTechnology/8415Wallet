# Responsibility controls — threat model and audit gate

Status: **IMPLEMENTED_LOCAL_TESTS_PASS / NOT_INDEPENDENTLY_AUDITED**.

Local development now includes account/controller/payment contracts
and consent/receipt/view adapters. This changes the review surface, not the
approval status. See [development checkpoint](../CONTROL-DEVELOPMENT-STATUS.md)
for the authority-backed occurrence/return profile, token proxy limitations,
separate funding and remaining release gates. The first unified local campaign
completed after source closure: latest 628 Node and 30 EVM cases passed. This does not
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

No independent auditor has reviewed this increment. No audit certificate,
production approval, fresh testnet receipt or security guarantee is asserted.
