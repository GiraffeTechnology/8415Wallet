# ERC-8415 Wallet AGENTS.md

## Product Boundary

8415Wallet is an application-layer wallet and reference client for ERC-8415
asynchronous register projection.

It is NOT:

- a generic NFT wallet;
- an ERC-3643 wallet clone;
- a token trading application;
- a replacement for ERC-8415 protocol semantics;
- an adjudicator of legal title, entitlement or remedy.

The wallet MUST consume ERC-8415 semantics, not redefine them.

---

## Source of Truth

The implementing agent MUST read, in this order:

1. AGENTS.md
2. docs/ERC-8415-Wallet-PRD.md
3. The ERC-8415 specification itself:
   `ERCS/erc-8415-asynchronous-register-projection.md` in
   GiraffeTechnology/ERC-8415, together with
   `interfaces/IRegisterProjection.sol` and
   `interfaces/IProjectionSettlement.sol`.

Where this repository and the ERC disagree, the ERC wins, and the
disagreement MUST be fixed here rather than worked around in code.

The frozen interface identifiers are `0x6309e170` for `IRegisterProjection`
and `0xf4a7d71b` for `IProjectionSettlement`. Neither is the wallet's to
change or to recompute.

---

## Layer Placement

ERC-8415 is a faithful record and audit trail across an asynchronous
boundary: a mirror, not a tribunal. Four layers:

1. identity — the premise that a final on-chain owner and the
   register-confirmed holder refer to the same underlying right;
   the protocol does not enforce it;
2. faithful record — append-only entries and the ERC-721 ownership
   sequence they sit alongside;
3. diagnosis — `holderAsOf`, `isFinalAsOf`, `openGapOf`, and whether the two
   sequences align at an instant;
4. remedy — cancellation, escrow, timeouts, refunds, unwinding.

The wallet **presents** layers two and three to a user, and **supports but
never imposes** layer four. It states what is recorded and what is still
open; the parties' own terms decide what to do about it.

---

## Core Semantic Rules

The wallet MUST read, and MUST render distinctly:

- `holderAsOf(tokenId, instant)` — the confirmed holder at an instant;
- `entryAsOf(tokenId, instant)` — the entry whose effective interval covers it;
- `isFinalAsOf(tokenId, instant)` — whether a later admission can still change
  that answer;
- `currentEntry`, `entryAt`, `entryCount` — the append-only entry walk;
- `openGapOf(tokenId)` and the gap's `openedAt` — whether a change is in
  flight, and from which instant it makes the token contested;
- `ownerOf(tokenId)` — the tradeable position, shown as a separate fact;
- `registerId` and `verificationProfile` — what this is a projection of, and
  under which proof rules;
- `isSettlementAuthority(tokenId, account)` — who may move the answer.

Instants are `uint64` seconds since the Unix epoch, on the same scale as
`block.timestamp`. Formatted time is a display concern only; every query
carries the integer.

### The finality rule

An instant is final if and only if it is at or after the first entry's
`effectiveAt` and strictly before the latest entry's `effectiveAt`.

The wallet MUST take this from `isFinalAsOf` and MUST NOT recompute it,
approximate it, or cache it across a block in which an entry was admitted.

### Three orthogonal signals

Never collapse these into one badge:

- **final / provisional** — can a later admission still change this instant's
  holder;
- **contested / not contested** — is a gap open whose `openedAt` is at or
  before this instant;
- **reorg-safe / fresh / stale** — the optional watchtower freshness layer,
  which measures on-chain reorg exposure of a head, not registrar finality.

Finality does not depend on whether a gap is open. Freshness is not finality.

---

## Forbidden Inferences

The wallet MUST NOT treat any of the following as finality:

- `ownerOf` being equal to the confirmed holder;
- confirmation depth, block age, or a `FRESH_FINAL` / `REORG_SAFE` freshness
  classification;
- a proof having verified;
- a gap having closed, by admission or by cancellation;
- a settlement having been cancelled.

The wallet MUST NOT:

- infer the confirmed holder from `ownerOf`, ever, including as a fallback
  when a projection read fails;
- present a provisional answer as settled — the ERC names this the most
  likely integration error, because `entryAsOf` answers either way;
- invent a rejection event. The protocol has open/closed gaps, provisional
  and final instants, and admitted entries. Cancellation ends a contest and
  settles nothing; the projection is unchanged and the prior entry stays in
  force;
- display the register's contents. The chain carries a `recordCommitment` and
  a `registryReference` locator, never the record. Resolving a reference
  requires entitlement to read the register;
- claim projection data for a contract that does not advertise the matching
  ERC-165 identifier.

---

## Vocabulary Discipline

Use only protocol-defined terms in UI copy, code identifiers and docs:

- open gap / closed gap;
- provisional / final;
- admitted;
- confirmed holder;
- tradeable position (`ownerOf`).

Do not use Pending / Confirmed / Rejected as state names. They are not
protocol states and read as a rejection event the ERC does not define.

---

## Application Boundary

Architecture:

```
User
 |
Wallet UI
 |
ERC-8415 SDK port
 |
Native Infrastructure Kit  /  direct chain reads
 |
ERC-8415 conforming ERC-721 contract
```

The wallet depends on the SDK port, never on a transport, and never on a
second source of truth alongside it.

Do not create protocol changes inside the wallet project.

Do not introduce rollback, veto or override semantics. The wallet has no
write path into the projection: it does not admit entries, and it exposes
`beginSettlement`, `finalizeSettlement` and `cancelSettlement` only as
operations the user's own key performs against the contract, with the
authority check shown beforehand.

---

## Degradation Rules

Conformance is discovered, not assumed:

- projection conformance without settlement conformance means the token has
  no gaps and no contested instants — show that as a property of the
  contract, not as "no gap open";
- `entryAsOf` and `holderAsOf` revert for an instant preceding the first
  entry. That is "the projection does not cover this instant", not an error;
  `isFinalAsOf` returns false there and does not revert;
- when a read fails, show the failure. Never substitute a neighbouring
  instant's answer, a cached answer, or `ownerOf`.

---

## Development Rules

Every stage requires:

- implementation;
- tests;
- documentation;
- delivery evidence.

Tests MUST cover the forbidden inferences above as explicit negative cases,
including: a token whose `ownerOf` and confirmed holder diverge; a closed gap
over a non-final instant; a cancelled settlement; and an instant before the
first entry.

---

## Completion Requirement

The wallet is complete only when a user can see, for any token and any
instant, and without conflating them:

- the tradeable position and the confirmed holder, side by side;
- whether the answer at that instant is final or provisional, and why;
- whether that instant is contested by an open gap;
- which entry admitted the answer, with its commitment, version and
  registry reference;
- what register this projects, under which verification profile, and who may
  move the answer.
