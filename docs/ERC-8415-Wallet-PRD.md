# ERC-8415 Wallet PRD v3.0 — additive responsibility-chain iteration

Version decision (2026-09-25): v3.0 extends the existing wallet PRD; it does
not replace the original wallet. Sections 1–8 and the historical semantic
corrections remain the standalone foundation. Section 9 adds linked use.
Both modes are required. CP-01 is resolved by the owner-approved completion
rule in §9.4; this document records requirements, not implementation acceptance.

## Preserved v2.x revision history

Supersedes v2.1. See **Appendix A** for the v1.0 corrections and **Appendix B**
for what v2.1 added from the eth-magicians discussion (thread t/29634), which
assigns a good deal of work to this layer and which v2.0 was not written
against.

v2.2 rewrites **§2 Core Architecture** only. The Native Infrastructure Kit now
has a projection API, so the second adapter §2 always named is built rather
than deferred; §2 records what it may and may not answer, and why the wallet —
not the Kit — is the product.

## Product Definition

8415Wallet is the first commercial MVP built on ERC-8415, and the reference
client for the standard's semantics. Those are one product, not two: what makes
it a credible reference is what makes it useful commercially — it shows what
the projection actually says, and it can act on that without ever collapsing
the signals.

Positioning:

> A temporal asset wallet that exposes ERC-8415 projection, gap and finality
> semantics to users without collapsing them, and that can execute a trade
> whose authoritative registration arrives afterwards.

It reads a projection, builds and sends the three settlement transactions the
standard defines, and clears a trade through **8415 Clearing** while the
register catches up. It does not advise, and it has no write path into a
projection beyond transactions the user signs.

The wallet is not an ownership viewer. ERC-8415 tracks two sequences that
describe the same asset — the ERC-721 ownership sequence and the
register-confirmed holder sequence. At rest they agree; in flight they
diverge. The wallet's job is to show both faithfully, show whether they align
at a given instant. The standalone foundation remains available on its own;
linked mode adds acceptance and execution of agreed obligations under §9.

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

The wallet is the product. The Native Infrastructure Kit is backend
infrastructure it can read through, not a layer it sits inside: the wallet is
useful against a bare node with no Kit anywhere, and it is the wallet, not the
Kit, that a holder is handed.

```
User
 |
8415Wallet UI
 |
ERC-8415 SDK port  (Erc8415Reader)
 |                        \
 |                         Native Infrastructure Kit  — projection reads
 |                              (registerId, entries, resolution, finality,
 |                               the open gap)
 |
 direct chain reads  — ERC-165 conformance, ownerOf, block.timestamp,
                       settlement records, settlementPeriod,
                       isSettlementAuthority, logs
 |
ERC-8415 conforming ERC-721 contract
```

## 2.1 Two adapters, one port

The SDK port is the wallet's only window onto the projection. It is a typed
interface mirroring `IRegisterProjection` and `IProjectionSettlement`, with
two adapters:

- **rpc** — `eth_call` against the conforming contract. Complete on its own,
  and the only adapter a deployment needs;
- **kit** — the Kit's projection API for the register reads, composed with an
  rpc reader for everything else.

Both return the same types, and both are held to `checkReaderConformance`.
Nothing above the port knows which is in use, and neither adapter is permitted
to compute an answer the contract can be asked for. The one derivation the kit
adapter makes — `currentEntry`, which the Kit's API has no route for, read as
`entryAt(entryCount)` — is checked against what a latest entry must satisfy
and refused when it does not hold.

## 2.2 The kit adapter does not replace the chain

The Kit indexes a register. Three of the things this wallet must show are
properties of the chain rather than of the register, and none of them may be
served from an index:

| Fact | Why it stays on chain |
|---|---|
| `ownerOf` | The tradeable position. An index serving both it and the confirmed holder from one store would assert exactly the equivalence ERC-8415 exists to deny. |
| `supportsInterface` | How a deployment advertises conformance. An indexer vouching for the contract it indexes is circular. |
| `block.timestamp` | Dates a gap against its deadline, and is why the present instant is never final. |

