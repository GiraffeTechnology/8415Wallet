# 8415Wallet — Stage Delivery

Delivery evidence per AGENTS.md: every stage requires implementation, tests,
documentation and evidence. Stages are defined in
[ERC-8415-Wallet-PRD.md](ERC-8415-Wallet-PRD.md) §7.

| Stage | Scope | State |
| --- | --- | --- |
| 0 | Project foundation | Delivered |
| 1 | SDK port and contract binding | Delivered |
| 2 | Asset view | Delivered |
| 3 | Temporal query and history | Delivered |
| 4 | Gap-aware settlement UX | Not started |
| 5 | Freshness annex and ecosystem integration | Not started |

---

## Stage 0 — Project foundation

Node 22 with native TypeScript type stripping, so the reference client runs
from source with no build step. `erasableSyntaxOnly` keeps the source to
syntax Node can strip; `strict`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` are on.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test
npm run verify      # both
npm run wallet      # render the views for the bundled scenarios
```

No runtime dependencies. The two dev dependencies are `typescript` and
`@types/node`.

---

## Stage 1 — SDK port and contract binding

### What was built

| Module | Role |
| --- | --- |
| `src/sdk/types.ts` | Types mirroring `IRegisterProjection` and `IProjectionSettlement` |
| `src/sdk/port.ts` | `Erc8415Reader` — the wallet's only window onto a projection |
| `src/sdk/interfaceIds.ts` | Canonical signatures, selector derivation, frozen interface ids |
| `src/sdk/conformance.ts` | ERC-165 discovery; gates for projection and settlement reads |
| `src/sdk/identity.ts` | Reads and pins `registerId` / `verificationProfile` |
| `src/sdk/errors.ts` | Revert, non-conformance, invariant and identity-drift errors |
| `src/codec/keccak.ts` | Keccak-256 (not SHA3-256), for selector derivation |
| `src/codec/abi.ts` | Static-type ABI codec for the read surface |
| `src/adapters/rpc/` | `eth_call` transport and reader |
| `src/adapters/memory/` | Invariant-enforcing contract model, reader and scenarios |

### Decisions worth recording

**Instants are `bigint`, not `number`.** A conforming contract may carry an
`effectiveAt` anywhere in `uint64`, and a far-future one is a state the wallet
must report accurately — it permanently ends the projection for that token.
Narrowing to a double would round exactly the values worth reporting.
`tests/codec.test.ts` pins this with a value beyond `Number.MAX_SAFE_INTEGER`.

**Keccak-256 is carried in-repo.** Node's `crypto` offers SHA3-256, which uses
a different pad byte and produces different digests. Using it would have
broken every derived selector silently. The implementation is validated
against published digests, against three well-known Ethereum selectors, and —
the strongest check available — by folding the derived selectors into both
frozen interface ids from the ERC.

**The read port has no write path.** `beginSettlement`, `finalizeSettlement`
and `cancelSettlement` are transactions a user's own key sends; they are
absent from `Erc8415Reader` so no wallet code can reach the projection through
it. The modelled contract implements them because a contract must.

**Adapters compute nothing.** Both return only values that came from the
contract. `tests/rpcReader.test.ts` stands the real calldata encoding between
the rpc reader and the modelled contract and asserts the two adapters agree
field for field, including the gap status enum.

