# 8415Wallet

A reference wallet and client for [ERC-8415 — Asynchronous Register
Projection for NFTs](https://github.com/GiraffeTechnology/ERC-8415).

ERC-8415 projects an off-chain register onto an ERC-721 token so that any past
instant resolves to exactly one confirmed holder, while the chain is still
behind the register. 8415Wallet is the client that shows a user what that
projection actually says.

## Why a separate wallet

An ordinary wallet answers one question: *who owns this token now?* For a
token that stands for a record kept somewhere else, that answer is not the
record. ERC-8415 keeps two sequences apart on purpose:

- **the tradeable position** — `ownerOf`, which moves the moment the market
  moves;
- **the confirmed holder** — the register's own record, which moves only when
  a proof admits an entry.

At rest they agree. In flight they diverge, and nothing in a conventional
wallet tells a user which one they are looking at. 8415Wallet shows both, and
shows whether they agree at whichever instant is being asked about.

## What it shows

For any token and any instant:

| Question | Source |
| --- | --- |
| Who holds the tradeable position? | `ownerOf` |
| Who did the register confirm at instant *t*? | `holderAsOf(tokenId, t)` |
| Can a later admission still change that? | `isFinalAsOf(tokenId, t)` |
| Which entry admitted it? | `entryAsOf(tokenId, t)` |
| Is a change in flight covering *t*? | `openGapOf` + the gap's `openedAt` |
| What is this a projection of? | `registerId`, `verificationProfile` |
| Who may move the answer? | `isSettlementAuthority` |

Three signals, never merged into one badge:

- **final / provisional** — whether a later admission can still change this
  instant's holder;
- **contested / not contested** — whether a gap is open that opened at or
  before this instant;
- **fresh / stale / reorg-safe** — the optional watchtower freshness layer,
  which measures on-chain reorg exposure, *not* registrar finality.

Finality does not depend on whether a gap is open, and closing a gap does not
make any instant final.

## What it does not do

ERC-8415 is a faithful record and audit trail across an asynchronous
boundary — a mirror, not a tribunal. The wallet sits on the same side of that
line:

- it does not adjudicate legal title, entitlement or compliance;
- it does not decide remedy — cancellation, escrow, timeouts, refunds and
  unwinding belong to the parties' own terms;
- it does not score risk or produce a safe/unsafe verdict;
- it does not redefine, extend or recompute protocol semantics;
- it has no rollback, veto or override path into the projection.

It reports. The user decides.

## Architecture

```
User
 |
8415Wallet UI
 |
ERC-8415 SDK port
 |
Native Infrastructure Kit  /  direct chain reads
 |
ERC-8415 conforming ERC-721 contract
```

The SDK port is the wallet's only window onto the projection: a typed
interface mirroring `IRegisterProjection` (ERC-165 `0x6309e170`) and
`IProjectionSettlement` (`0xf4a7d71b`). Conformance is discovered, not
assumed; a contract may implement the projection without the settlement
interface, in which case it has no gaps and no contested instants.

## Status

Stages 0 through 2 delivered: the project foundation; the SDK port with its
contract binding — typed mirrors of both interfaces, ERC-165 conformance
discovery, identity pinning, an `eth_call` adapter, and an in-memory contract
model that enforces the four projection invariants and the ERC's finality
rule; and the asset view, which puts the tradeable position and the confirmed
holder side by side with the gap, the authority and the contract's identity.
113 tests, no runtime dependencies.

`npm run wallet` renders the asset view for the bundled scenarios. Querying an
arbitrary instant is Stage 3. The stage roadmap is in
[docs/ERC-8415-Wallet-PRD.md](docs/ERC-8415-Wallet-PRD.md) §7 and delivery
evidence per stage is in
[docs/STAGE-DELIVERY.md](docs/STAGE-DELIVERY.md).

## Documents

- [AGENTS.md](AGENTS.md) — engineering rules, semantic boundaries, and the
  forbidden inferences every change is checked against;
- [docs/ERC-8415-Wallet-PRD.md](docs/ERC-8415-Wallet-PRD.md) — product
  requirements, data model, feature specification and stage plan;
- [docs/STAGE-DELIVERY.md](docs/STAGE-DELIVERY.md) — per-stage delivery
  evidence, coverage against the ERC's own test cases, and what is
  deliberately not covered.

The ERC itself is the source of truth above all three. Where this repository and
the ERC disagree, the ERC wins and this repository gets fixed.

## Development

Node 22.6 or newer. TypeScript runs from source through Node's native type
stripping, so there is no build step.

```sh
npm install
npm run verify   # typecheck + tests
npm run wallet   # render the asset view for the bundled scenarios
```