Settlement records are on chain for a narrower reason: the Kit's API serves
only the gap currently open, and a wallet's settlement history is mostly
closed gaps — the cancellations and supersessions that admitted nothing and so
leave no trace in the entry walk at all.

`--kit` therefore requires `--rpc`. This is not a convenience; a Kit-only
wallet could not show the position, and showing the confirmed holder in its
place is the single substitution this standard exists to prevent.

## 2.3 The two backends check each other

`registerId` and `verificationProfile` are specified immutable, so two
faithful readers of one deployment MUST report the same pair. The kit adapter
reads them from the index and compares them against the chain once, on the
first read that needs them, and raises `BackendDisagreementError` on a
mismatch rather than choosing a side. What this catches is the failure mode a
second backend introduces: a base URL, an API key or a tenant pointing at
another register.

A backend that cannot answer is never reported as an answer. The Kit's 404 for
an instant the projection does not cover is the API's spelling of a revert and
is carried across as one; an unreachable, unauthenticated or faulting backend
raises `KitTransportError`, which no view may render as a fact about the
register.

## 2.4 Selector agreement is cross-checked, not self-checked

The wallet derives every function selector by hashing a signature it holds as
text. Recomputing that from the same source proves arithmetic, not agreement.
The Kit's Ethereum adapter writes the same selectors down as literals recovered
from the compiled Solidity ABI — an independent derivation — and the suite
compares the two tables. A signature drifting on either side fails the build
and names the call.

The wallet MUST NOT redefine ERC-8415 semantics.

---

# 3. Data Model

The protocol types mirror the ERC and add no new protocol state. Display
state and the application obligation model in §9 are separate from ERC state.

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
a safe/unsafe verdict, and does not invent a remedy from these observations.
Linked mode validates the explicitly accepted conditions in §9 before executing
an action.

## 4.7 What a holder is actually asking

The questions in §4.1–§4.6 are the protocol's. A holder's are different, and
the wallet answers them in their own words or it has not done its job:

**"What does 'registration pending' mean for me?"** That a previous transfer
has not yet been recorded by the register. It is not a failure, not an error,
and not a blocked transaction — it is the register catching up.

**"Do I need to do anything?"** No. You wait. Registration is serial: the token
can change hands on chain every few minutes, and the register records each hop
one at a time. Nothing about that is fixable by a wallet or a standard.

**"How far behind is it?"** Where the wallet can tell, it says. An open gap
naming an expected holder who is *not* the current `ownerOf` means at least one
further transfer will need registering after this one closes. That is
computable from the two sequences and is the most direct answer available to
the question a holder actually asks.

**"What if it takes too long?"** The gap carries a deadline, bounded by
`settlementPeriod`. When it passes, the wallet says so. What follows is
governed by the trade terms between the parties — it is not the protocol's
concern. The wallet reports the fact; it does not advise on it.

Where the parties have written those terms into a clearing contract, the
wallet can act on them: 8415 Clearing releases or returns a trade according to
terms already agreed, and reads the register to decide which. Executing an
agreed term is not advising, and it is not the wallet deciding the remedy.

**"Who do I contact?"** `registerId` identifies the register and
`isSettlementAuthority` identifies who may move the answer, both as on-chain
identifiers. Resolving either to a party a person can contact is profile-defined
and off-chain. The wallet shows the identifiers and states plainly that it
cannot resolve them, rather than leaving a user to assume no one is reachable.

A register gap alone never blocks ordinary ERC-721 transfers. In linked mode,
a participating account enforces its accepted forwarding/return obligations;
that application authorization is not a registrar-imposed protocol lock.

## 4.8 Before acquiring

A holder deciding whether to acquire a token needs the same facts as one who
already holds it, framed for a decision that has not been made yet: whether a
gap is open, whose registration it is waiting on, whether further hops sit
behind it, and that the instant of their own purchase will never be final at
the moment it happens — the present never is.

The wallet presents those facts. It does not score the token, does not say
whether acquiring is wise. Whether that risk is acceptable is the acquirer's
decision, reflected in their trade terms. Protected linked receipt additionally
requires the explicit, enforceable acceptance described in §9.

