# ERC-8415 Native Infrastructure Kit (NIK)
# Stage Delivery PRD v2.2

## Product Definition

ERC-8415 Native Infrastructure Kit is ERC-8415-aligned projection infrastructure
consumed by Oracle and application ecosystems.

Positioning:

**Stripe API + AWS SDK for ERC-8415 native assets**

The Kit enables Oracle and application layers to keep three things apart:

- fast on-chain execution — the tradeable position;
- the register's own confirmed-holder sequence, which lags it;
- the historical query semantics that say which one is being asked about, and
  whether that answer can still move.

Settlement itself is composed by the application. The Kit supplies the record
and the queries over it.

---

# Product Boundary

The Kit is NOT the wallet and NOT the application layer.

Product relationship:

```text
Wallet / Application
        |
        v
Oracle
        |
        v
ERC-8415 Native Infrastructure Kit
        |
        v
Institutional Registry
```

Oracle is responsible for connecting ERC-8415 infrastructure with vertical
applications such as ArtFi.

---

# Core Principle

ERC-8415 records an asynchronous projection. It is a faithful record and audit
trail across the asynchronous boundary — a mirror, not a tribunal.

```text
Fast Execution Layer
        |
        v
ERC-8415 Projection Layer
        |
        v
Institutional Verification Layer
```

The Kit provides the infrastructure required for Oracle to consume projection
state and compose its own settlement workflow. It records both sequences and
exposes their alignment at an instant; it does not guarantee that they converge.
If the registrar stops issuing entries, recent instants may stay non-final
indefinitely.

---

# Vocabulary Rule

Infrastructure state names come from the protocol only:

- **open gap / closed gap** — whether a change is in flight (`openGapOf`,
  `openedAt`);
- **provisional / final** — whether a historical answer could still change
  (`isFinalAsOf`);
- **admitted** — an entry accepted through a verified proof.

`Pending` / `Locked` / `Confirmed` / `Rejected` / `Released` / `Refunded` are
not protocol states. They MUST NOT name Kit states, events or API status values.
An application escrow may use such names inside its own state machine, and must
document them as application state rather than projection state.

There is no rejection event. A proof that fails verification never becomes an
admitted entry, and no mechanism retroactively invalidates an admitted entry.

---

# Core Modules

## 1. Projection Infrastructure

Existing capability.

Provides:

- register identity;
- projection entries;
- temporal history;
- holderAsOf(t);
- entryAsOf(t);
- isFinalAsOf(t);
- currentEntry / entryAt / entryCount.

Requirements: append-only history, consecutive versions, strictly increasing
effectiveAt, commitment linkage, per-token commitment uniqueness. Cross-token
uniqueness of commitments and registry references is out of scope and belongs to
the registrar or the application.

---

## 2. Settlement Composition Engine

Infrastructure capability consumed by Oracle. It exposes gap primitives and
leaves the economic workflow to the consumer.

Projection lifecycle:

```text
gap opened          openGapOf == true from openedAt
  |
  |-- entry admitted  -> gap closed by admission; history extended
  |
  `-- gap cancelled   -> gap closed without admission; projection unchanged
```

Admission is atomic: proof consumption, remote-height advancement, entry
admission and gap closure succeed or fail together.

Mandatory invariants:

```text
cancellation    != finality
gap closure     != finality
proof verified  != finality
timeout expiry  != finality
```

Opening a gap does not freeze ERC-721 transfers. Settlement authority is
separate from token ownership. Anyone may relay a proof, and submitting one
grants no special rights.

The Settlement Composition Engine MUST NOT redefine ERC-8415 semantics.

---

## 3. SDK Layer

Provides infrastructure SDKs for Oracle and application developers.

Includes:

- projection queries;
- gap and admission interaction;
- conformance discovery against the frozen ERC-165 identifiers;
- integration interfaces.

The SDK MUST surface the three signals separately — final/provisional, open
gap/closed gap, and the optional freshness classification — and MUST NOT collapse
them into a single status.

---

## 4. Institutional Infrastructure

Existing capability.

Includes:

- registry APIs;
- verification engine;
- institutional controls;
- audit records;
- tenant/security controls.

The chain carries a record commitment and a registry-reference locator, never the
register's contents. Resolving a reference requires entitlement to read the
register.

---

# Existing Development Preservation

Completed modules are preserved.

KEEP:

- registry layer;
- verification engine;
- ERC-8415 adapter;
- SDK foundation;
- institutional controls;
- production infrastructure.

Evolution:

```text
Registry Infrastructure
        +
Projection and Gap Primitives
        +
Oracle Integration Layer

becomes

