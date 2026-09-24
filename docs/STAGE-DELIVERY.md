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
| 4 | Gap-aware settlement UX | Delivered |
| 5 | Freshness annex and ecosystem integration | Delivered |
| — | Usability pass: the write path, the application seam, audit export | Delivered |
| — | PRD v2.1: requirements from the eth-magicians discussion | Delivered |
| — | v3.0 linked sequence/CP-01 read-only preview | Implemented and locally tested; execution and W-01–W-20 acceptance remain open |

## v3.0 first code increment — 2026-09-25

`src/sdk/linked.ts`, `src/wallet/linkedChainView.ts` and
`src/wallet/renderLinkedChain.ts` add an optional read-only public SDK surface.
Standalone sessions and the legacy escrow remain unchanged. The trusted backend
contract, supported records, CP-01 rules and remaining execution work are in
[LINKED-MODE-IMPLEMENTATION.md](LINKED-MODE-IMPLEMENTATION.md).

Executed on Windows, Node v24.19.0:

- strict TypeScript check: exit 0;
- linked increment: 59/59 tests;
- full Node suite: 572/572 tests, 104 suites, zero skipped;
- local EVM: 14/14 existing escrow tests; six Solidity files compiled;
- existing reference CLI: exit 0;
- patch whitespace check: clean.

The first full-suite attempt found `python3` unavailable on Windows. A temporary
command-name alias to the existing Python 3.12.14 runtime was used with its DLL
search path and PYTHONHOME; the entire suite then ran from zero. No test was
removed or skipped. Temporary executable aliases and generated Python 3.12
bytecode were removed. Existing tracked Python 3.11 files were not changed.

These are local model/baseline regression results, NOT linked-contract, public
testnet, protected-recipient, payment-release, callback/refund or UI acceptance.
The model deliberately produces no transactions. The earlier real Sepolia test
remains evidence for its original candidate, not this v3.0 increment.

---

## Stage 0 — Project foundation

Node 22.18 or newer, where TypeScript runs from source without a flag, so the
reference client needs no build step. `erasableSyntaxOnly` keeps the source to
syntax Node can strip; `strict`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess` are on.

CI (`.github/workflows/ci.yml`) runs typecheck and tests on Node 22 and 24,
then runs the reference client end to end — the suites cover the view models,
and that last step catches a renderer or CLI wiring break that would leave
them passing.

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

---

## Stage 4 — Gap-aware settlement UX

### What was built

| Module | Role |
| --- | --- |
| `src/sdk/events.ts` | Event definitions, topic derivation, log decoding |
| `src/wallet/contested.ts` | `describeContest` — the contest signal, apart from finality |
| `src/wallet/settlementLog.ts` | Gap episodes and how each one ended |
| `src/wallet/riskSurfaces.ts` | The five surfaces of PRD §4.6 |
| `src/wallet/renderGapView.ts` | Text rendering of both |

`getLogs` joins the port as an optional capability, implemented over
`eth_getLogs` and by the in-memory adapter.

### Decisions worth recording

**Contest is computed and displayed apart from finality.** They answer
different questions and the ERC requires them to be distinguishable. The
temporal view has two blocks, and the tests pin the combinations that prove
they are independent: an instant that is final while a gap is open elsewhere
on the token, and an instant that is contested and provisional at once.

**Contest is present tense.** Once a gap closes, by admission or by
cancellation, no instant is contested — even though instants at or after the
latest entry remain non-final. Closing a gap ends the contest and settles
nothing.

**The log says which settlements existed; the contract says what became of
them.** `SettlementStarted` does not carry `openedAt` — that is the block
timestamp at which `beginSettlement` succeeded, and it is what bounds the
contested interval — so it is read from `settlement(settlementId)` rather than
guessed at. Where both speak, the contract is authoritative: a node's log
retention can truncate history, and a status folded from a partial log would
be a guess.

**A reader that cannot fetch logs says so.** An empty episode list and "logs
could not be read" are different claims, and only one of them means no gap
ever opened. The note says as much, and the supersession count says "not a
count of zero" rather than reporting zero.

**The three closures are not interchangeable.** Each episode carries what its
ending means: an admission appended an entry and made earlier instants final;
a cancellation ended the contest and settled nothing, and is not a rejection
because the protocol defines none; a supersession left the projection
unchanged and made any proof already produced for that settlement unusable.

**Risk surfaces are findings, never verdicts.** Each carries the measurement
and what the ERC says follows from it. Nothing is scored, ranked, or turned
into a safe/unsafe judgement, and nothing is gated on them. A test scans the
rendered surfaces for verdict language and fails on it — the note, where the
wallet states what it will not do, is the one exempt place those words appear.

**The in-memory adapter encodes real logs.** It holds structured events and
could hand them over directly; it encodes them to topics and data instead, so
the decoder runs against the wire format here exactly as it does against a
node. A decoder only exercised against hand-written fixtures is untested.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 173
# suites 48
# pass 173
# fail 0
```