## 4.9 Collisions the protocol does not prevent

Commitment and `registryReference` uniqueness is enforced **per token only**. A
single off-chain register entry can therefore back the confirmed-holder claim
on two separate tokens at once, and every invariant on each token individually
still holds — a single-token audit surfaces nothing.

The ERC assigns detection to this layer: downstream indexers should surface
such collisions rather than expect the protocol to reject them. The wallet
therefore compares commitments and references across the tokens it has been
given, reports any collision it finds, and states the limit of the check — it
can only compare what it was asked to look at, so finding none is not proof
that none exists.

## 4.10 Reads are snapshots

`holderAsOf`, `isFinalAsOf` and `openGapOf` are point-in-time reads, and a
proof can be admitted between a read and an action that depends on it.

The wallet marks every transaction it builds as resting on a snapshot, and can
re-derive a built request to report whether anything moved underneath it. That
narrows the window; it does not close it.

The recommended shape for an integrating contract is the **on-chain atomic
read**: call `holderAsOf` / `isFinalAsOf` / `openGapOf` inside the same
transaction as the action that depends on the result. That closes the window
entirely, because no separate read-then-later-send step exists for a proof to
land between. Handling a state shift at transaction-land time is the fallback
for an off-chain read done for display, not a co-equal alternative, and the
wallet's guidance says so in those terms.

---

# 5. Application Patterns

## Trading

The wallet supports applications that compose immediately on a provisional
answer, and applications that quarantine until an instant is final. It shows
which case a given instant is in. It does not impose a settlement policy, and
it does not tell a user whether a trade is safe.

A non-normative reference pattern circulates in the ERC's discussion: hold
trade consideration while a gap is open, release it when an entry is admitted,
return it to the buyer if the gap is cancelled without admission. The wallet
reports the state that pattern keys off — and reports it as three distinct
cases, because a stale attestation must not be handled as ordinary pending:

| Projection | Watchtower feed | What the wallet reports |
| --- | --- | --- |
| final at the instant | fresh | settled and current |
| provisional | fresh | a change is expected; the feed is live |
| any | stale | the feed is not current — distinct from pending |

Naming the third case separately is the point. Conflating stale with pending
makes a silently dead register look like ordinary delay.

The reporting layer recommends no remedy. The existing clearing integration
and linked mode may execute terms accepted by the parties, including release,
return and refund. The wallet does not choose new terms or adjudicate rights.

## Custody

Institutional use: monitoring the two sequences, reviewing commitments and
references, and exporting an audit trail of entries and gap transitions that
can be re-checked against the chain later.

Where a watchtower feed is read alongside a projection, the pairing is an
assertion by whoever configured it: no on-chain link exists between a
`registerId` and a feed identifier, and none exists between a feed and its
predecessor across a migration. The wallet records both as configuration,
labels them as unverified, and does not let either pass as a fact it checked.

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

# 8. Standalone foundation — definition of done

The retained standalone reading foundation is complete when a user can, for any
token and any instant:

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
   final;
7. understand, in their own words, what a pending registration means for them,
   that it is not a failure, that waiting is the action, and where the remedy
   lies if the commitment window passes.

---


# 9. v3.0 increment — standalone and linked use

## 9.1 Scope and preservation

8415Wallet supports two modes:

| Mode | Required behavior |
| --- | --- |
| Standalone | The original wallet remains independently usable: projection and temporal reads, dual histories, disclosure, conformance and identity checks, protocol transaction builders, authorized signing, and the existing single-trade clearing pattern. ArtFi, Oracle and other wallets are not mandatory dependencies. |
| Linked | Participating wallets coordinate unresolved transfer obligations for the same token, preserve each leg's escrow and accepted upstream conditions, detach completed heads, and execute authorized callbacks with original-route refunds. |

The existing `ProjectionEscrow` holds both asset and payment for one trade.
Keep that implementation and its tests as the legacy single-trade mode.
The linked mode instead leaves the token in the supported recipient wallet;
only that leg's payment remains in seller-associated escrow. Existing escrow
tests do not prove the new forwarding path.

