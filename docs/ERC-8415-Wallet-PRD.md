# ERC-8415 Wallet PRD v2.0

Supersedes v1.0. See **Appendix A — changes from v1.0** for what was corrected
and why.

## Product Definition

8415Wallet is a reference wallet for ERC-8415 ecosystem applications.

Positioning:

> A temporal asset wallet that exposes ERC-8415 projection, gap and finality
> semantics to users without collapsing them.

The wallet is not an ownership viewer. ERC-8415 tracks two sequences that
describe the same asset — the ERC-721 ownership sequence and the
register-confirmed holder sequence. At rest they agree; in flight they
diverge. The wallet's job is to show both faithfully, show whether they align
at a given instant, and stop there.

---

# 1. Design Principle

A traditional wallet answers:

```
Who owns this token now?
```

8415Wallet answers, separately and without merging the answers:

```
Who holds the tradeable position now?          -> ownerOf

Who did the register confirm as holder at t?   -> holderAsOf(tokenId, t)

Can a later admission still change that?       -> isFinalAsOf(tokenId, t)

Is a change in flight covering t?              -> openGapOf + openedAt

Which entry admitted that answer?              -> entryAsOf(tokenId, t)

What is this a projection of, under which
proof rules, and who may move it?              -> registerId,
                                                  verificationProfile,
                                                  isSettlementAuthority
```

The last question matters because the parties who need this are third parties
with no relationship to the registrar. A projection a user cannot attribute to
a register, under a profile they cannot name, tells them very little.

---

# 2. Core Architecture

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

The SDK port is the wallet's only window onto the projection. It is a typed
interface mirroring `IRegisterProjection` and `IProjectionSettlement`, with
two adapters:

- **kit** — the ERC-8415 Native Infrastructure Kit, once its Register API
  exists. The Kit is at Stage 0 (documents only) as of this revision, so this
  adapter is specified but not yet implementable;
- **rpc** — `eth_call` against the conforming contract, used by the reference
  client today.

Both adapters return the same types. Nothing above the port knows which is in
use, and neither adapter is permitted to compute an answer the contract can be
asked for.

The wallet MUST NOT redefine ERC-8415 semantics.

---

# 3. Data Model

The wallet's types mirror the ERC. It adds display state, never protocol
state.

## 3.1 Instants

`uint64`, seconds since the Unix epoch, on the same scale as
`block.timestamp`. Register instants and chain instants are comparable, and
the definition of a contested instant depends on that.

Every query carries the integer. Formatted UTC is display only, and any
formatted instant shown in the UI must be resolvable back to the integer that
was queried.

## 3.2 Register entry

As returned by `entryAsOf`, `entryAt` and `currentEntry`:

- `recordCommitment` — nonzero `bytes32` commitment to the register's content
  at that entry, unique within the token;
- `previousCommitment` — link to the prior entry; zero for the first;
- `registryReference` — `bytes32` locator for the register's own record. The
  wallet never interprets it. Whether zero means "no locator published" is
  profile-defined;
- `holder` — the confirmed holder, an `address`;
- `version` — `uint64`, consecutive from 1;
- `effectiveAt` — when the entry takes effect, strictly increasing per token;
- `supersededAt` — when the register closed this entry's interval; zero for
  the latest entry.

The chain carries the commitment and the reference, never the record. The
wallet has no access to the register's contents and MUST NOT present anything
as such.

## 3.3 Settlement / gap

As returned by `openGapOf` and `settlement`:

- `settlementId`, `tokenId`, `initiator`, `expectedHolder`, `snapshotHash`;
- `openedAt` — the block timestamp at which `beginSettlement` succeeded; it
  bounds the interval the gap makes contested;
- `deadline` — bounded by `settlementPeriod`;
- `status` — `OPEN`, `ADMITTED`, `CANCELLED` or `SUPERSEDED`. `NONE` is an
  internal zero value and is never returned by a successful query.

`openGapOf` returns zero when no gap is open.

## 3.4 Contract identity