ERC-8415 Native Infrastructure Kit
```

---

# Delivery Stages

This is the only stage scheme in the repository.

## Stage 0
Foundation.

Create the repository structure, the development environment definition and the
initial CI configuration:

```
api/
engine/
adapters/
contracts/
console/
sdk/
tests/
docker/
```

## Stage 1
ERC-8415 Projection Core.

Storage for register identity, append-only projection entries and gap records.
Temporal routes:

```
GET  /projection/{id}/entry/as-of/{instant}
GET  /projection/{id}/holder/as-of/{instant}
GET  /projection/{id}/finality/as-of/{instant}
GET  /projection/{id}/entries
POST /projection/{id}/admission
```

Admission endpoints MUST validate schema, version, `effectiveAt`, commitment
linkage and proof profile before append-only persistence. No endpoint mutates or
deletes an admitted entry, and none writes finality.

Acceptance: admission and temporal queries run against a mock adapter without a
live chain, including the exact later-admission finality rule and a confirming
entry that finalises an interval without changing the holder.

## Stage 2
Verification Engine.

Proof verification behind a proof-profile interface, admission evaluation, and
derived finality queries. There is no mutable asset state machine; the only
transition is evidence becoming an entry:

```
Evidence -> Proof Profile -> Admission Evaluation -> Projection Entry
```

Invalid admissions must fail: non-consecutive versions, equal or backwards
`effectiveAt`, broken commitment linkage, failed proofs and replays.

## Stage 3
ERC-8415 Adapter.

Delivery status: partial. The requirements below remain the acceptance target;
see `DELIVERY-EVIDENCE.md` for implemented components and missing chain evidence.

Solidity contracts, an Ethereum adapter and transaction monitoring, exposing the
frozen interfaces and nothing beyond them:

```
holderAsOf() / entryAsOf() / isFinalAsOf()
currentEntry() / entryAt() / entryCount()
registerId() / openGapOf() / openedAt()
beginSettlement() / finalizeSettlement() / cancelSettlement()
```

No freeze, revoke, override or rollback function exists.

## Stage 4
Settlement Composition Engine MVP.

Gap primitives: open a gap, close it by admission, close it by cancellation.
Prove that cancellation, gap closure, proof verification and timeout expiry each
fail to produce finality.

## Stage 5
Oracle/Application SDK.

JavaScript and Python SDKs exposing `entryAsOf`, `holderAsOf` and `isFinalAsOf`
directly, preserving provisional/final semantics in the return types, with
examples and API documentation.

## Stage 6
Institutional Console.

Login, projection overview showing the tradeable position and the confirmed
holder as separate facts, an audit timeline over admitted entries and gap
transitions, and permission management. Users read a projection without Web3
knowledge. The console MUST NOT merge the three signals into one status, and
MUST NOT display register contents.

## Stage 7
Production Infrastructure.

API key management, RBAC, multi-tenancy, monitoring and audit export.

---

# MVP Acceptance

MVP demonstrates:

```text
Application
 |
Oracle
 |
ERC-8415 Native Infrastructure Kit
 |
Admitted Projection Entry
 |
Temporal Query Result
```

Required:

- gap open, admission and cancellation paths, with cancellation leaving
  provisional history provisional;
- unit tests at 80% coverage or above;
- an integration run of `register identity -> verify proof -> admit entry ->
  temporal query -> gap open and close -> audit`;
- a chain test of `deploy contract -> execute transaction -> verify event`;
- projection consumption through temporal queries;
- finality-aware workflow, where finality is read from `isFinalAsOf` and never
  recomputed or inferred;
- a confirming entry that finalises an interval without changing the holder;
- executable tests;
- evidence.

Negative cases are part of acceptance: a token whose `ownerOf` and confirmed
holder diverge; a closed gap over a non-final instant; a cancelled settlement;
and an instant preceding the first entry.

---

# Integration Requirements

`holderAsOf`, `isFinalAsOf` and `openGapOf` are point-in-time reads, and a proof
can land between the read and the dependent action. The recommended integration
shape is the on-chain atomic read — query in the same transaction as the action,
which closes the window rather than narrowing it. An off-chain read taken for
display MUST NOT be cached across transactions.

The escrow pattern — quarantine consideration while a gap is open, release on
admission, refund if the gap is cancelled without admission — is a non-normative
reference pattern. Applications composing on non-final state accept that risk
themselves; no single unwind rule is mandated, because one would break either the
netting model or the sequential chain-of-title model.

---

# Non Goals

Not included:

- replacing ERC-8415 semantics;
- wallet frontend product;
- ArtFi application logic;
- custody authority;
- legal registry authority;
- adjudication of legal title, entitlement or compliance outcomes;
- prescribed remedy — cancellation policy, escrow, timeouts, refunds, downstream
  unwinding;
- cross-token uniqueness enforcement;
- generic NFT marketplace.

---

# Definition of Done

Delivery requires:

- implementation;
- tests;
- documentation;
- deployment evidence;
- Oracle/application integration validation.

Code completion alone does not equal delivery completion.