**Reverts are not interpreted from reason strings.** The ERC does not
standardize them. Where a cause matters — an instant preceding the first
entry — it is established by comparing against `entryAt(tokenId, 1)`.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 84
# suites 25
# pass 84
# fail 0
```

### Coverage of the ERC's own test cases

The ERC lists what a conforming implementation must satisfy. The modelled
contract is held to the ones that describe projection behaviour a wallet
depends on:

| ERC requirement | Where |
| --- | --- |
| Interface ids are `0x6309e170` and `0xf4a7d71b` | `codec.test.ts` |
| Authority reports, reverts for unknown token, is not satisfied by `ownerOf`, is not conferred by transfer | `settlement.test.ts` |
| An `effectiveAt` further ahead than the profile allows is rejected | `invariants.test.ts` |
| An `effectiveAt` equal to the preceding one is rejected | `invariants.test.ts` |
| A repeated record commitment is rejected | `invariants.test.ts` |
| `entryAsOf` resolves inside, at the start of, and after each interval, and reverts before the first entry | `temporal.test.ts` |
| `holderAsOf` agrees with `entryAsOf` | `temporal.test.ts` |
| Ordinary transfers succeed while a gap is open and do not change the projection | `settlement.test.ts` |
| Beginning a settlement while one is open supersedes it and leaves the projection unchanged | `settlement.test.ts` |
| A successful admission appends, sets the prior `supersededAt`, and closes the gap atomically; a failure changes nothing | `settlement.test.ts`, `invariants.test.ts` |
| Cancellation before the deadline is rejected; after it succeeds and leaves the projection unchanged | `settlement.test.ts` |
| A proof succeeds after a rejected cancellation attempt | `settlement.test.ts` |
| `isFinalAsOf` is false at and after the latest entry, true for earlier covered instants, false before the first, and never reverts | `temporal.test.ts` |
| A final instant does not change holder after a further admission | `temporal.test.ts` |
| A confirming entry is admitted and makes preceding instants final | `temporal.test.ts` |
| `registerId` and `verificationProfile` are nonzero and unchanged across admissions | `identity.test.ts` |
| No entry can be admitted while no gap is open | `settlement.test.ts` |

**Not covered, and why.** The ERC also requires that admission be rejected
after mutation of every bound field, for an incorrect register identity, for
remote state not final under the profile, for a non-member record, for a stale
height and for a replayed proof; and that a membership path with index bits
beyond the path length be rejected. These are properties of a verification
profile and of a conforming contract. The wallet does not verify proofs — it
reads a projection that has already admitted them — so the modelled contract
takes an injected verifier and the wallet's tests assert only what a rejected
proof must leave behind: nothing. Claiming coverage of profile conformance
here would be claiming to have tested something this repository does not
implement.

### Coverage of the forbidden inferences

AGENTS.md requires these as explicit negative cases. All are in
`tests/forbiddenInferences.test.ts` unless noted:

| Forbidden inference | Case |
| --- | --- |
| Current owner is the historical holder | The position is Dave's, the register confirms Alice, at every instant of the projection |
| Gap closure is finality | A cancelled gap leaves later instants non-final; the holder reverts to the one confirmed before it opened |
| Cancellation is a rejection event | The entry it would have superseded stays in force, unmarked |
| An open gap prevents finality | An earlier instant is final while that same gap is open |
| Confirmation depth is finality | The chain advances ten years; no instant's finality moves |
| An instant before the first entry is an error | `isFinalAsOf` answers false without reverting; the cause is read from entry v1 |
| Absence of a gap interface means no gap is open | A projection-only contract has no gaps as a property of the contract |
| A stalled or withheld projection is misreported | Three rounds of supersession leave the projection unmoved and correctly unsettled |

### What Stage 1 deliberately does not do

- No view models, formatting or display state. A holder is an address and an
  instant is an integer until Stage 2 gives them a presentation.
- No `contested` computation. The inputs are read here; combining `openGapOf`
  with the gap's `openedAt` against an instant is Stage 4, where it is shown
  next to finality without being merged into it.
- No watchtower freshness. Stage 5, and kept distinct from finality.
- No Native Infrastructure Kit adapter. The Kit is at Stage 0 (documents only)
  and exposes no Register API yet; the port is shaped so that adapter drops in
  beside the rpc one without anything above it changing.

### Known limitations

- `HttpCallTransport` calls at `latest` and is not exercised against a live
  node in this suite; the codec it depends on is exercised in both directions.
- `MemoryRegisterContract` is a model, not a reference implementation. Where
  it and the ERC differ, the ERC is right and the model is wrong.

---

## Stage 2 — Asset view

### What was built

| Module | Role |
| --- | --- |
| `src/wallet/assetView.ts` | `buildAssetView` and its view models |
| `src/wallet/format.ts` | Instant, duration, address and hex rendering |
| `src/wallet/renderAssetView.ts` | Text rendering of the view |
| `src/cli/main.ts` | Reference client; renders the bundled scenarios |

`npm run wallet` renders two contracts: one whose position has diverged from
the confirmed holder with a gap open, and one with no settlement interface.

### Decisions worth recording

**The two sequences are separate fields with separate disclosures.** They are
never merged, and they are not merged when they happen to agree either —
agreement is reported on a third field, `alignment`, which says in as many
words that they remain two facts. Divergence is described as the design, not
as an error or a warning: the token trades while the register catches up.

**Finality of the present is read, not assumed.** The rule guarantees the
present instant is never final, but AGENTS.md forbids recomputing finality, so
the view asks `isFinalAsOf` and reports the answer. If a contract answers
`true`, the view shows `true` and says the rule does not allow it, rather than
quietly substituting the rule's answer. A contract contradicting the rule is
worth seeing.

**A formatted instant always carries its integer.** `formatInstant` renders
`2026-01-01 00:00:00 UTC (1767225600)`, never one without the other, and a
test asserts no rendered calendar time in the whole view escapes without its
integer. A `uint64` beyond representable calendar time — which is what an
admitted far-future `effectiveAt` looks like — is reported as the integer
rather than as an invalid date.

**Addresses are never abbreviated.** Telling the position and the holder apart
is the one thing this wallet exists for, and two different addresses can share
a prefix. Commitments and references are abbreviated, because they are values
a user compares rather than reads; the full value stays on the view model.

**Three-state reporting where a value may be unavailable.** Settlement
authority is `true`, `false`, or `undefined` for "could not be asked", and the
renderer prints `not reported` for the third. An earlier revision of the
renderer collapsed `undefined` into `no`, which told a user the contract had
denied them an authority it has no concept of; `tests/assetView.test.ts` now
pins the distinction. The same shape applies to gap state, where
`unsupported` and `none` are different answers.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 113
# suites 34
# pass 113
# fail 0
```