`registerId`, `verificationProfile`, `settlementPeriod`, and the ERC-165
answers for `0x6309e170` and `0xf4a7d71b`.

---

# 4. Core Features

## 4.1 Asset View

For a token, display as separate, adjacent facts:

- **Tradeable position** — `ownerOf`, labelled as the ERC-721 position;
- **Confirmed holder** — `currentEntry().holder`, with version and
  `effectiveAt`;
- **Alignment** — whether the two addresses currently agree. Divergence is
  reported, not flagged as an error: the token trades while the register
  catches up, and that is the design;
- **Open gap** — settlement id, `openedAt`, `deadline`, `expectedHolder`, and
  time remaining against `settlementPeriod`;
- **Register identity** — `registerId` and `verificationProfile`, with a
  standing note that accepting them is the user's decision;
- **Settlement authority** — whether the user's own account may open a gap on
  this token, from `isSettlementAuthority`.

The current instant is at or after the latest entry's `effectiveAt` and is
therefore never final. The asset view says so plainly rather than leaving the
absence of a "final" badge to be read as an error.

## 4.2 Temporal Query

Input: a token and an instant. Output, in one panel:

```
Token          0x4f2a…:1234        register 0x9c11…  profile 0x0d7e…
As of          2026-01-01 00:00:00 UTC  (1767225600)

Confirmed      0xA11CE…  (Alice)
   admitted by entry v3, effective 2025-12-04 09:12:00 UTC  (1764839520)
   commitment 0x7f3c…  previous 0x41ab…  reference 0x00b2…

Finality       Provisional
   Entry v3 is the latest admitted entry, effective 2025-12-04 09:12:00 UTC.
   The instant asked about is at or after that, so a later admission may
   still carry an earlier effective time and supersede this answer.
   It becomes final once an entry with a later effective time is admitted —
   including a confirming entry naming Alice again.

Contested      Yes
   A gap opened 2025-12-20 11:02:00 UTC  (1766228520), at or before this
   instant. Deadline 2026-01-19 11:02:00 UTC. Expected holder 0xD00D….
   This is separate from finality: closing the gap settles nothing by itself.

Tradeable      0xD00D…  — the ERC-721 position, not the confirmed holder.
```

Worked example of the finality rule, for the same token: had the instant been
2025-11-30, before entry v3 took effect but at or after entry v1's, it would
read **Final** — an instant strictly before the latest entry's `effectiveAt`
can no longer change. Had it been 2025-06-01, before the first entry,
`holderAsOf` and `entryAsOf` would revert and `isFinalAsOf` would return
false without reverting.

Rules:

- `holderAsOf` and `entryAsOf` revert for an instant preceding the first
  entry. Render that as *the projection does not cover this instant*;
- `isFinalAsOf` does not revert there and returns false. Show false;
- never substitute a neighbouring instant, a cached answer, or `ownerOf` when
  a read fails. Show the failure.

## 4.3 Finality Display

Taken from `isFinalAsOf` alone. Two states, plus an explicit unavailable
state when the call could not be made:

- **Final** — no entry admitted in the future can change the holder at this
  instant;
- **Provisional** — a later admission may still supersede this answer;
- **Unavailable** — the wallet could not obtain an answer. It does not guess,
  and does not fall back to either state.

The display MUST explain *why*, in protocol terms: an instant is provisional
because it is at or after the latest entry's `effectiveAt`, and it becomes
final when an entry with a later effective time is admitted — including a
confirming entry naming the same holder.

Finality is not legal finality. It is the statement that this projection's
answer for this instant can no longer change.

## 4.4 Projection History

The append-only entry walk, newest first, via `entryCount` and `entryAt`:

- version, `effectiveAt`, `supersededAt` and the resulting effective interval;
- `holder`;
- `recordCommitment` and `previousCommitment`, with the link to the prior
  entry shown as a chain;
- `registryReference`, presented as a locator the user resolves themselves if
  they are entitled to read the register.

