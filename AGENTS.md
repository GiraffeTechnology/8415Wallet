# ERC-8415 Wallet AGENTS.md

## Product Boundary

8415Wallet is an application-layer wallet and reference client for ERC-8415
asynchronous register projection.

It is NOT:

- a generic NFT wallet;
- an ERC-3643 wallet clone;
- a marketplace, order book or matching engine;
- a replacement for ERC-8415 protocol semantics;
- an adjudicator of legal title, entitlement or remedy.

The wallet MUST consume ERC-8415 semantics, not redefine them.

The product supports both standalone and linked use. v3.0 is an additive
iteration on the original wallet: retain its readers, views, transaction path
and legacy single-trade clearing. Linked mode adds the agreed responsibility
chain in PRD §9; it must not make ArtFi, Oracle or another wallet mandatory for
standalone use.

---

## Source of Truth

The implementing agent MUST read, in this order:

1. AGENTS.md
2. docs/ERC-8415-Wallet-PRD.md
3. The eth-magicians discussion, thread t/29634. It is not the specification,
   but it repeatedly assigns work to this layer — "the solution belongs in the
   wallet, not a complex spec" — and several requirements below exist only
   there. Where it and the ERC text disagree, the ERC wins.
4. The ERC-8415 specification itself:
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
   register-confirmed holder refer to the same underlying right. The protocol
   **does not, and cannot, verify this equivalence**. The wallet MUST say so
   wherever it reports that the two agree: agreement between records is not
   verified legal identity, and letting a user infer otherwise is the same
   category error as reading reorg safety as registrar finality, one level up;
2. faithful record — append-only entries and the ERC-721 ownership
   sequence they sit alongside;
3. diagnosis — `holderAsOf`, `isFinalAsOf`, `openGapOf`, and whether the two
   sequences align at an instant;
4. remedy — cancellation, escrow, timeouts, refunds, unwinding.

The wallet **presents** layers two and three to a user, and **supports but
never imposes** layer four. It states what is recorded and what is still
open; the parties' own terms decide what to do about it. Executing explicitly
accepted release, conditional return and refund terms is permitted. A
commercial obligation is application state, not new ERC state.

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

### The protocol temporal finality rule

An instant is final if and only if it is at or after the first entry's
`effectiveAt` and strictly before the latest entry's `effectiveAt`.

The wallet MUST take this from `isFinalAsOf` and MUST NOT recompute it,
approximate it, or cache it across a block in which an entry was admitted.

### What "registration pending" means to a user

An open gap means a **previous transfer** has not yet been recorded by the
register. The wallet MUST present this as the normal state it is, never as a
failure, an error, or a blocked action.

Registration is serial and physical: a token can change hands on chain every
few minutes, while the register records each hop one at a time — a→b, then
b→c, then c→d. No standard removes that lag, and the wallet MUST NOT imply one
could. Where the wallet can tell that further hops are outstanding behind the
one being registered, it SHOULD say so, because "how far behind is this" is
the question a holder actually asks.

The correct user action is to wait. If the register exceeds its agreed
commitment window, that is a signal the previous transfer may itself have an
issue, and the remedy lies in the **trade terms between the parties**, never in
the protocol. The wallet reports that the window has passed; it does not
advise on what to do about it.

Acting on terms the parties already agreed is a separate thing and is
permitted: 8415 Clearing releases or returns a trade by reading the register
against a condition written before the trade began. What stays forbidden is
the wallet choosing the remedy, scoring the situation, or recommending a
course of action.

### Three orthogonal signals

Never collapse these into one badge:

- **final / provisional** — can a later admission still change this instant's
  holder;
- **contested / not contested** — is a gap open whose `openedAt` is at or
  before this instant;
- **reorg-safe / fresh / stale** — the optional watchtower freshness layer,
  which measures on-chain reorg exposure of a head, not registrar finality.

Finality does not depend on whether a gap is open. Freshness is not finality.

**Stale is not pending.** A stale attestation and an open gap look alike to a
careless reader, and conflating them makes a silently dead register
indistinguishable from ordinary delay. The wallet MUST keep them apart, and
MUST report a stale feed as stale whatever `isFinalAsOf` says about the instant
in question.

---

## Forbidden Inferences

The wallet MUST NOT treat any of the following as ERC temporal finality:

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
  ERC-165 identifier;

