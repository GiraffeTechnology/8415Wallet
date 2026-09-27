# 8415Wallet — published test evidence

Status: **LOCAL_VALIDATION_PASS / NOT_INDEPENDENTLY_AUDITED / NO_PUBLIC_CHAIN_RUN_YET**

Date: 2026-09-27 · Source commit `59a3349f977be0d331d1d2386db97bf783f0611c`

This document publishes what has actually been measured. It is not a release
announcement, not an audit result, and not acceptance. Where something has not
been established, it says so and says why.

The wallet's source is not published yet. That is a timing choice, not a
licensing one — the repository is CC0-1.0 and is intended for public domain
release. Section 7 explains exactly which claims below a third party can check
today without source, and which must wait.

---

## 1. What binds this document to a specific tree

These are commitments, not content. They disclose nothing about the source, and
they let anyone verify — once the source is released — that it is the same code
that produced every figure below. The commit named is the one whose code was
measured; this document itself was added to the repository afterwards, so a
later checkout will show a different head.

| Binding | Value |
| --- | --- |
| Source commit | `59a3349f977be0d331d1d2386db97bf783f0611c` |
| Source tree | `e31b622021f218aa6fda1e4162a67d55de4febba` |
| Compiler | solc 0.8.26, viaIR, optimizer enabled, 200 runs |

Compiled artifact digests (sha256 of the build artifact, with its byte length):

| Contract | sha256 | bytes |
| --- | --- | --- |
| RegisterProjectionReference | `a7bce770acfc8bb9889fec297090a1b7e3fcc0954b039ac773098690f2f6f94c` | 70,185 |
| ResponsibilityController | `d8e857653703f9126af5f4e1c5d43909bc34500955cc4dd4541210908f0c353e` | 110,677 |
| NativeResponsibilityPayments | `598c276ab32895df42853dc30023e5b68e40c44eb67f4383d5ff088327262755` | 36,427 |
| NativePaymentsFactory | `8aa0691738ca762d4f0e515b549435e29c97e3b6a35f61e02280018f032eda6c` | 25,486 |
| ControlledWallet | `af3b31310c7c586d558abca637e557069b108e073600eb2d40345a89ee7344ad` | 9,423 |

The adapter's own code is unchanged; its digest moved because it imports the
controller, so the metadata appended to its bytecode covers a source that
changed. Its byte length is identical, which is what that looks like.

---

## 2. Local validation

Run against the real reference projection and the real controller, on Node
22.18+. No mock projection, no time warp, no skipped assertion, no hard-coded
pass count.

| Suite | Result |
| --- | --- |
| TypeScript typecheck | pass |
| Node test suite | **700 / 700**, 108 suites |
| EVM suite (deployed contracts) | **59 / 59** |
| Browser bundle emit + syntax | pass |
| V2 package install checks | **7 / 7** |
| V3 candidate install checks | **9 / 9** |

These are local runs. GitHub Actions has not executed in this repository since
2026-09-19 — every run fails within seconds with no runner assigned, including
pushes to the default branch — so "CI is green" is not a claim this project
makes, and these tables stand in its place, labelled as local.

---

## 3. AB detachment, observed parameter by parameter

The responsibility chain is a rolling window. When a leg's owner and confirmed
holder have both moved past it, the leg detaches, and the window rolls forward.
Two shapes were observed, because they end differently.

`holder` is `holderAsOf` at the current entry's `effectiveAt`. `final@now` is
`isFinalAsOf(now)`, taken from the contract and never recomputed. `appended`
counts every occurrence ever made; `active` counts only what is still open.

### 3.1 Continuous — A→B→C→D still trading while AB completes

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
| extended-DB | B | B | 2 | 2 | – | false | **4** | **4** | 1 | **3** | 1 | B |

Final occurrence state: occurrence 0 **detached**; occurrences 1 (B→C), 2
(C→D) and 3 (D→B) live.

### 3.2 AB only — one leg, detaching to an empty window

| state | ownerOf | holder | entries | ver | gap | final@now | cursor | appended | completed | active | detached | boundary |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| opened | A | A | 1 | 1 | – | false | 0 | 0 | 0 | 0 | 0 | A |
| forwarded-AB | B | A | 1 | 1 | – | false | 1 | 1 | 0 | 1 | 0 | A |
| admitted-B | B | **B** | 2 | 2 | – | false | 1 | 1 | 0 | 1 | 0 | A |
| **detached-AB** | B | B | 2 | 2 | – | false | 1 | 1 | **1** | **0** | **1** | **B** |
| forwarded-BC | C | B | 2 | 2 | – | false | **2** | **2** | 1 | 1 | 1 | B |

Final occurrence state: occurrence 0 **detached**; occurrence 1 (B→C) live.

### 3.3 What the two tables establish

- **The position runs ahead of the register, and that is the normal state.** In
  3.1 the token reached D while the register still confirmed A. Registration is
  serial; no standard removes that lag.
- **Detachment changes nothing on the ERC side.** At `detached-AB` in both
  shapes, `ownerOf` is unchanged, the entry count is unchanged, and
  `isFinalAsOf` is unchanged. Detachment admits no entry and moves no token.
- **Only unresolved legs occupy the window.** After detaching, `appended` keeps
  counting past the detached leg while `active` does not. Detached history
  never counts against the bound, which is what lets the chain keep extending.
- **A detached occurrence still answers, and answers *detached*** — never a
  zeroed record. The boundary moves A→B: a return now stops at B and can never
  cross AB.
- **Detaching the only leg empties the window (`active` 0).** That is not the
  same as a chain rolling to a successor — there is no successor. An empty
  window is not a closed one: the next trade opens occurrence 1 on the same
  sequence.