Alongside it, the settlement log from `SettlementStarted`,
`SettlementFinalized`, `SettlementCancelled` and `SettlementSuperseded`, so a
user can see gaps that closed without admitting anything.

Entries are never reordered, filtered or merged for display.

## 4.5 Gap Awareness

Display:

- whether a gap is open, and the interval it makes contested — from
  `openedAt` forward;
- the deadline, and that cancellation is possible only after it passes;
- what each closure means:
  - **admitted** — an entry was appended; instants before its `effectiveAt`
    are now final;
  - **cancelled** — the contest ends and nothing settles. The preceding entry
    stays in force and no instant became final;
  - **superseded** — a new settlement replaced this one, the projection is
    unchanged, and any proof already produced for the superseded settlement
    is now unusable.

A contract with no settlement interface has no gaps and no contested
instants. Show that as a property of the contract.

## 4.6 Risk Surfaces

The wallet reports these because the ERC's security section makes them the
consumer's decision, and a wallet that hides them decides on the user's
behalf:

- **stalled register** — recent instants stay non-final for as long as no
  entry is admitted. Show how long the latest entry has stood;
- **held-open gap** — whoever may begin settlements can supersede
  indefinitely, leaving recent instants non-final and contested. Show
  supersession count on the token;
- **authority scope** — `isSettlementAuthority` says who may move the answer.
  Reading it is not approving it;
- **profile acceptance** — `verificationProfile` names the rules under which
  proofs are accepted. The user decides whether they accept them;
- **far-future effective time** — an admitted `effectiveAt` far ahead of now
  permanently ends the projection for that token. Surface it if present.

These are reported as facts. The wallet does not score them, does not produce
a safe/unsafe verdict, and does not gate any action on them.

---

# 5. Application Patterns

## Trading

The wallet supports applications that compose immediately on a provisional
answer, and applications that quarantine until an instant is final. It shows
which case a given instant is in. It does not impose a settlement policy, and
it does not tell a user whether a trade is safe.

## Custody

Institutional use: monitoring the two sequences, reviewing commitments and
references, and exporting an audit trail of entries and gap transitions that
can be re-checked against the chain later.

## Rights and record instants

A right determined by registration time resolves against the projection at
the record instant its own terms specify, never against `ownerOf`. The wallet
answers that query and reports finality and contest alongside it. What the
right does with the answer is the right's own terms, and the wallet does not
encode them.

An entry admitted after an exercise has completed carries no authority over
that exercise. The wallet's history view must not present a later entry as
undoing an earlier act.

---

# 6. Security Requirements

The wallet MUST:

- protect user keys; no key material leaves the device, and the wallet holds
  no write path into the projection beyond transactions the user signs;
- verify ERC-165 support before reading a projection, and refuse to present
  projection data for a contract that does not advertise `0x6309e170`.
  Settlement data requires `0xf4a7d71b`, discovered separately;
- pin `registerId` and `verificationProfile` on first use and warn loudly if
  a subsequent read differs — both are specified as immutable, so a change
  means the wallet is not talking to the contract it thinks it is;
- validate the source of every displayed value, and label which contract and
  chain it came from;
- never fabricate finality, and never derive it from confirmation depth,
  freshness classification, proof verification or gap closure;
- keep watchtower freshness, where shown, visually and textually distinct
  from projection finality. Freshness measures reorg exposure of a head;
  finality measures whether a later admission can change an instant's holder.
  A `FRESH_FINAL` / `REORG_SAFE` classification is not a finality statement;
- treat a `registryReference` as an opaque locator and never render it as
  resolved content.

---

# 7. Development Stages

## Stage 0 — Project foundation

Toolchain, typecheck, test runner, CI entry point.

## Stage 1 — SDK port and contract binding

Typed port mirroring both interfaces, ERC-165 discovery and conformance
detection, the rpc adapter, and a deterministic in-memory adapter that
implements the four projection invariants and the finality rule for tests.

## Stage 2 — Asset view

Two sequences side by side, alignment, contract identity, authority.