This is an application increment. Preserve the reader port, direct-chain path,
optional Kit adapter, ERC interfaces, semantic distinctions and historical
evidence. Do not add a matching engine, order book, centralized clearing
operator, cross-chain bridge or legal adjudication service. ArtFi is a consumer
of this independent product; Oracle/Kit integration does not own wallet keys.

## 9.2 Four distinct records and per-leg identity

Keep token transfers, admitted register history, active responsibility and
per-leg payment escrow separately visible. An open protocol gap is none of the
other three records.

For A → B → C → D, the same token reaches D while AB, BC and CD may all remain
unresolved. B's payment is reserved for A's sale, C's for B's sale and D's for
C's sale. Seller-associated escrow is segregated principal, not the seller's
spendable balance. It may use isolated records in a shared contract; a new
contract for every seller is not required.

Each leg binds at least:

- a unique replay-resistant leg ID, chain/asset contract/token ID and verified
  sequence position;
- seller, buyer and original payer; predecessor leg and active dependencies;
- accepted terms/version, inherited conditions and scoped return authorization;
- segregated consideration, denomination, escrow and exact release/refund
  recipients;
- token-transfer and admitted-holder evidence with source/block provenance;
- current commercial outcome and confirmed execution progress.

An address is not a leg ID. A → B → A → C has distinct occurrences. Use
lossless protocol integers and explicit application outcome names; do not add
commercial states to ERC enums or reinterpret protocol events.

## 9.3 Establishment and downstream acceptance

For AB, B accepts AB's exact terms and an executable, bounded conditional-return
mechanism. Reserve B's exact payment and deliver the token to B. On forwarding
BC, C accepts BC and every still-active inherited condition; reserve C's
payment separately and deliver the same token to C. AB need not complete first.

Prefer atomic establishment. If multiple transactions are necessary, protect
and expose intermediate states; payment approval is not escrow funding. A
notification, generic wallet-connection signature or revocable allowance alone
does not prove enforceable future recall. Demonstrate that alternate transfer
paths cannot silently drop already accepted obligations. If the selected
account mechanism cannot provide that protection, report the path unsupported
before accepting funds on a recall promise.

Forwarding may append a tail as completed heads detach. Removing a terminated
dependency does not require acceptance of the same unchanged trade again.
Conflicting revisions/forks must be detected; no concurrent update may lose a
new tail or revive a detached condition.

## 9.4 CP-01 resolved — per-leg commercial completion

Owner-confirmed rule (2026-09-25): for an active leg S → B, its commercial
completion condition is satisfied when **both the current on-chain owner and
the admitted register holder have reached B or a later verified position in
that token's same transfer chain**.

In application notation, where `position` means a verified occurrence/leg
position, not an address value:

```text
ownerPosition >= buyerPosition(leg)
AND
holderPosition >= buyerPosition(leg)
```

Both observations must be bound to this asset, leg and accepted chain, and
revalidated at the authoritative execution boundary. The holder comes from
admitted register evidence, never inferred from `ownerOf`. Unknown, ambiguous,
unrelated or unavailable evidence does not satisfy the condition.

For A → B → C → D:

| Current owner | Admitted holder | Completion consequence |
| --- | --- | --- |
| B | A | AB remains unresolved; A's payment stays reserved. |
| B | B | AB completes and its payment is released to A. |
| D | B | AB completes; BC and CD remain unresolved. |
| D | C | AB and BC can complete in prefix order; CD remains unresolved. |
| D | D | AB, BC and CD can complete in prefix order. |

The owner and holder need not equal each other, and neither must still equal
the leg's buyer. Do not wait for every descendant, require an extra confirming
entry, or choose an arbitrary older instant whose `isFinalAsOf` is true.

Once AB completes, release its reserved payment to A exactly once, detach AB
from active responsibility, and make B the earliest remaining return boundary.
The token **cannot subsequently be recalled to A under AB**, and AB cannot be
reactivated by later holder changes. For example, failure of unresolved BC
after AB detached stops at B. Historical AB evidence remains available.