### Coverage

| Requirement (PRD §4.1) | Where |
| --- | --- |
| Tradeable position shown as the ERC-721 position | `assetView.test.ts` |
| Confirmed holder shown with version and `effectiveAt` | `assetView.test.ts` |
| Alignment reported, divergence not treated as a fault | `assetView.test.ts` |
| Open gap with id, `openedAt`, deadline, expected holder, time remaining | `assetView.test.ts` |
| Register identity, with acceptance left to the user | `assetView.test.ts` |
| Settlement authority for the user's own account | `assetView.test.ts` |
| The present instant is never final, said plainly | `assetView.test.ts` |
| No settlement interface distinguished from no open gap | `assetView.test.ts` |
| Every formatted instant resolvable to its integer | `format.test.ts`, `assetView.test.ts` |
| Far-future instants survive formatting | `format.test.ts` |
| Projection refused for a non-advertising contract | `assetView.test.ts` |
| Uninitialized projection reported rather than falling back to the position | `assetView.test.ts` |

### What Stage 2 deliberately does not do

- No per-instant queries. The asset view answers about now; asking about an
  arbitrary instant, with the before-first-entry and read-failure paths, is
  Stage 3.
- No `contested` verdict for a queried instant. The boundary is carried as
  `contestedFrom`; combining it with an instant is Stage 4, where it is shown
  beside finality without being merged into it.
- No history walk. Stage 3.

---

## Stage 3 — Temporal query and history

### What was built

| Module | Role |
| --- | --- |
| `src/wallet/temporalQuery.ts` | `buildTemporalView` — who was confirmed at instant t |
| `src/wallet/finality.ts` | `describeFinality` — the four display states and their reasons |
| `src/wallet/history.ts` | `buildHistoryView` — the append-only entry walk |
| `src/wallet/renderTemporalQuery.ts` | Text rendering of both |
| `tests/support/delegateReader.ts` | A reader that misbehaves in ways a conforming contract cannot |