### Coverage

| Requirement | Where |
| --- | --- |
| Contested interval bounded by the gap's `openedAt` | `gapView.test.ts` |
| Contested and non-final distinguishable (ERC test case) | `gapView.test.ts` |
| A closed gap contests nothing while instants stay non-final | `gapView.test.ts` |
| No settlement interface means no contested instants at all | `gapView.test.ts` |
| Admitted / cancelled / superseded closures distinguished with their meanings | `gapView.test.ts` |
| A cancelled gap visible though it admitted nothing | `gapView.test.ts` |
| `openedAt` read from the settlement record, not the log | `gapView.test.ts` |
| Missing log capability reported, not rendered as an empty history | `gapView.test.ts` |
| Every §4.6 surface reported, with no verdict language | `gapView.test.ts` |
| Far-future effective time flagged only when present | `gapView.test.ts` |
| Topic derivation, per-event `tokenId` slot, indexed vs data decoding | `events.test.ts` |
| An unnameable log returns undefined rather than a guess | `events.test.ts` |

---

## Stage 5 — Freshness annex and ecosystem integration

### What was built

| Module | Role |
| --- | --- |
| `src/sdk/watchtower.ts` | `WatchtowerReader` — a separate port for a separate contract |
| `src/wallet/freshness.ts` | `buildFreshnessView` — reorg-safety, never finality |
| `src/adapters/rpc/watchtowerRpcReader.ts` | `eth_call` against a freshness layer |
| `src/adapters/memory/watchtower.ts` | The classification rule, modelled |
| `src/sdk/readerConformance.ts` | `checkReaderConformance` — the harness every adapter must pass |
| `docs/INTEGRATION.md` | How to bind a backend, and what an adapter may not do |

### Decisions worth recording

**`FRESH_FINAL` is displayed as "Reorg-safe".** The contract's enum name is a
trap for a reader: the state means the head's signing block is buried under
`finalityDepth` blocks, which is reorg safety of an attestation, and says
nothing about whether the register confirmed anything or whether a projected
instant can still change. The wallet labels it `Reorg-safe`, shows the raw
enum value beside it marked as raw data, and a test asserts the word "final"
never appears in the label.

**The separation is structural, not editorial.** The watchtower has its own
port and its own contract; the temporal view has no freshness field, so there
is nowhere for a freshness answer to land. Tests hold the line in both
directions: a `FRESH_FINAL` head does not make a provisional instant final,
and a `STALE` head does not unsettle a final one.

**A conformance harness, in place of a speculative Kit client.** PRD §2 names
the Native Infrastructure Kit as a backend, and §7 puts its adapter in this
stage. The Kit is at Stage 0 — documents, no implementation, no Register API
to bind to. Writing a client for an API that does not exist would mean
inventing its endpoints and then shipping tests proving the invented client
matches the invented API: a passing suite that establishes nothing. What
ships instead is the thing that makes the Kit adapter cheap when it is
possible — a harness that states what any adapter must do, run against both
shipped adapters, the rpc one over the real calldata encoding.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 194
# suites 54
# pass 194
# fail 0
```

### Coverage

| Requirement | Where |
| --- | --- |
| The classification rule: unknown, fresh-pending, fresh-final, stale | `freshness.test.ts` |
| A revoked key collapses the head to stale retroactively | `freshness.test.ts` |
| `FRESH_FINAL` never labelled as finality | `freshness.test.ts` |
| Freshness cannot change a finality answer, in either direction | `freshness.test.ts` |
| The watchtower is a separate contract with a separate port | `freshness.test.ts` |
| Both shipped adapters pass the conformance harness | `readerConformance.test.ts` |
| The harness catches a swallowed revert, a wrong finality answer, and a `holderAsOf` disagreement | `readerConformance.test.ts` |

### Not built, and why

- **The Kit adapter.** Reasons above; `docs/INTEGRATION.md` says what it will
  need to do.
- **Attestation submission.** The wallet reads freshness. Submitting an
  attestation is a watchtower operator's job, needs EIP-712 signing against
  the layer's domain, and is not something a holder's wallet does.

---

## Usability pass — making it usable against a real deployment

An audit against the PRD found the wallet could read everything and act on
nothing. It told a registrar "you may open a gap" and then offered no way to
open one, its freshness layer could not be pointed at a real feed, its custody
story had no export, and an application had no entry point to import. This
closes those.

### What was built

| Module | Role |
| --- | --- |
| `src/sdk/transactions.ts` | The three settlement operations, with preflight |
| `src/wallet/session.ts` | `WalletSession` — the application seam |
| `src/wallet/auditTrail.ts` | A re-checkable export of entries and gap transitions |
| `src/index.ts` | The public entry point |
| `src/codec/abi.ts` | `encodeCallWithTail`, for `finalizeSettlement`'s dynamic `bytes` |

### Decisions worth recording

**The wallet builds transactions and never signs them.** It produces an
unsigned request and hands it to a `TransactionSigner` the caller supplies —
an injected provider, a hardware wallet, a custodian's service. No key
material is read, stored or transmitted, because none is ever given. "No key
material leaves the device" is true by construction rather than by policy.

**Three operations, and no fourth.** `beginSettlement`, `finalizeSettlement`,
`cancelSettlement`. There is no rollback, veto, override, or direct entry
write, and a test asserts the transaction surface has exactly those three
keys.

**Preflight refuses what it has established would revert, and says what it
cannot check.** Each check is `passed`, `failed`, or `unverifiable`. The
authority check, the settlement period bound, strict monotonicity of
`effectiveAt` and commitment uniqueness are all read off the contract and
block a build. Proof validity is `unverifiable` and says so in those words:
the contract verifies it on chain under a profile the consumer must accept,
and a proof establishes inclusion in accepted finalized remote state — not
that an asset exists or that a record is legally effective.

**Consequences are reported without blocking.** Superseding an open gap and
cancelling a settlement are the protocol working as specified, and both are
easy to sign without understanding. Each build carries them in plain words:
that supersession makes an already-produced proof unusable, and that
cancelling settles nothing and is not a rejection.

**A watchtower binding is an assertion, never a verified fact.** There is no
on-chain link between an ERC-8415 `registerId` and a watchtower `assetId` —
the two contracts do not know about each other. `computeAssetId` is asked of
the watchtower rather than recomputed locally, because the namespace it hashes
under belongs to the deployment. Every freshness view carries how the pairing
was obtained and states that the wallet did not check it.

**One identity pin per session.** `ContractIdentityPin` only detects drift
across reads that share it, and every view previously constructed its own — so
each compared a value against itself and nothing was ever checked.
`WalletSession` holds one and passes it to every view; a test drifts
`registerId` between two views and asserts the second is refused.

**The audit trail is re-checkable, not summarised.** Integers are decimal
strings so a JSON number cannot narrow a `uint64`, hashes are verbatim, and
each gap transition carries the block and log index it was emitted at, so a
third party can locate it independently of the file. Where the gap log could
not be read it says so, because an empty list and "could not be read" are
different claims.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 231
# suites 66
# pass 231
# fail 0
```

