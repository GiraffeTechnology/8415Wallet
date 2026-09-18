# ERC-8415 Semantic Model

## Execution State vs Projection State

ERC-8415 separates blockchain execution from institutional projection.

```
Execution State
      |
      X
Projection State
```

Two sequences describe the same asset: the on-chain ownership sequence recorded
by ERC-721, and the confirmed-holder sequence reported by the external register.
At rest they agree; in flight they diverge. Keeping them apart is the point of
the projection.

Current token ownership is not a replacement for historical projection
semantics. `ownerOf` is the tradeable position; it is never a source for the
confirmed holder, not even as a fallback when a projection read fails.

## Responsibility Layers

1. **Identity** — at a final state, the on-chain owner and the
   register-confirmed holder are assumed to refer to the same underlying right.
   The protocol does not, and cannot, verify this equivalence. It is an
   operational premise, not an enforced property. Record agreement is not
   verified legal identity.
2. **Faithful record** — the admitted entries and the ownership sequence they sit
   alongside. What happened, not whether what happened was legally valid.
3. **Diagnosis** — whether the two sequences align at an instant, and whether
   that answer can still move. The signal is reported, never labelled success or
   failure.
4. **Remedy** — cancellation, escrow, timeouts, refunds, downstream unwinding;
   governed by the parties' transaction terms.

A faithful record and audit trail across the asynchronous boundary — a mirror,
not a tribunal.

## Temporal Queries

The semantic layer provides:

- holderAsOf(tokenId, instant)
- entryAsOf(tokenId, instant)
- isFinalAsOf(tokenId, instant)
- openGapOf(tokenId) and the gap's openedAt
- currentEntry / entryAt / entryCount
- registerId

`holderAsOf(tokenId, t)` reads as: the holder the registrar had confirmed at
effective time `t`, as recorded on chain, with no opinion on the legal validity
of that record.

Three questions stay distinct, and are never merged into one status:

1. Who was recorded at instant t? — `holderAsOf`
2. Can a later admission change that? — `isFinalAsOf`
3. Is a change in flight for that instant? — `openGapOf`, `openedAt`

A query for an instant preceding the first entry reverts: the projection does not
cover that instant. `isFinalAsOf` returns false there without reverting.

## Admission

A projection entry becomes part of history only after successful proof
admission.

```
Evidence
 |
Proof Profile
 |
Admission
 |
Projection Entry
```

Admission is atomic — proof consumption, remote-height advancement, entry
admission and gap closure happen together — and final once it happens. Anyone
may relay a proof, and submitting one grants no special rights.

A proof establishes inclusion in accepted remote state, not the truth of the
underlying register.

## Finality

Finality is derived, not manually assigned.

A historical interval becomes final when a later admitted entry closes that
interval. For `t >= firstEntry.effectiveAt`, `isFinalAsOf(t)` is true iff a
strictly later admitted entry exists.

A later entry may confirm the same holder. Such a confirming entry finalises the
preceding interval without the holder having changed, and is the mechanism an
application waiting on historical finality relies on.

### Recorded deviation: isFinalAsOf is not a reorg-depth signal

`isFinalAsOf(tokenId, t)` answers exactly one question: can a later admission
still change the confirmed holder at `t`. It is derived from admitted history
and from nothing else.

