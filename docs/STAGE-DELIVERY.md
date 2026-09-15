# 8415Wallet — Stage Delivery

Delivery evidence per AGENTS.md: every stage requires implementation, tests,
documentation and evidence. Stages are defined in
[ERC-8415-Wallet-PRD.md](ERC-8415-Wallet-PRD.md) §7.

| Stage | Scope | State |
| --- | --- | --- |
| 0 | Project foundation | Delivered |
| 1 | SDK port and contract binding | Delivered |
| 2 | Asset view | Not started |
| 3 | Temporal query and history | Not started |
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