### Gaps this pass did not close

- **The Native Infrastructure Kit adapter.** Unchanged: the Kit exposes no
  Register API. See `docs/INTEGRATION.md`.
- **The ERC-721 ownership sequence is still shown only as a current value.**
  The asset view reports `ownerOf` and the history view walks projection
  entries; neither shows the transfer history. AGENTS.md's layer two and the
  README describe recording *both sequences*, so either the transfer log
  belongs in the history view or that wording should be narrowed. It is a
  decision about scope, not an oversight, and is left open deliberately.
- **`buildHistoryView` makes one `entryAt` call per entry.** Over RPC that is
  one round trip each, with no batching or multicall.
- **The reference client is a terminal renderer.** The view models are the
  product; rendering them anywhere else is a consumer's choice.

---

## PRD v2.1 — built

The section that stood here recorded the specification running ahead of the
implementation. It no longer does.

### What was built

| Module | Role |
| --- | --- |
| `src/wallet/registration.ts` | What a pending registration means to the holder |
| `src/wallet/acquisition.ts` | The facts someone about to acquire should see |
| `src/wallet/posture.ts` | The projection and the feed, shown together |
| `src/wallet/collisions.ts` | Cross-token commitment and reference comparison |
| `src/sdk/transactions.ts` | Requests carry their intent; `revalidate` re-derives one |

### Decisions worth recording

**"How far behind is it" is answered without inventing a number.** Counting
hops would need the ERC-721 transfer history, which the wallet does not read.
What it *can* establish is that the gap's `expectedHolder` is not the current
`ownerOf`, which means at least one more registration must follow the one in
flight. The view says "at least one further transfer" and a test asserts no
numeric hop count is ever rendered.

**The holder-facing copy never frames a pending registration as a failure.** A
test bans the affirmative phrasings — "transaction failed", "is stuck",
"blocked until" — and asserts every state says the token is not blocked. An
earlier version of that test banned the bare word "error" and failed against
copy reading "this is not a failure and not an error", which is the wording
that should be there; the test now checks framing rather than vocabulary.

**A passed commitment window points at the trade terms and stops.** The wallet
reports that the window passed and says what follows is governed by the terms
agreed with the counterparty — not by the protocol and not by the wallet. It
offers no remedy and takes no action.

**"Who to ask" says what the wallet cannot resolve.** `registerId` and the
settlement authority are on-chain identifiers; mapping either to a contactable
party is profile-defined and off chain. Saying so beats leaving a holder to
conclude there is nobody.