- **The three signals stay separate.** While the gap was open, the entry count,
  version, confirmed holder and active-leg count were all unchanged;
  cancellation settled nothing and the prior entry stayed in force. There is no
  rejection state, because the protocol defines none.
- **Commercial completion is not temporal finality.** `final@now` is false
  throughout — an instant at or after the latest entry's `effectiveAt` is
  provisional until a later entry is admitted — and completion never waited
  on it.

---

## 4. Public-path rehearsal

The public journey runner was executed end to end against a **loopback
rehearsal chain**, not a public network. It is recorded here because it
establishes that the path runs; it establishes nothing about a public chain.

| Measure | Value |
| --- | --- |
| Evidence events | 311 |
| Transactions | 131 |
| Total gas | 35,300,869 |
| Largest single transaction | 5,212,144 |
| Journeys with assertions completed | 9 |
| Recorded detachment states | 14 |
| SDK observations recorded | 6 |
| Read-only refusals asserted | 16 |
| Evidence chain head | `df5805e0696a5d24…` |
| Verdict | `CORE_JOURNEYS_EXECUTED_NOT_FULL_V3_ACCEPTANCE` |

Each record is chained to its predecessor by hash, so the journal cannot be
edited after the fact without breaking the chain. The two detachment shapes in
section 3 are part of this run: the same observations execute on a public chain
from the same code, which is what makes those tables reproducible later.

No reorg, no independent block producer, no real fee market and no third-party
node were involved. See section 6.

---

## 5. Browser journey

The served reference UI was driven in a real Chromium (141.0.7390.37) at two
profiles, through an injected EIP-1193 provider — the same contract a wallet
extension offers, so the page has no network path to the chain.

| Measure | desktop | mobile |
| --- | --- | --- |
| Viewport | 1440 × 900 | 390 × 844, touch |
| Recorded steps | 14 | 14 |
| Screenshots | 14 | 14 |
| Page requests leaving the origin | **0** | **0** |
| Requests made by the page | 50 | 50 |
| Provider calls through the injected wallet | 354 | 354 |
| Console errors / failed resources | 0 | 0 |

Two of the steps are product assertions rather than smoke checks:

- an instant **before the first entry** must be *explained* — the page renders
  "the projection does not cover this instant", and a bare refusal code fails
  the journey;
- a public detached-history export, built from the chain's own detachment logs,
  is verified **in the page** against the canonical on-chain commitment, which
  must appear in the rendered output.

An emulated phone viewport is not a physical handset. The journal records
`physicalDevice: false`.

---

## 6. Delivery packages

| Package | Artifact | sha256 | Entries | Size | Runtime deps |
| --- | --- | --- | --- | --- | --- |
| V2 product | `8415wallet-0.1.0.tgz` | `d483920bdd25fb5c9d30099d6f5122c72d971a6d4f88c29bc5406eec32524aee` | 122 | 556 KB | 0 |
| V3 candidate | `8415wallet-0.1.0-v3-candidate.tgz` | `a1ed1003d0418d14791834f9ef50172eb31fba91cff50fcc09b3ffe84642e303` | 159 | 678 KB | 0 |

V2 ships the standalone reading client and excludes the unaudited control
kernel — the build derives its file list from the import graph and fails if the
graph ever reaches that surface. V3 ships the control surface and is a
**candidate**, not a release: its status is carried in the artifact name, the
package metadata and a notice the build refuses to omit or contradict.

---

## 7. What is *not* established

Stated plainly, because the absence of a claim is itself evidence a reader
needs.

- **No public-chain run.** Nothing above was executed on Sepolia, Hoodi or any
  public network. Section 4 is a loopback rehearsal.
- **W-20 is not met** — one deployed, same-token, multi-wallet journey. It
  cannot be satisfied locally by construction.
- **No independent security review** of the kernel, adapters, verifiers,
  deployed contracts, recovery or the optional payment integration. Local
  suites are preparation, never an audit.
- **No physical device journey.** Section 5 is a real browser at an emulated
  viewport.
- **No CI.** See section 2.
- **The controller has 6,265 bytes of deployment headroom**, 74.5% of the
  EIP-170 limit. It had 689 until the payment adapter was moved behind a
  factory pinned by code hash; the account's creation bytecode is still
  embedded, deliberately, because only the controller may create an account
  that names it. A test fails before the remaining headroom is spent.
  `docs/reports/CONTRACT-SIZE-BUDGET.md` has the measurements and the reasoning.
- **Semantic claims are not third-party verifiable while the source is
  withheld.** Anything in sections 2, 3 and 5 that describes *what the code
  does* rests on this project's own report. Sections 1 and 6 are the parts
  designed to be checked later, and a public-chain run (section 8) would be
  checkable immediately by anyone.

---

## 8. What a public run will add, and how to check it

When the public run happens, this document gains a section that anyone can
verify without asking this project for anything: chain id, contract addresses,
deployed runtime code hashes, every transaction hash and block number, gas per
transaction, and the advertised ERC-165 interface identifiers — `0x6309e170`
for `IRegisterProjection` and `0xf4a7d71b` for `IProjectionSettlement`.

The two tables in section 3 are then **independently reproducible**: with the
addresses and block numbers, anyone can replay the same reads at the same
blocks against a public node and obtain the same parameter set. That is the
point of publishing them in this form.

---

## 9. Licence and source release

The repository is CC0-1.0. Withholding the source is a timing choice, not a
licensing one. Section 1 exists so that when the source is released, this
document can be checked against it rather than taken on trust.