- present agreement between `ownerOf` and the confirmed holder as verified
  identity of the underlying right;

- cache a point-in-time read across a transaction. `holderAsOf`,
  `isFinalAsOf` and `openGapOf` can move between a read and an action that
  depends on it. Where the wallet builds a transaction from such a read it
  MUST say the read is a snapshot, and its guidance to integrators MUST name
  the on-chain atomic read — calling these inside the same transaction as the
  dependent action — as *the* recommended shape, not one of two options. That
  closes the window rather than narrowing it;

- rely on the protocol to prevent a `recordCommitment` or `registryReference`
  from being reused on a different token. Uniqueness is enforced per token
  only, and one register entry can back the confirmed-holder claim on two
  tokens while every single-token invariant still holds. Detecting and
  surfacing such a collision is explicitly this layer's job, and a
  single-token view MUST NOT be presented as ruling it out;

- assume a watchtower feed identifier is linked to its predecessor across a
  migration. The contract keeps no such link; tracking continuity is this
  layer's job.

---

## Vocabulary Discipline

Use protocol-defined terms for protocol UI, model identifiers and docs:

- open gap / closed gap;
- provisional / final;
- admitted;
- confirmed holder;
- tradeable position (`ownerOf`).

Do not use Pending / Confirmed / Rejected as state names. They are not
protocol states and read as a rejection event the ERC does not define.
Separately named application outcomes such as released/detached or
returned/refunded are permitted for commercial obligations and must never be
presented as ERC gap states.

---

## Application Boundary

Architecture:

```
User
 |
Wallet UI
 |
ERC-8415 SDK port  (Erc8415Reader)
 |                        \
 |                         Native Infrastructure Kit — projection reads
 |
 direct chain reads — conformance, ownerOf, the clock, settlement, logs
 |
ERC-8415 conforming ERC-721 contract
```

The wallet is the product; the Kit is backend infrastructure it may read
through. The wallet depends on the SDK port, never on a transport, and never
on a second source of truth alongside it.

The kit adapter is a projection accelerator composed with a chain reader,
never a replacement for one. `ownerOf`, `supportsInterface` and
`block.timestamp` are chain facts and are never served from an index: an
index answering for both the position and the confirmed holder would assert
the equivalence this standard denies, and an indexer vouching for the
contract it indexes is circular.

Where two backends answer for one deployment, they are cross-checked on
`registerId` and `verificationProfile` — both specified immutable — and a
mismatch is reported, never resolved by preferring one. A backend that cannot
answer raises a transport error; it is never rendered as a fact about the
register.

Do not create protocol changes inside the wallet project.

Do not introduce projection-history rollback, veto or override semantics.
An application conditional return is a new authorized token transfer and may
execute only accepted terms within the active responsibility boundary; it
cannot erase history or cross a completed leg. The wallet has no
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


## Linked-mode execution requirements (CP-01 resolved, 2026-09-25)

1. v3.0 extends the original PRD; do not remove the standalone wallet or
   relabel legacy single-trade escrow tests as linked-mode acceptance.
2. Responsibility depends on condition/execution controls, NOT escrow. Keep
   token transfers, admitted history and control-owned obligations distinct.
   Payment is an optional separate adapter. An escrow record, amount or released
   payment is never authority for acceptance, completion or return. The token
   rests with the recipient wallet; no payment is required to model responsibility.
3. A downstream recipient accepts executable, scoped conditions for its own
   leg and every still-active upstream obligation. Demonstrate enforcement
   across alternate transfer paths; a message or revocable allowance alone
   is insufficient.
4. For S→B, commercial completion requires BOTH verified owner and admitted
   holder positions at B or later in the same token's accepted chain. Position
   means a proved occurrence/leg index, never numeric address order. Bind the
   observations to chain, asset, leg and accepted terms; refuse missing or
   ambiguous evidence.
5. Once the control confirms AB completion, detach AB permanently. If payment
   exists, settle it separately to A once; payment failure must not revive AB.
   For A→B→C→D with owner=D/holder=B, AB can complete without BC or CD.
   With owner=D/holder=C, AB and BC can complete in prefix order. A later
   callback cannot return the token across AB to A.