**The posture view exists because keeping two signals apart is not enough.**
Freshness and finality are computed separately, as they must be. But a reader
who only ever sees one at a time cannot tell a stale feed from an ordinary
pending change, which is the failure the freshness layer exists to prevent. The
view reports the pair with `feed-not-current` as its own case — including when
the instant *is* final — and recommends none of them.

**The collision check states its own limit.** It compares the tokens it was
given, and its scope note says that finding none is not evidence that none
exists. A test builds one register entry backing two tokens, asserts the
history walk on each token individually reports an intact chain, and then
asserts only the comparison finds it — which is the whole reason the ERC hands
this to the indexer layer.

**A request carries the intent it was built from.** `revalidate` re-derives it
against current state and reports what moved, returning a report rather than
throwing when the request would now be refused — the caller asked what changed,
and "it would be refused, here is why" is that answer. The preflight note now
names the on-chain atomic read as *the* recommended shape, with land-time
handling as the fallback for a display read rather than an equal option.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 258
# suites 72
# pass 258
# fail 0
```

### Still open

- **The Native Infrastructure Kit adapter.** Unchanged: no Register API.
- **Batching.** `buildHistoryView`, `detectCollisions`, discovery and the
  ownership timeline all walk one call at a time. On a real endpoint that is
  one round trip each.
- **Never read against a real contract.** Every adapter test faces a fake node
  written from the same understanding that produced the encoder. If that
  understanding is wrong in the same way twice, the suite passes and nothing
  works. Closing this needs the ERC's reference implementation deployed on a
  local or test chain.

---

## Live reads and token discovery

Closes the two findings that kept the wallet a library rather than a product:
nothing connected the rpc adapter to a command line, and every entry point
required a `tokenId` the holder had no way to obtain.

### What was built

| Module | Role |
| --- | --- |
| `src/cli/args.ts` | Argument parsing and the combinations worth refusing early |
| `src/cli/live.ts` | The same views, against a live deployment |
| `src/wallet/discovery.ts` | Which tokens an account holds |

```sh
npm run wallet                                        # bundled scenarios
npm run wallet -- --rpc <url> --contract <address> --account <address>
npm run wallet -- --rpc <url> --contract <address> --token <id> --instant <seconds>
```

### Decisions worth recording

**Discovery confirms against `ownerOf`, never against the log alone.** ERC-721
enumeration is optional and most deployments omit it, so tokens are found by
scanning `Transfer` logs for the account — but a log says what was *received*,
not what is *held*. Each candidate is re-read; a token since passed on is
reported as moved on rather than held. Its limits are stated in the view: it
needs a log reader, and a range trimmed by node retention would hide a token,
so an empty result is not proof the account holds none.

**`Transfer` is decodable now, and still not a projection event.** It was
previously excluded from the event decoder on the grounds that it is not an
ERC-8415 event, which is true and was the wrong call once discovery needed it.
A test asserts it decodes and that no transfer ever reaches the settlement log.

**Token ids and instants stay `bigint` through the command line.** A `uint64`
past `Number.MAX_SAFE_INTEGER` survives parsing, and a test pins it — the same
reason the rest of the wallet holds them as `bigint`.

### A defect the live path found

Running the client against an unreachable endpoint reported:

> `0x4f2a…0001 does not advertise 0x6309e170; refusing to read the projection`

The contract had advertised nothing of the sort; the node was simply not there.
`detectConformance` caught every error from `supportsInterface` and returned
`false`, so a transport failure arrived as a finding about the contract — a
cause the wallet never established, which is the failure mode this project
exists to avoid. It now swallows only `ContractRevertError`, which is a
contract genuinely declining to answer, and lets anything else propagate. The
client reports an unreachable endpoint as one.

Worth recording how it was found: 276 unit tests did not catch it, because
every one of them supplies a reader that works. It surfaced the first time the
thing was pointed at an address with nothing behind it.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 276
# suites 75
# pass 276
# fail 0
```

Also exercised end to end over HTTP against a JSON-RPC server serving the
in-memory contract: discovery, asset view, registration, a temporal query at a
chosen instant, history, settlement history and risk surfaces, plus the
unreachable-endpoint path.

---

## Both sequences

Closes the last specified-but-unbuilt gap. AGENTS.md's layer two and the
README describe recording *both* sequences; the wallet walked the projection
and reported ERC-721 ownership as a single current value.

`buildOwnershipHistory` reads the `Transfer` log for a token, dates each change
by its block, and interleaves it with the projection entries on one timeline.

### Decisions worth recording

**Sharing an axis is not sharing a meaning.** A position change is dated by the
block that recorded it — when *this chain* learned the token moved. An entry is
dated by `effectiveAt` — when *the register* says its change took effect, which
routinely precedes the block that admitted it. They are placed on one scale
because the ERC puts register instants on the `block.timestamp` scale so they
can be compared; the view says in as many words that this does not make them
the same kind of fact.