## Stage 3 — Temporal query and history

`holderAsOf` / `entryAsOf` / `isFinalAsOf` at an instant, with the
before-first-entry and read-failure paths; the append-only entry walk.

## Stage 4 — Gap-aware settlement UX

Open gap, contested interval, deadline, closure kinds, and the risk surfaces
in §4.6.

## Stage 5 — Freshness annex and ecosystem integration

Optional watchtower freshness layer, kept distinct from finality; the kit
adapter once the Native Infrastructure Kit exposes its Register API.

---

# 8. Definition of Done

8415Wallet is complete when a user can, for any token and any instant:

1. see the tradeable position and the confirmed holder as two separate facts,
   and whether they agree;
2. get the confirmed holder at that instant, or a clear statement that the
   projection does not cover it;
3. see whether that answer is final or provisional, taken from
   `isFinalAsOf`, with the reason stated in protocol terms;
4. see whether the instant is contested by an open gap, as a signal separate
   from finality;
5. see which entry admitted the answer, with its version, commitment and
   registry reference;
6. see what register this projects, under which verification profile, who may
   move the answer, and what would have to happen for the instant to become
   final.

---

# Appendix A — changes from v1.0

v1.0 was written before the ERC text was available to this repository and
modelled the protocol incorrectly. Corrections:

1. **Instants.** v1.0 used ISO-8601 date strings. The ERC defines `uint64`
   seconds since the Unix epoch, on the `block.timestamp` scale, precisely so
   register and chain instants are comparable. Formatted time is now display
   only.

2. **Evidence.** v1.0 described "evidence references" and "admitted entries"
   as document-like objects. The chain carries `recordCommitment` and
   `registryReference` and never the record. §3.2 and §6 now say so, and the
   wallet is forbidden from rendering a reference as content.

3. **Finality.** v1.0 left finality's basis unstated. It is decidable from
   invariant 3: final iff at or after the first entry's `effectiveAt` and
   strictly before the latest entry's. Taken from `isFinalAsOf`, never
   recomputed. §4.3 now also requires explaining why, and naming the
   confirming entry as what would settle it.

4. **Gap states.** v1.0 had open / closed. The ERC has `OPEN`, `ADMITTED`,
   `CANCELLED`, `SUPERSEDED`, and the three closures mean different things.
   §4.5 distinguishes them. v1.0's "the wallet must not interpret gap closure
   as finality" was right and is kept.

5. **Contested versus non-final.** v1.0 did not have the concept. An instant
   is contested when a gap is open and opened at or before it. It is a
   distinct signal from finality — the ERC requires the two to be
   distinguishable — and §4.2 and §4.5 now keep them apart.

6. **Two ownership notions.** v1.0's "current execution state" is `ownerOf`,
   the tradeable position. §4.1 now shows it adjacent to the confirmed
   holder, and the ERC's prohibition on inferring one from the other is
   stated in AGENTS.md as a forbidden inference.

7. **Contract identity and authority.** v1.0 omitted `registerId`,
   `verificationProfile` and `isSettlementAuthority` entirely. The ERC makes
   accepting them a consumer decision, so §4.1, §4.6 and §6 add them.

8. **Conformance.** v1.0 assumed one homogeneous "infrastructure". Projection
   conformance and settlement conformance are discovered separately through
   ERC-165. §6 and AGENTS.md now require discovery before display.

9. **Vocabulary.** v1.0 used "provisional/final" correctly but left room for
   Pending / Confirmed / Rejected shorthand. The protocol defines no
   rejection event. Cancellation ends a contest and settles nothing.

10. **Freshness.** v1.0 did not mention the watchtower annex. Its
    `FRESH_FINAL` / `REORG_SAFE` classification measures on-chain reorg
    exposure, not registrar finality, and §6 forbids collapsing the two.

11. **Layer placement.** v1.0 said the wallet "does not impose settlement
    policy", which is kept and sharpened: the wallet presents the record and
    the diagnosis, and supports but never imposes remedy.
