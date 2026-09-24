# ERC-8415 Native Infrastructure Kit (NIK)
# PRD v2.1 — Ecosystem Infrastructure Evolution

## Product Definition

ERC-8415 NIK is a temporal projection infrastructure layer for ERC-8415 ecosystems.

It is not a generic RWA registry. It provides infrastructure for:

- admission of verified projection entries;
- temporal asset queries;
- derived finality semantics;
- ecosystem integrations.

## Core Model

```
Evidence
  |
Proof Profile
  |
Admission
  |
Append-only Projection History
  |
Temporal Queries
```

## Core Questions

The infrastructure answers:

1. Who is the holder as of time t?
2. Is that historical answer final as of time t?
3. Is a change in flight covering that instant?
4. What evidence admitted that projection?

Each is a separate question with a separate query. They MUST NOT be merged into
a single status value.

---

# Scope

ERC-8415 defines an asynchronous projection. It records, on chain, the sequence
of confirmed holders reported by an external register, alongside the on-chain
ownership sequence recorded by ERC-721. Both are indexed by effective time. The
Kit is the infrastructure that admits into that record and queries it.

## The Kit does

**1. Record both sequences faithfully.** Holder entries carry a holder address,
effective time, record commitment, previous commitment, registry reference and
version. Versions are consecutive and effective times strictly increase.
Commitment uniqueness is enforced strictly per token: within a token's local
projection history a commitment cannot be reused. The Kit does not enforce, and
cannot infer, uniqueness across tokens.

**2. Expose alignment and projection status at any historical instant.**
`holderAsOf` for point-in-time lookup; `isFinalAsOf` for whether a later
admission can still change that answer; `openGapOf` and `openedAt` for whether a
change is in flight; and the entry walk `currentEntry`, `entryAt`, `entryCount`,
`entryAsOf`.