**The correspondence is the wallet's inference and is labelled as one.**
ERC-8415 defines no link between a transfer and the entry that records it. The
view pairs a position change with the earliest entry naming that party at or
after it, reports the interval, and states plainly that an entry naming the
same party may have an entirely different cause. A test asserts no entry
preceding a move is ever paired with it, and another asserts a party the
register confirms but who never held the position — Carol in the bundled
scenario — never has a transfer invented for her.

**`chainInstantAt` is an optional capability.** A reader without it, or without
logs, reports the position sequence as unavailable and still shows the
projection half, saying that this is half the record rather than returning an
empty position history.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 286
# suites 78
# pass 286
# fail 0
```

---

## The Kit adapter

Closes the last "specified but not implementable" entry in this document. The
Native Infrastructure Kit now has a projection API — roughly 2,800 lines,
`ProjectionClient` and an HTTP gateway over a projection store — so the second
adapter PRD §2 always named can be built against something real instead of
invented.

`KitErc8415Reader` (`src/adapters/kit`) implements `Erc8415Reader` by reading
the projection through that API and taking a chain reader for the rest.

### Decisions worth recording

**The Kit does not replace the node; it accelerates one half.** `ownerOf`,
`supportsInterface` and `block.timestamp` stay on chain, and `--kit` refuses
to run without `--rpc`. This is the load-bearing decision. An index that
served both the position and the confirmed holder from one store would be
asserting exactly the equivalence ERC-8415 exists to deny, and a wallet whose
whole thesis is that those are two sequences cannot take them from one. The
same reasoning rules out asking an indexer whether the contract it indexes is
conformant.

**A backend that cannot answer is not an answer.** The Kit reports an instant
the projection does not cover as a 404 with a code; that is the API's spelling
of the contract's revert, and it is carried across as `ContractRevertError`,
which is why `checkReaderConformance` passes against the Kit wire format
unchanged. Everything else — 401, 5xx, a timeout, a malformed body — raises
`KitTransportError`. This is the same lesson the live path taught earlier in
this document, where a swallowed transport error was reported as "the contract
does not advertise `0x6309e170`"; the shape that produced that defect is not
repeated here.

**Two backends are cross-checked, not trusted in turn.** `registerId` and
`verificationProfile` are specified immutable, so a Kit answering for another
register is detectable for the price of one chain call, taken once. On a
mismatch the adapter raises `BackendDisagreementError` rather than picking a
side: it has no basis for choosing, and a wallet that silently prefers one
backend over another has stopped being a faithful record.

**One derivation, declared and checked.** The Kit's API has no `currentEntry`
route. The adapter reads `entryAt(entryCount)` — leaning on the invariant that
versions run consecutively from 1 — and then refuses the result unless the
version matches the count and the interval is still open. A lagging index
yields a refusal, never a superseded entry labelled "current".

**Self-consistency is not agreement.** The wallet derives selectors by hashing
signature text it holds; recomputing them from that same text proves
arithmetic and nothing else. The Kit's Ethereum adapter arrives at the same
selectors from the compiled Solidity ABI. `tests/kitCrossCheck.test.ts`
compares the two tables and folds the Kit's literals into `0x6309e170`
independently of the wallet's keccak, so a signature drifting on either side
fails the build and names the call. The three settlement transactions and
`settlement(bytes32)` are listed as knowingly outside the Kit's surface, so
the gap in the comparison is stated rather than silent.

### Still open

- **No `TransactionSigner` implementation.** The wallet builds and preflights
  the three settlement operations and hands over an unsigned request; nothing
  in this repository can sign one. Reading a live deployment works end to end;
  acting on one still needs a signer the caller supplies.
- **The Kit's settlement history is not exposed.** Its store keeps every
  settlement for a token, open or closed (`settlementsFor`), but its API
  serves only the open gap, so closed gaps are read from the chain.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 318
# suites 86
# pass 318
# fail 0
```

---

## Escrow

The layer nothing implemented. The four-layer framework both repositories
carry — identity, faithful record, diagnosis, remedy — puts escrow in layer
four, and both said the same thing about it: the Kit's README, that remedy
"belongs to the transaction terms between the parties"; the semantic model,
that the escrow pattern is "a non-normative reference pattern". Neither built
it, and without it a holder can read their position perfectly and still not
trade on it.

`contracts/escrow/ProjectionEscrow.sol` holds both sides of a trade until the
register has confirmed the buyer, and returns them if it has not by an agreed
deadline. It reads the projection and never writes one: there is no path in it
that admits an entry, opens or cancels a gap, or overrides a register record.
Money is the only thing it has authority over.

### Decisions worth recording