6. Completion does not require owner==holder, either still being B, all
   descendants completing, an extra confirming entry or a chosen historical
   `isFinalAsOf=true`. Continue to display raw ERC final/provisional results;
   commercial completion and protocol temporal finality are distinct.
7. Only completed prefixes detach. Preserve history and the unresolved tail,
   including concurrent tail extensions and repeated address occurrences.
8. A control-authorized callback affects only active dependencies. For unresolved
   AB, propagate B→C→D and return D→C→B→A. In funded scenarios, refund each
   original payer after its required return using separate payment records.
   If AB detached, BC's return boundary is B. No reactivated obligation is allowed.
   Payment adapters must separately prevent substituted recipients, pooled
   principal and double settlement/refund.
9. Revalidate and serialize at execution; persist confirmed progress and
   resume bounded hops after failure. Protocol delay, RPC failure or a
   cancelled gap cannot invent an unaccepted callback condition.
10. CP-01 is closed as a product decision by the rule above. Do not reopen it
    using the superseded proposed completion profile. Implementation,
    enforcement and W-01–W-21 evidence remain required.
11. Develop responsibility controls as an independent module, not a wrapper
    around escrow. The local kernel is an uncommitted proposal generator, not
    verified consent or account enforcement. Its input facts are a trust boundary.
    Do not connect it to signing/execution before authenticated atomic adapters,
    alternate-path protection and independent security audit are complete.

---

## Development Rules

### Current user-directed order (2026-09-25)

PR #3 must remain unmerged. Complete all remaining independent-control development
and integration before running the unified validation batch. During this development
phase do not run unit/EVM/chain tests, deployment or typecheck/build verification.
The subsequent user instruction requires a new draft PR for each stage: publish
stage branches with `[skip ci]` in each development HEAD commit, after checking
that CI only uses push/pull_request events. Do not disable or weaken workflows.
After all development is complete, publish fresh commits without skip directives
and run unified CI/testing before merging the stacked PRs in dependency order.
Writing test cases and acceptance tooling is preparation, not execution.
An inserted collaboration request or progress report never completes this task.

Source-closure checkpoint: Stage 5C has now supplied contracts, authenticated
adapters, consent/recovery UI and executable regression/deployment tooling. Once
this stage's exact tree is published as its draft PR, begin the first unified
validation batch; fix genuine findings without adding unrelated product scope.
Source status is SOURCE_COMPLETE_PENDING_UNIFIED_VALIDATION, not release PASS.
Keep PR #3's merge hold. No new V3 test or chain result exists at this checkpoint.

Later validation checkpoint (same day): after PR #7 source freeze, unified
typecheck/browser build/standalone CLI passed; latest Node 628/628 and EVM 30/30 passed.
See docs/reports/V3-LOCAL-VALIDATION-20260925.md. Continue CI/review and genuine
UI/public-testnet gates; do not keep describing the new source as never tested.
Independent review found nonce-race recovery and missing directory fsync defects.
Both now have repairs and regressions; fresh review is still required. Node file
journaling fails before sending where directory fsync is unavailable (including
this Windows host). Browser journaling requires strict IndexedDB durability;
its event-fixture tests do not constitute genuine browser crash-recovery evidence.
No new V3 public-chain deployment or independent audit has passed yet.

After development is complete, validation MUST include actual public-testnet
deployment and real transactions, in addition to local tests and independent
security review. Historical Sepolia activity and earlier 607/607 Node + 14/14
legacy EVM results do not validate new control code. Label the current source
`IMPLEMENTATION_IN_PROGRESS / UNTESTED`; do not invent results or declare all
development complete from the presence of source files.

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

The standalone reading foundation is complete only when a user can see, for any token and any
instant, and without conflating them:

- the tradeable position and the confirmed holder, side by side;
- whether the answer at that instant is final or provisional, and why;
- whether that instant is contested by an open gap;
- which entry admitted the answer, with its commitment, version and
  registry reference;
- what register this projects, under which verification profile, and who may
  move the answer.

Full product delivery also requires independent standalone use and PRD §9's
linked-mode W-01–W-21 scenarios, including real selected account enforcement,
independent controls without escrow, optional funded flows, detachment,
callback/refund, recovery, independent security audit and deployed UI evidence. Report
baseline, local EVM, public-testnet and UI results separately; a documentation
change or one completed leg is not full acceptance.