`isFinalAsOf` reports the later-admission rule and nothing else. The thread's
Scope draft (#22) phrased it as a reorg-depth immutability check; that phrasing
is not adopted, because it conflicts with the ERC body text and with the same
thread's own `REORG_SAFE` separation (#19, #20). Where they disagree, the ERC
body text governs.

**3. Guarantee deterministic auditability of the recorded transitions.** Every
admitted entry and gap transition is visible on chain. Admission is atomic:
proof consumption, remote-height advancement, entry admission and gap closure
happen together.

**4. Remain non-blocking.** Opening a gap does not freeze ERC-721 transfers.
Settlement authority is separate from token ownership. Anyone may relay a proof,
and submitting one grants no special rights.

## The Kit does not

**1. Guarantee eventual alignment.** It records both sequences and exposes
whether they align at a given instant. If the registrar stops issuing entries,
recent instants may stay non-final indefinitely. Convergence is an operational
property of the registrar, not a guarantee made by this infrastructure.
Normative text MUST NOT claim "eventual consistency".

**2. Adjudicate legal title or entry validity.** A proof establishes inclusion
in accepted remote state, not the truth of the underlying register. At a final
state the on-chain owner and the register-confirmed holder are assumed to refer
to the same right, but the protocol does not, and cannot, verify this
equivalence.

**3. Enforce cross-token uniqueness** of registry references or commitments. A
compliant implementation may admit an entry whose registry reference or
commitment duplicates one held by another token. Preventing such collisions, and
tracking continuity across tokens, is a registrar invariant or an
application-level constraint; downstream indexers should detect and surface
collisions rather than rely on the Kit to reject them.

**4. Prescribe remedy.** Cancellation, escrow, timeouts, refunds and downstream
unwinding are governed by the transaction terms between the parties.

**5. Prescribe entitlement or compliance outcomes.** No entitlement rules, no
AML/CFT outcomes, no compliance decisions. It does not move tokens across chains
and does not absorb recursive registration risk.

In one line: a faithful record and audit trail across the asynchronous
boundary — a mirror, not a tribunal.

---

# Responsibility Layers

1. **Identity** — the premise that a final on-chain owner and the
   register-confirmed holder refer to the same underlying right; stated
   explicitly, never enforced.
2. **Faithful record** — the admitted entries and the ownership sequence they
   sit alongside; this layer also carries the implementation-level immutability
   concerns: registration-time-only sequence initialisation, and atomic key
   rotation and revocation to eliminate operational gaps.
3. **Diagnosis** — alignment and status at an instant. Signals derived from
   block depth measure reorg safety of the projection, not registrar-asserted
   finality.
4. **Remedy** — application and transaction terms.

The Kit implements layers two and three, and serves layer four without deciding
it.

---

# Vocabulary

Protocol-defined terms only:

- **open gap / closed gap** — whether a settlement gap is outstanding;
- **provisional / final** — whether a historical answer could still change;
- **admitted** — an entry accepted through a verified proof;
- **confirmed holder** — the holder the register had confirmed at an instant, as
  recorded on chain;
- **tradeable position** — `ownerOf`.

`Pending` / `Locked` / `Confirmed` / `Rejected` / `Released` / `Refunded` are not
protocol states and MUST NOT name Kit states. There is no on-chain rejection
event: a proof that fails verification never becomes an admitted entry, and
there is no mechanism to retroactively invalidate an admitted entry. What can
happen is a gap staying open indefinitely — a liveness concern, not a veto — or
being cancelled before admission, in which case nothing was ever finalised.

---

# Core Modules

## 1. Projection Kernel

Provides:

- holderAsOf(tokenId, instant)
- entryAsOf(tokenId, instant)
- isFinalAsOf(tokenId, instant)
- currentEntry / entryAt / entryCount
- registerId

Requirements:

- append-only history;
- consecutive versions;
- strict effectiveAt ordering;
- commitment linkage;
- per-token commitment uniqueness.

`holderAsOf` MUST NOT alias current ERC-721 ownership. A query for an instant
preceding the first entry reverts — that is "the projection does not cover this
instant", not an error state.

## 2. Admission Engine

Proof Profile determines whether evidence can admit an entry.

Proof Profile MUST NOT directly set finality.

Admission is atomic: proof consumption, remote-height advancement, entry
admission and gap closure succeed or fail together. Admission is final once it
happens.

## 3. Finality Engine

Finality is derived from admitted temporal history, never assigned.

For t >= firstEntry.effectiveAt:

isFinalAsOf(t) == true iff there exists a strictly later admitted entry.

A later entry may confirm the same holder. A confirming entry is how a
historical instant becomes final without the holder having changed, and is the
mechanism available to an application waiting on historical finality.

## 4. Settlement Composition Layer

Settlement workflow is optional application composition.

Invariants:

```text
cancellation    != finality
gap closure     != finality
proof verified  != finality
timeout expiry  != finality
```

Opening a gap does not block transfers. Cancellation closes an open gap and
leaves provisional history provisional.

## 5. Ecosystem Layer

Support:

- wallet integrations;
- exchange integrations;
- custody systems;
- institutional applications.

---

# Integration Requirements

## Read-then-act

`holderAsOf`, `isFinalAsOf` and `openGapOf` are point-in-time reads. A proof can
land between the read and the action that depends on it.

The recommended integration shape is the **on-chain atomic read**: query inside
the same transaction as the dependent action, which closes the window entirely
rather than narrowing it. An off-chain read taken for display MUST NOT be cached
across transactions, and a contract acting on one must handle the state having
moved by the time the transaction lands.

## Application composition (non-normative)

An application may quarantine consideration while a gap is open, release on
admission, and refund if the gap is cancelled without admission. This mirrors how
legal title perfection already works off chain, and it is a reference pattern,
not a requirement. Applications that instead compose on non-final state — lending
against it, re-trading it — accept that risk themselves.

The Kit guarantees the projection is auditable and queryable. It does not
guarantee that every downstream use of a non-final state can be safely unwound.
That boundary is intentional: one mandated unwind rule would break either the
netting model or the sequential chain-of-title model, and both are supported.

## Watchtower freshness layer (non-normative annex)

An optional attestation layer may report whether the registrar's feed is still
current. It sits above the projection and alters nothing in the core state
machine.

- freshness is a safety property — a stale attestation must not read as a
  current one — and is distinct from liveness, which the Kit does not assert;
- a classification derived from block depth is named `REORG_SAFE`, never
  `FRESH_FINAL`: it measures projection immutability, not registrar finality;
- attestations verify against the key authoritative at the signed block; a
  rotated key still validates signatures made while active, a revoked key never
  does; revocation is incident response, so rotate-and-revoke is atomic;
- sequence numbers advance strictly by one — no gaps, no rewinds;
- the staleness threshold is an asset-specific risk parameter supplied by the
  consumer, never hardcoded;
- reorg-safe, fresh-but-provisional and stale are three distinct outcomes, and
  an attestation is stale whatever `isFinalAsOf` says.

---

# Strategic Position

ERC-8415 NIK is the infrastructure layer between ERC-8415 protocol semantics and
application ecosystems. It records what each side holds, exposes whether those
records agree at an instant, and leaves the consequences to the parties'
transaction terms.