**Release is gated on a provisional record, deliberately.** Waiting for
finality would deadlock. An instant is final exactly when
`firstEntry.effectiveAt <= t < latestEntry.effectiveAt`, so an instant becomes
final only once a *later* entry exists. The admitting entry's own effective
time is therefore never final at the moment it is admitted, and an escrow that
waited for it would be waiting on an unrelated future admission that may never
come. A test asserts exactly this: at the moment of release, `isFinalAsOf` is
false for the confirming entry's own instant, and release happens anyway. This
is the trap an escrow written from a skim of the standard falls into, and it
fails closed — the money never moves — so it would not show up as a bug until
a real trade hung.

**Refund is not keyed on cancellation.** The pattern as written in both
documents says "refund if the gap is cancelled without admission". That is too
narrow to be safe: a gap closes three ways — ADMITTED, CANCELLED, SUPERSEDED —
and it can also expire while still open, or never be opened at all. Keyed on
CANCELLED alone, an escrow hangs in every other case. The condition here is
the complement of release measured against a deadline, so all of them resolve.
Nothing is read as a rejection, because the protocol has none: a cancellation
ends a contest and settles nothing.

**A new entry is required, not merely a favourable one.** The escrow
snapshots `entryCount` when the trade is funded and requires the releasing
entry's version to exceed it. Without that, a buyer the register had already
confirmed before the trade could release it on a record that owes the trade
nothing. A test funds a trade after the buyer is already the confirmed holder
and shows release refused.

**An upper bound on `effectiveAt`, and deliberately no lower one.** An entry
admitted with an effective time far enough out would satisfy "the holder is the
buyer" while asserting a confirmation nobody traded for — and because effective
times strictly increase, it would end the projection for that token
permanently. The parties agree a bound. No lower bound is needed: invariant 3
already forbids an effective time at or below the previous entry's.

**Both reads happen inside the transaction that moves the value.** This is the
shape the standard recommends for composing on a projection. A read taken in an
earlier transaction — even one in the same block — can be overtaken by an
admission before the value moves.

**Release and refund are permissionless.** The conditions are objective and
readable by anyone, so neither party can hold the trade hostage by declining to
call.

**Not a projection is one answer, not three.** A contract that implements
ERC-165 and returns false, a contract with no `supportsInterface`, and an
address with no code all reach `NotAProjection` rather than a bare revert from
a call the caller never knew was made.

### Tested against the reference, not a mock

A mock of the projection would be written by the same hand as the escrow that
reads it, so the two could agree on a misreading of the standard and the suite
would pass. `test-evm/escrow.cjs` runs against
`contracts/reference/RegisterProjectionReference.sol` — the ERC repository's
own reference implementation, vendored here under CC0 — admitting entries
through its real settlement path with real validator signatures over the real
proof shape. `npm run test:evm` is part of `npm run verify` and of CI.

### Still open

- **ETH only, and no ERC-20 variant.** See below.
- **ETH only.** An ERC-20 denominated trade is the obvious next variant.

**One deployment, many venues, one namespace per opener.** A trade is stored
under `keyFor(opener, localId)` rather than under a caller-chosen identifier.
This is the single change that taking the shared-escrow picture seriously
forces: in a flat namespace two venues numbering their orders from one collide
by accident, and anyone who can guess the next identifier can take it first and
make the real party's `open` revert. Namespacing by the opener removes the
squat entirely and leaves accidental collision to a single party's own
numbering. The contract's `keyFor` and the SDK's `tradeKey` are cross-checked
against each other, because a venue that derived the key differently would
display one trade and settle another.

### The wallet side

`EscrowReader` is a separate port from `Erc8415Reader`, because the escrow is
an application on the projection and not part of the standard: nothing in the
projection knows it exists, and nothing it returns may be mistaken for a
protocol fact. `RpcEscrowReader` reads a deployment; `buildEscrowView` turns
one atomic `observe` into what a party needs to read.

The display rule that matters: a trade resting on a confirmation carries the
note that the confirmation is provisional — in the `confirmed` state and in the
`released` state alike, because releasing did not make it final. A test asserts
no view says the trade is final, settled or guaranteed, and another asserts a
passed deadline is never described as anyone having been refused.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 481
# pass 481
13 passing              (hardhat, against the reference implementation)
```

---

## The signer

The last hard gap. The wallet could build all three settlement transactions,
preflight them, and read an escrow, and could send none of it: `TransactionSigner`
was a type with no implementation.

`Eip1193Signer` (`src/adapters/signing`) is the shipped one, and it holds no key
material — a browser extension, a hardware wallet behind one, a custodian's
signing service all expose `request({ method, params })` and all keep the key on
their own side of it.

### Decisions worth recording

**Raw-key signing stays outside the shipped surface.** Doing it properly means
secp256k1 with deterministic nonces and low-s normalisation, which is not
something to hand-roll beside a wallet — and the moment this library accepted a
key, "it never holds key material" would stop being true. A script that needs
one brings its own signing library and satisfies the same `TransactionSigner`
type. A test asserts the signer never asks a provider for `eth_sign`,
`personal_sign` or `eth_signTransaction`, and that the only two methods it calls
are `eth_chainId` and `eth_sendTransaction`.

**Three refusals, ordered by how quietly each goes wrong.** The chain first: a
request carries the chain it was built for, and a user can switch networks
between building and sending. The same address is a different contract on a
different chain, so sending there is not a failed transaction — it is a
successful one against something else. Then the account, because a provider
handed a `from` it does not hold may substitute its own, and a settlement sent
from the wrong account is a different act by a different party. Then preflight,
which only catches a hand-assembled request, and costs nothing.

**Unverifiable is not a refusal.** Treating "could not establish" as "would
fail" would make every contract without a settlement interface unusable. The
wallet says what it could not check; the caller decides.

**Nothing is rewritten on the way out.** No gas estimate is added, no field is
filled. What the user was shown is what is sent.

### Still open

- **No testnet run yet.** The signer makes one possible; a Sepolia script that
  deploys a projection and an escrow and drives a trade end to end is the next
  step, and it is where a raw-key signer will live.
- **ETH only** in the escrow, and no lending or custody primitive. Those are
  different shapes from a sale, not parameters of it.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 492
# pass 492
14 passing              (hardhat, against the reference implementation)
```