“Commercially complete” is an application outcome. ERC temporal finality
continues to come from `isFinalAsOf(tokenId, t)`; a latest interval can remain
protocol-provisional while a commercial leg is complete. Show both accurately.
Their agreement is not a claim of legal identity or title. The earlier v3.0
proposal `TRANSFER_LINKED_ADMISSION_V1` and its pending confirmation do not
override this owner-confirmed predicate. **CP-01 is closed as a requirements
decision**; implementation and acceptance testing remain outstanding.

## 9.5 Detachment, callback and original-route refunds

Only the completed active prefix detaches. A descendant may accumulate its own
evidence but cannot dispose of principal needed for a still-live inherited
callback. No leg must wait for its descendants to complete.

Accepted terms define the failure trigger, authority, deadline where relevant
and affected scope. Delay, stale feeds, unavailable RPC, gap closure or protocol
cancellation do not independently create a commercial rejection or callback.

For unresolved AB failure with the token at D, requests propagate B → C → D.
Actual returns proceed D → C → B → A. Each return is bound to the correct
asset, leg, callback and recipient; CD refunds D, BC refunds C and AB refunds B
from each leg's own original principal. A request, signature or UI flag is not
a completed return. Verify that leg's required return before completing its
refund; preserve an explicit refund-due state if transfer and payment cannot
be atomic. Never substitute recipients, net price differences or spend another
leg's reserved principal.

Authenticated bounded hops may be resumed after interruptions. Serialize
release versus callback, reject stale/duplicate actions, and permit exactly
one terminal commercial outcome. Once a valid callback commits, forwarding
must not escape it. Late register admissions remain separately visible and
cannot rewrite historical outcomes or erase append-only protocol records.

## 9.6 Views and execution boundaries

Extend existing views to show active head/tail, detached history, inherited
conditions, token location, per-leg reserved payments and return/refund progress.
Before protected receipt, show the precise terms, completion predicate and
return scope. User-visible completion must derive from confirmed execution.

Retain chain/contract/profile binding, real ERC-165 discovery, accurate error
classification and bounded requests. Separate unavailable, unsupported,
not-covered and provisional results. An `apparently-registered` history
correlation or unverified backend `complete: true` cannot release funds.

Keep the supplied Giraffe VI/fonts and actual desktop/mobile journey in the UI
acceptance scope. CLI, API and contract work can proceed if browser tooling is
unavailable, but they do not replace UI evidence.

## 9.7 Stages and required acceptance scenarios

Stages 0–5 remain in place. Extend Stage 4 with the responsibility model,
protected forwarding, head detachment, callback/refund and recovery; extend
Stage 5 with the actual account/backend integration, delayed registrar,
testnet and desktop/mobile journey. Preserve completed foundation work.

| ID | Required linked-mode observation |
| --- | --- |
| W-01 | AB places the token in B and B's payment in A-associated escrow. |
| W-02 | The same token reaches D while AB/BC/CD payments remain independently reserved and inherited conditions remain enforceable. |
| W-03 | Ordinary register lag creates no invented rejection or registrar transfer lock. |
| W-04 | Owner and holder at B or beyond complete AB; its payment releases and the unresolved tail remains. |
| W-05 | Holder progression to C before AB processing does not require the holder to return to B or prevent AB completion. |
| W-06 | Head detachment concurrent with tail extension preserves all new legs and conditions. |
| W-07 | Unresolved AB failure returns D→C→B→A and refunds each original payer from its own escrow. |
| W-08 | After AB completion, BC failure stops at B; A receives no callback and AB remains detached. |
| W-09 | A descendant's evidence cannot release principal still required for a live inherited obligation. |
| W-10 | A callback request without actual token return cannot complete a refund. |
| W-11 | Mid-hop token/payment failure remains truthful and resumable. |
| W-12 | Duplicate callback, replay and restart produce one outcome, not duplicate transfers/payments. |
| W-13 | An unsupported recipient without enforceable acceptance cannot establish a protected leg. |
| W-14 | Alternate transfer paths cannot silently discard accepted obligations. |
| W-15 | Repeated wallet addresses retain distinct leg/occurrence bindings; addresses are never numerically ranked. |
| W-16 | RPC faults, malformed responses and unsupported interfaces cannot become successful evidence. |
| W-17 | Release/callback races select one authorized outcome. |
| W-18 | Late register admission does not rewrite a completed return/refund. |
| W-19 | Both owner/holder progress are required; owner-only/holder-only/ambiguous progress is refused; protocol provisional status remains accurately displayed after commercial completion. |
| W-20 | One deployed same-token multi-wallet journey demonstrates views, acceptance, escrow, detachment and callback/refund. |