`npm run wallet` now also queries one token at three instants — after the
latest entry, strictly before it, and before the first entry — and walks its
history.

### Decisions worth recording

**Resolution and finality are asked separately.** They are different
questions, and `entryAsOf` returns an answer either way. The view has two
blocks and never derives one from the other; treating finality as implied by
resolution is the integration error the ERC names as most likely.

**Four finality display states, not two.** `isFinalAsOf` answering `false`
means two different things: an instant after the latest entry is covered by an
answer a later admission may supersede, and an instant before the first entry
has no answer at all. Rendering both as "Provisional" would describe a
nonexistent answer as merely unsettled. The states are `final`,
`provisional`, `not-covered` and `unavailable`, and a test asserts the
before-first case is not the provisional one.

**The contract is asked first; its revert is classified afterwards.** The
wallet does not decide in advance which question the contract would decline.
When `entryAsOf` reverts, the cause is established by comparing the instant
against `entryAt(tokenId, 1).effectiveAt` — never by reading a revert reason,
which the ERC does not standardize. A revert it cannot attribute is reported
as `unavailable` with the raw reason, and no neighbouring instant, cached
answer or `ownerOf` is substituted.

**A `holderAsOf` that disagrees with `entryAsOf` is surfaced, not resolved.**
The ERC requires them to agree. Where they do not, the view reports both and
says the contract is at fault rather than preferring either.

**The commitment chain is verified, not recomputed.** The history walk checks
what the contract handed over against the invariants: previous-commitment
linkage, consecutive versions, strictly increasing effective times, and each
interval closed at its successor's effective time. Faults are reported and the
entries are still shown exactly as read. This is verification of received
data; the wallet never derives a holder or a finality answer from it, and the
register's contents remain off chain and unseen.

**Entries are never reordered, filtered or merged.** A holder appearing twice
is two entries, because the register recorded two facts and collapsing them
would erase the interval between. Rendering is newest-first for scanning, with
each version labelled so admission order stays readable.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 146
# suites 43
# pass 146
# fail 0
```

### Coverage

| Requirement (PRD §4.2, §4.3, §4.4) | Where |
| --- | --- |
| `holderAsOf` / `entryAsOf` resolve inside, at the start of, and after an interval | `temporalQuery.test.ts` |
| Effective interval closed at the successor; the latest left open | `temporalQuery.test.ts`, `history.test.ts` |
| Before-first-entry rendered as "does not cover", not as an error | `temporalQuery.test.ts` |
| `isFinalAsOf` false before the first entry is not shown as provisional | `temporalQuery.test.ts` |
| Finality taken from `isFinalAsOf`, with the reason in protocol terms | `temporalQuery.test.ts` |
| An answer contradicting the finality rule is flagged | `temporalQuery.test.ts` |
| A failed read shows the failure, substituting nothing | `temporalQuery.test.ts` |
| `holderAsOf` disagreeing with `entryAsOf` is surfaced | `temporalQuery.test.ts` |
| A confirming entry moves an instant to final without changing its holder | `temporalQuery.test.ts` |
| A cancelled gap moves no instant to final | `temporalQuery.test.ts` |
| Append-only walk, unfiltered, in admission order | `history.test.ts` |
| Commitment chain shown and checked link by link | `history.test.ts` |
| Chain faults reported rather than corrected | `history.test.ts` |
| Every formatted instant resolvable to its integer | `temporalQuery.test.ts`, `history.test.ts` |

### What Stage 3 deliberately does not do

- No `contested` verdict on the queried instant. The gap's `openedAt` is
  carried by the asset view as `contestedFrom`; combining it with an instant,
  and showing it beside finality without merging into it, is Stage 4.
- No settlement log. PRD §4.4 wants the `SettlementStarted` /
  `Finalized` / `Cancelled` / `Superseded` history alongside the entry walk,
  so a user can see gaps that closed without admitting anything. It needs log
  reading (`eth_getLogs` and event topics), which the port does not yet carry;
  it belongs with Stage 4's gap work.
- No risk surfaces from PRD §4.6. Stage 4.