---

## The first real network

Sepolia, 2026-09-19. The ERC-8415 reference implementation at
`0xaeeb157f40ffdad51693275258a465763be66cd8` and `ProjectionEscrow` at
`0x50299e4d454fc9ec788f735e004d1ec537767934`, chain 11155111, fourteen
transactions, both clearing paths driven end to end. Test-only, no real value.

Everything before this was an in-memory contract model, a fake JSON-RPC node,
or a local EVM. Three predictions were written down in
`docs/ONCHAIN-TEST-PROMPT.md` before the run so they could be confirmed or
refuted rather than rationalised afterwards. All three resolved, and two
defects came out of it.

### The prediction that mattered

Release is gated on an admitted but *provisional* record. The claim was that
`isFinalAsOf` must return false for the admitting entry's own effective time,
because an instant becomes final only once a later entry exists — and that an
escrow waiting for finality would therefore wait on an unrelated future
admission that may never come.

Read from the live deployment:

```
token 841501, admitted entry v2, effectiveAt 1789840680
  isFinalAsOf(1789840680)  false     <- the admitting instant, not final
  isFinalAsOf(1789833540)  true      <- v1's instant, closed by v2
  holderAsOf(1789833540)   0x75f6…3089   (the seller)
  ownerOf(841501)          0xde3c…ec2b   (the buyer)
```

Release happened while that was false and it is false still. The last two
lines are the product's whole thesis on a real chain: one token, whose
position is now the buyer and whose confirmed holder at an earlier instant is
still the seller, with the divergence resolvable by asking about a time.

The struct return layout decoded correctly field by field, `entryAsOf` and
`holderAsOf` raised `ContractRevertError` for an instant before the first
entry against a node using seventeen custom errors and no revert strings,
`isFinalAsOf` answered false there without reverting, both frozen interface
identifiers were advertised, and the SDK's `tradeKey` reproduced the on-chain
key for both trades.

### Two defects, one of them worse than predicted

**An unbounded log range is refused.** Predicted. `fromBlock: 'earliest'` came
back `exceed maximum block range: 50000` from a public endpoint.

**The refusal arrived as a revert.** Not predicted, and the more serious of
the two. `HttpCallTransport` turned every JSON-RPC error into
`ContractRevertError`, so a provider's range policy was reported as
`call reverted` — a transport condition stated as a fact about the contract.
That is the same failure this project already fixed once, when an unreachable
endpoint was reported as "the contract does not advertise `0x6309e170`". The
shape came back through a different door.

### Decisions worth recording

**A revert is something a contract does, and only `eth_call` executes contract
code.** Every other method now raises `TransportError`. `eth_call` itself
raises a revert only when the error looks like one — code 3, or error data
present, or the message says so — and a transport failure otherwise. The
asymmetry is deliberate: a revert misread as a transport fault fails loudly,
while a transport fault misread as a revert is silently absorbed by every
caller that treats a revert as an answer.

**A short history is indistinguishable from a quiet one.** The scan is walked
in windows rather than asked for at once, and a window the node refuses raises
instead of returning what was gathered so far. Nothing returns a recent slice
and calls it the history.

**The deployment block is found, not guessed — and when it cannot be found,
that is said.** Bisecting `eth_getCode` locates it in about two dozen requests
on an archive node. Public endpoints prune state: Sepolia's PublicNode answers
`state at block #5869973 is pruned` partway through. There the reader refuses
and names the remedy — supply `--from-block` — because every alternative is
either a scan of eleven million blocks or a history quietly cut off at the
wrong end.

This design was written before the run and broken by it within one command.
The bisection looked general and is not; only the real node showed that.

### Verified against the live deployment after the fix