Reuse the illustrative 30-second transfer / 180-second independent registrar
cadence where useful, recording actual times. No local time jump is real
elapsed testnet time. Reuse authorized test assets and preserve earlier
Sepolia evidence; no mainnet or real-asset authorization is created here.

Full delivery requires both the standalone foundation and the linked-mode
scenarios at their stated execution levels. Source, local tests, EVM tests,
public-testnet receipts and UI evidence remain distinct. PR #2's existing
513-test suite and 14 EVM tests establish its tested baseline; they do not
establish W-01–W-20 or retroactively validate v3.0.

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

---

# Appendix B — what v2.1 adds, and why

v2.0 was written against the ERC text alone. The eth-magicians discussion
(thread t/29634) assigns a good deal to the wallet layer — one reply is titled
on the point that the solution belongs in the wallet rather than a more complex
spec — and several requirements exist only there.

1. **A holder's own questions (§4.7).** The thread opens with a user asking
   what "registration pending" means for them, whether they must do anything,
   and who to contact if it drags. The author's answer defines the wallet's
   job: surface the real status, say that waiting is the action, point at the
   trade terms if the commitment window passes, and never block the token.
   v2.0's copy was protocol-accurate and answered none of it.

2. **Serial registration and the hops behind (§4.7).** Registration is
   physical and sequential: the register records a→b, then b→c, then c→d. What
   is pending is a *previous* transfer. An open gap whose expected holder is
   not the current `ownerOf` means further hops are still outstanding behind
   it — computable from the two sequences the wallet already reads, and the
   most direct answer to "how far behind is this".

3. **Acquisition-time disclosure (§4.8).** The thread is explicit that a
   wallet should surface an open gap to someone *about to* acquire a token.
   v2.0 described a monitoring tool only.

4. **Cross-token collisions (§4.9).** Uniqueness is per token. One register
   entry can back two tokens while every single-token invariant holds, and the
   ERC hands detection to downstream indexers. v2.0 did not mention it.

5. **Stale is not pending (§5, Trading).** The freshness annex's whole purpose
   is separating a silently dead register from ordinary delay. v2.0 kept
   freshness and finality apart structurally, which is the hard part, but never
   presented the two together, which is where the conflation happens.

6. **TOCTOU (§4.10).** Point-in-time reads can move under a caller. The
   recommended integration shape is the on-chain atomic read, which closes the
   window rather than narrowing it; handling a shift at land time is the
   fallback for a display read, not an equal option.

7. **Layer-one identity, said to the user (§4.7, AGENTS.md).** The thread
   argues that leaving "on-chain owner == register-confirmed holder" implicit
   is the same category error as `FRESH_FINAL`, one level up: a reader takes
   record agreement for verified legal identity. The protocol does not, and
   cannot, verify the equivalence, and the wallet must say so where it reports
   agreement.

8. **Migration continuity (§5, Custody).** No on-chain link exists between a
   watchtower feed and its predecessor across a migration; tracking it is the
   application's.

Two things the thread settles that v2.0 already had right, recorded so a later
reader does not reopen them: vocabulary discipline — open/closed gap,
provisional/final, admitted, with no rejection event — and that reorg-safety is
not registrar finality.

One correction to flag upward rather than adopt: the Scope draft in the thread
describes `isFinalAsOf` as indicating whether on-chain reorg depth makes the
projection immutable. That contradicts the ERC's own rule, which decides
finality from entry ordering, and contradicts the same thread's earlier
agreement to rename the reorg-safety signal precisely so the two are not
conflated. This wallet follows the ERC text.