The Scope draft posted in the discussion thread (#22) described `isFinalAsOf` as
indicating "whether on-chain reorg-depth makes the recorded historical
projection immutable". That reading is not adopted here. It conflicts with the
ERC body text, where finality is the later-admission rule above, and with the
conclusion reached later in the same thread (#19, #20), where the block-depth
signal was deliberately separated from finality and renamed `REORG_SAFE` so that
a consumer could not read registrar-confirmed finality into a check that only
guarantees EVM chain immutability. Collapsing the two back together is the exact
category error that rename exists to prevent.

Where the thread and the ERC body text disagree, the ERC body text governs.
Reorg depth belongs to the non-normative freshness layer below, never to
`isFinalAsOf`.

## Provisional State

The latest admitted interval remains provisional until later history closes it.
Convergence is an operational property of the registrar: if the registrar stops
issuing entries, recent instants may stay non-final indefinitely. The semantic
layer records both sequences and exposes their alignment; it does not promise
eventual consistency.

## Gap

Settlement gaps are workflow states. They do not define historical truth.

```
Gap closure  != finality
Cancellation != finality
```

Opening a gap does not freeze ERC-721 transfers, and settlement authority is
separate from token ownership. Cancellation ends a contest and settles nothing:
the projection is unchanged and prior provisional history stays provisional.

There is no rejection event. A proof that fails verification never becomes an
admitted entry, and nothing retroactively invalidates an admitted entry. A gap
either closes by admission, closes by cancellation, or stays open — an
indefinitely open gap is a liveness concern, not a veto.

## Uniqueness Scoping

Commitment and registry-reference uniqueness is enforced strictly per token:
within a token's local projection history, a commitment cannot be reused.

There is no global cross-token state. A single off-chain register entry could
back the confirmed-holder claim on two separate tokens, and every per-token
invariant would still hold — a single-token audit does not surface it.
Preventing cross-token replay, and tracking continuity across tokens, belongs to
the registrar or the application; indexers should detect and surface collisions.

## Vocabulary

- open gap / closed gap;
- provisional / final;
- admitted;
- confirmed holder;
- tradeable position (`ownerOf`).

`Pending` / `Locked` / `Confirmed` / `Rejected` / `Released` / `Refunded` are not
protocol states. They read as a rejection event the standard does not define and
MUST NOT name projection or infrastructure states.

## Read-then-act

Temporal queries are point-in-time reads, and a proof can land between the read
and the action depending on it. The recommended integration shape is the
on-chain atomic read — query inside the same transaction as the dependent
action, which closes the window entirely instead of narrowing it. An off-chain
read taken for display must not be cached across transactions, and a contract
acting on one must handle the state having moved by the time it lands.

## Freshness Layer (non-normative)

An optional attestation layer may report whether the registrar's feed is still
current. It sits above the projection and alters nothing in the semantic model
below it.

- **Freshness is a safety property**: a stale attestation must not be mistaken
  for a current one. It is distinct from liveness — the separate claim that the
  registrar eventually issues an entry — which the standard does not make.
- **Reorg safety is not registrar finality.** A classification derived from block
  depth is named `REORG_SAFE`; it measures projection immutability, not
  registrar-asserted finality, and must not be named in a way that invites a
  consumer to read finality that was never asserted.
- **Keys**: an attestation verifies against the key authoritative at its signed
  block, never the current key. A rotated-away key still validates signatures
  made while it was active; a revoked key never does, retroactively. Revocation
  is incident response for a compromised key, so rotation and revocation happen
  atomically rather than being softened by expiry or a timelock.
- **Sequence**: strictly monotonic by one — no gaps, no rewinds. Sequence
  initialisation is a registration-time parameter, never a live-feed admin
  capability, and no native link is kept between a predecessor asset identifier
  and its migrated successor.
- **Interop**: the raw EIP-712 type string is exposed through a view function
  alongside the type hash, so a verifier can reconstruct the struct hash
  independently instead of trusting a published description.
- **Three outcomes stay separate**: reorg-safe, fresh but provisional, and stale.
  The staleness threshold is an asset-specific risk parameter supplied by the
  consumer. An attestation is stale whatever `isFinalAsOf` says; conflating stale
  with provisional makes a silently dead registrar look like ordinary delay.

## Application Boundary

Applications decide how to compose provisional states with economic workflows.

The protocol provides deterministic projection semantics, not a universal
settlement policy. The escrow pattern — quarantine consideration while a gap is
open, release on admission, refund if the gap is cancelled without admission — is
a non-normative reference pattern. Applications composing on non-final state
accept that risk themselves; the projection is guaranteed auditable and
queryable, not universally unwindable. No single unwind rule is mandated,
because one would break either the netting model or the sequential
chain-of-title model.