```
logs over the contract's whole life   13 in 0.4s, blocks 11739199-11739229
decoded                                2 RegisterInitialized, 1 RegisterSuperseded,
                                       1 SettlementStarted, 1 SettlementFinalized,
                                       6 Transfer
settlement history                     present, not silently empty
no fromBlock on a pruning node         TransportError naming the remedy
an instant before the first entry      ContractRevertError, still
```

### C3 and E2, run afterwards — and a third defect

**C3, an endpoint that is not the contract.** Three variants against the live
deployment, through the client itself:

| pointed at | says |
|---|---|
| a port with nothing listening | `Could not reach the JSON-RPC endpoint: eth_call: did not complete` |
| a live host that is not a node | `eth_call: HTTP 404` |
| a real node, an address with no contract | `no contract at 0x75f6…3089: supportsInterface(bytes4) returned no data` |

The first two are what the fix above was for. The third was not: it used to
say `return payload for 1 word(s) (got 0 bytes) out of range: 0`.

**`eth_call` against an address with no code neither reverts nor fails.** It
succeeds, and returns nothing. Left to the ABI decoder that became a complaint
about a truncated payload — a message that reads like a fault in the wallet
rather than a mistyped address or the wrong chain. It is now named, and named
separately from non-conformance on purpose: "this address does not advertise
`0x6309e170`" sends someone hunting for a conformance problem in a contract
that is not there at all.

Three defects, then, and all three were the same shape: a condition reported
as the wrong kind of thing. A provider's range policy as a revert, a pruned
node as nothing in particular, an empty address as a decoder fault.

**E2, the signer's chain check**, against a real Sepolia provider with a
request the wallet actually built — `isSettlementAuthority` true, no open gap,
164 bytes of calldata, preflight clean:

```
chainId rewritten to 1   ChainMismatchError
methods asked            eth_chainId
anything broadcast?      no
a sender it does not hold  AccountMismatchError, nothing broadcast
```

It refused on the chain identifier alone, before asking the provider for
anything else.

### Still open

- **Release was called by the seller**, not a third party, so the
  permissionless property has not been exercised on chain.
- The register's validators were the two trading parties, so the separation
  between registrar and counterparty was not tested. The run's own report says
  so.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 506
# pass 506
14 passing              (hardhat, against the reference implementation)
```

---

## A register with its own clock

Everything in this repository modelled the projection once it existed. Nothing
modelled the institution that produces it — and the first Sepolia run did not
either: its validators were the buyer and the seller, and the admission
followed the trade by about a minute because someone ran the next command. That
demonstrates a projection being written. It does not demonstrate a projection
lagging behind a market, which is the entire reason the standard exists.

`AsynchronousRegistrar` (`src/adapters/memory/registrar.ts`) is that register.
Transfers every 30 seconds against a register that takes 180 seconds a hop.

### Decisions worth recording

**Serial, not pipelined.** The first draft computed a record's due time as
`effectiveAt + latency`, which models a register that works on every change at
once. A real one has a queue and a clerk: each hop starts when its predecessor
finishes. The difference is not cosmetic — it is the difference between a lag
that stays at three minutes and one that **grows with every trade**:

```
t=0     A -> B      recorded at t=180
t=30    B -> C      recorded at t=360
t=60    C -> D      recorded at t=540
```

Sixty seconds in, the token is three owners ahead of its own record and still
falling behind. That is why a consumer has to ask about an *instant* rather
than about *now*, and a fixture that kept a constant lag would have hidden the
reason.

**Backdated on purpose.** An entry admitted at 12:03 for a transfer at 12:00
carries `effectiveAt` of 12:00. This is what makes a past instant resolvable at
all: the record says when the change took effect, not when the registrar got
round to it.

**So finality arrives in arrears.** Each hop settles the one before it. After
the first record the trade instant is still provisional, because nothing later
exists; after the second it is final, and resolves to the holder the first hop
named. The newest instant is never final. A test asserts both halves.

**It records; it does not decide.** There is no method here that approves,
rejects, or refuses a change, because the register has none either.

### A test assertion that was wrong in an instructive way

The first version asserted the registration view contains no `/fail|blocked/i`.
It failed — against copy that reads "This is not a failure" and "Your token is
not blocked and never will be by this". Banning the word flags the sentence
written to rule the thing out. The assertions now check for the denial.

This project made the same mistake once before, on the same kind of copy.

### Still open — handed to Codex

`docs/issues/001-asynchronous-registrar-on-chain.md`. The simulator is
in-process; the same shape on a real chain with real elapsed time needs a
signing key, which this session does not have. The issue covers a registrar
that is **not** a counterparty, three hops 30 seconds apart, sampling the
divergence while it is open, finality arriving in arrears, a clearing trade
whose deadline the backlog misses, and release called by a fourth party.

### Verification

```
$ npm run verify
tsc --noEmit            (clean)
# tests 513
# pass 513
14 passing              (hardhat, against the reference implementation)
```
