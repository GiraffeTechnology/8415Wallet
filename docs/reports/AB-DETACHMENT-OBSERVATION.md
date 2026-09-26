# AB detachment, observed parameter by parameter

Date: 2026-09-26. Source: `scripts/controls/detach-observation.cjs`, run against
the real reference projection and the real controller on a local EVM.

Two shapes are observed, because they end differently:

- **continuous** — A→B→C→D are still trading while AB completes behind them.
  Detaching AB leaves BC and CD, so the chain becomes BCD…;
- **ab-only** — a single leg. Detaching AB leaves an empty window, not a
  shorter chain.

Every state records the same parameters, so what detachment changes — and what
it deliberately leaves alone — is read from the table rather than argued.

`holder` is `holderAsOf` at the current entry's `effectiveAt`. `final@now` is
`isFinalAsOf(now)`, taken from the contract and never recomputed.

## Continuous: A→B→C→D, AB detaches, the chain keeps rolling

| state | ownerOf | holder | entries | ver | gap | final@now | cursor | appended | completed | active | detached | boundary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opened | A | A | 1 | 1 | – | false | 0 | 0 | 0 | 0 | 0 | A |
| forwarded-AB | B | A | 1 | 1 | – | false | 1 | 1 | 0 | 1 | 0 | A |
| forwarded-BC | C | A | 1 | 1 | – | false | 2 | 2 | 0 | 2 | 0 | A |
| forwarded-ABCD | D | A | 1 | 1 | – | false | 3 | 3 | 0 | 3 | 0 | A |
| gap-open | D | A | 1 | 1 | **open** | false | 3 | 3 | 0 | 3 | 0 | A |
| gap-cancelled | D | A | 1 | 1 | – | false | 3 | 3 | 0 | 3 | 0 | A |
| admitted-B | D | **B** | 2 | 2 | – | false | 3 | 3 | 0 | 3 | 0 | A |
| **detached-AB** | D | B | 2 | 2 | – | false | 3 | 3 | **1** | **2** | **1** | **B** |
| extended-DB-after-detach | B | B | 2 | 2 | – | false | **4** | **4** | 1 | **3** | 1 | B |

What each transition actually did:

- **forwarded-AB → forwarded-ABCD.** The position ran three hops ahead while
  the register still confirmed A. That lag is the normal state, not a fault:
  registration is serial, and `ownerOf` and the confirmed holder are two facts.
- **gap-open.** A gap opens. `entries`, `ver` and `holder` do not move, and
  neither does `active`: a contest is not a responsibility state, and it is not
  finality.
- **gap-cancelled.** Cancellation ends the contest and settles nothing. The
  entry count and version are unchanged and the prior entry stays in force.
  There is no rejection here, because the protocol defines none.
- **admitted-B.** One entry is admitted. The confirmed holder moves A→B,
  `entries` 1→2. `completed` stays 0: an admission is not a completion.
- **detached-AB.** `completed` 0→1, `active` 3→2, `detached` 0→1, the
  commitment becomes non-zero, and the boundary moves A→B — a return now stops
  at B and can never cross AB. Nothing on the ERC side moves: `ownerOf` is
  still D, `entries` is still 2, `final@now` is unchanged. Occurrence 0 reads
  as *detached*, never as a zeroed record.
- **extended-DB-after-detach.** D forwards back to B. `appended` 3→4 — absolute
  occurrence numbers keep counting past a detached leg — while `active` is 3,
  not 4, because detached history never occupies a slot. The boundary stays B.

Detached leg record at the end: occurrence 0 detached; live legs are
occurrences 1 (B→C), 2 (C→D) and 3 (D→B).

## AB only: one leg, detaching to an empty window

| state | ownerOf | holder | entries | ver | gap | final@now | cursor | appended | completed | active | detached | boundary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opened | A | A | 1 | 1 | – | false | 0 | 0 | 0 | 0 | 0 | A |
| forwarded-AB | B | A | 1 | 1 | – | false | 1 | 1 | 0 | 1 | 0 | A |
| admitted-B | B | **B** | 2 | 2 | – | false | 1 | 1 | 0 | 1 | 0 | A |
| **detached-AB** | B | B | 2 | 2 | – | false | 1 | 1 | **1** | **0** | **1** | **B** |
| forwarded-BC-after-empty | C | B | 2 | 2 | – | false | **2** | **2** | 1 | 1 | 1 | B |

- **admitted-B.** Here `ownerOf` and the confirmed holder agree, because
  nothing ran ahead. Agreement between the two records is still not verified
  identity of the underlying right, and the wallet says so wherever it reports
  it.
- **detached-AB.** `active` 1→0. The window is *empty*, which is not the same
  as a chain that became BCDEF…: there is no successor to roll to. `completed`
  and `detached` are 1, the commitment is non-zero, the boundary is B, and the
  token did not move — `ownerOf` is still B and `entries` is still 2.
- **forwarded-BC-after-empty.** An empty window is not a closed one. B sells
  on, and the new leg is occurrence 1 on the same sequence: `appended` 1→2,
  `active` 0→1, `detached` still 1.

## What stays true in both shapes

- detachment admits no entry, moves no token, and changes no ERC answer;
- `final@now` is false throughout, and that is correct: an instant at or after
  the latest entry's `effectiveAt` is provisional until a later entry is
  admitted. Commercial completion and protocol temporal finality are distinct,
  and completion never waited for finality here;
- the bound is on legs unresolved at once. `appended` counts every occurrence
  ever made; `active` counts only what is still open; `detached` never counts
  against the window;
- a detached occurrence still answers, and answers *detached*. The boundary —
  whoever the last detached leg handed the token to — still resolves, because
  the window starts there and a return stops there.

## Status

These are local-EVM results against the real contracts. The same two shapes run
on a public testnet from the same code — `runDetachObservations` is part of the
public runner — and have not yet been executed there, because the five actor
accounts are unfunded. A public run records the identical parameter set, and
this document should be reissued with those figures beside these.
