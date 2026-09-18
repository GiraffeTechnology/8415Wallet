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
| When did each sequence move, side by side? | `Transfer` logs + the entry walk |

It also answers the questions a holder actually asks — what a pending
registration means for them, that it is not a failure, that waiting is the
action, how many transfers are still queued behind the one being registered,
and where the remedy lies if the commitment window passes. It never blocks the
token.

Three signals, never merged into one badge:

- **final / provisional** — whether a later admission can still change this
  instant's holder;
- **contested / not contested** — whether a gap is open that opened at or
  before this instant;
- **fresh / stale / reorg-safe** — the optional watchtower freshness layer,
  which measures on-chain reorg exposure, *not* registrar finality.

Finality does not depend on whether a gap is open, and closing a gap does not
make any instant final. A stale feed is reported as stale whatever the
projection says — conflating stale with pending is what makes a silently dead
register look like ordinary delay.

## What it does not do

ERC-8415 is a faithful record and audit trail across an asynchronous
boundary — a mirror, not a tribunal. The wallet sits on the same side of that
line:

- it does not adjudicate legal title, entitlement or compliance;
- it does not decide remedy — cancellation, escrow, timeouts, refunds and
  unwinding belong to the parties' own terms;
- it does not score risk or produce a safe/unsafe verdict;
- it does not redefine, extend or recompute protocol semantics;
- it does not present agreement between `ownerOf` and the confirmed holder as
  verified identity of the underlying right — the protocol does not, and
  cannot, verify that;
- it has no rollback, veto or override path into the projection — the only
  operations it can build are the three the ERC defines, and it signs none of
  them.

It reports. The user decides.

## Architecture

```
User
 |
8415Wallet UI
 |
ERC-8415 SDK port  (Erc8415Reader)
 |                        \
 |                         Native Infrastructure Kit — projection reads
 |
 direct chain reads — conformance, ownerOf, the clock, settlement, logs
 |
ERC-8415 conforming ERC-721 contract
```

The SDK port is the wallet's only window onto the projection: a typed
interface mirroring `IRegisterProjection` (ERC-165 `0x6309e170`) and
`IProjectionSettlement` (`0xf4a7d71b`). Conformance is discovered, not
assumed; a contract may implement the projection without the settlement
interface, in which case it has no gaps and no contested instants.

Two adapters satisfy that port and both are held to the same conformance
harness. **rpc** reads the contract directly and is complete on its own.
**kit** reads the projection through a Native Infrastructure Kit deployment —
the entry walk, temporal resolution, finality and the open gap in one round
trip apiece — and composes with an rpc reader for the rest, because the
tradeable position, ERC-165 conformance and `block.timestamp` are facts about
the chain and not about the register. `--kit` therefore requires `--rpc`.

The two are cross-checked rather than trusted in turn. `registerId` and
`verificationProfile` are specified immutable, so a Kit answering for a
different register is caught on the first read; and the Kit's own selector
table, derived independently from the compiled Solidity ABI, is compared
against the selectors this wallet derives by hashing, so a drifted signature
on either side fails the build.

## 8415 Clearing

The escrow layer has a name of its own because it is a separate product from
the wallet, and one escrow deployment is meant to serve many venues — a wallet,
a marketplace, an OTC desk, a lending protocol, an exchange, a custodian — all
opening trades against it.

*Clearing*, not *settlement*. In this repository "settlement" already means one
thing, in seven hundred places: admitting an entry into the register, through
`beginSettlement` / `finalizeSettlement` / `cancelSettlement`, closing a gap as
ADMITTED, CANCELLED or SUPERSEDED. That is the protocol's word and it is not
available. Clearing is the stage between a trade and its settlement, which is
exactly the position this contract occupies: it holds both legs while the
register catches up.

`contracts/escrow/ProjectionEscrow.sol` is the contract; `EscrowReader` and
`buildEscrowView` are how a venue reads it. Trades are keyed by
`keyFor(opener, localId)`, so every venue has its own identifier namespace and
no one can take another's.

## Status

All six stages delivered. The wallet reads a projection through one port and
presents it without collapsing any of its signals: the asset view, the
temporal query, the append-only entry walk, the gap history with the three
closures distinguished, the risk surfaces, and the watchtower freshness layer
kept apart from finality. 492 tests and a contract suite on a real EVM, no runtime dependencies.

The wallet also acts, within the bounds the ERC sets: it builds the three
settlement operations with a preflight that refuses what would revert and
names what it cannot check, and hands the unsigned request to a signer the
caller supplies. It never holds key material. `WalletSession` is the surface
an application integrates against, and an audit trail exports entries and gap
transitions in a form a third party can re-check against the chain.

`npm run wallet` renders all of it for the bundled scenarios, and
`--kit <url>` alongside `--rpc` moves the projection reads onto a Kit
deployment. Binding a different backend is described in
[docs/INTEGRATION.md](docs/INTEGRATION.md). The stage roadmap is in
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
  deliberately not covered;
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — binding a backend to the SDK
  port, and the conformance harness every adapter must pass.

The ERC itself is the source of truth above all three. Where this repository and
the ERC disagree, the ERC wins and this repository gets fixed.

## Development

Node 22.18 or newer — that is where Node runs TypeScript from source without
a flag, which is what lets this project ship with no build step.

```sh
npm install
npm run verify   # typecheck + tests
npm run wallet   # render the views for the bundled scenarios
```

To read a live deployment:

```sh
npm run wallet -- --rpc <url> --contract <address> --account <address>
npm run wallet -- --rpc <url> --contract <address> --token <id>
npm run wallet -- --help
```

With `--account` and no `--token`, the client discovers which tokens the
account holds by scanning `Transfer` logs and confirming each against
`ownerOf` — ERC-721 enumeration is optional and most deployments omit it.

CI runs the same steps on Node 22 and 24, plus the reference client as a smoke
test, on every push to `main` and every pull request.
