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
- **The ERC-721 ownership sequence as a sequence.** The transfer log is now
  read, but only to discover tokens; no view walks it as history alongside the
  projection entries.
- **Batching.** `buildHistoryView`, `detectCollisions` and discovery all walk
  one call at a time.

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
