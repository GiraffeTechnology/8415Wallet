# 8415wallet AGENTS.md

## Historical authorized Beta installation scope (2026-10-05)

This dated record covers the supplied October 4 archive, not the current
application build or a new deployment authorization. Current authentication,
registration and recovery requirements below remain in force.

ArtFi control was assigned the client-requested ArtFi iteration, installation and
joint testing using the Beta package on branch `delivery/install-handoff-20261004`.
The exact source is `1f4a9ae6dd5b8b062ab4f903920cf4b39d158e36`; the archive SHA256
is `df5058bec9d5c12cffb9ca10cd7ea991e46696207a50f3d2ccf47ac375681838`.
Preserve the immutable supplied archive and verify its nested manifests before
installation. That client instruction, rather than artifact publication alone,
covered production-like Beta installation and joint testing in the approved
CTYun/SIN Linux environment. Windows is a source/report workstation only.

Historical Charity completion, full V3 acceptance and independent general-release
audit are not prerequisites for this Beta installation and testing. Remaining
genuine-wallet, public-testnet, device and W-20 observations are collected and
reported separately; no old result is inherited by a changed source or origin.
Public entry navigation may skip login, but protected assets/history still require
verified login. Mainnet/real-value testing, credential disclosure, unknown-outcome
replay and changes to shared or other-task services remain outside that historical scope.
GitHub writes remain English only.

## Product Boundary

8415wallet is a general-purpose application-layer wallet compatible with
existing wallet and asset standards, with native ERC-8415 asynchronous register
projection support. Native ERC-8415 features are additive and do not make the
product exclusive to ERC-8415 assets. Report implemented and tested standards
separately from the broader compatibility requirement.

It is NOT:

- an ERC-3643 wallet clone;
- a marketplace, order book or matching engine;
- a replacement for ERC-8415 protocol semantics;
- an adjudicator of legal title, entitlement or remedy.

For its native ERC-8415 surface, the wallet MUST consume ERC-8415 semantics,
not redefine them. Existing-standard asset flows retain their own interfaces
and must not be required to advertise ERC-8415 support.

Product identity is **8415wallet**; its UI platform domain is
**8415wallet.com**. **Xiongan is a V2 tenant**, not a separate product.
V2 and V3 are versioned DApp Beta deliveries mapped to the retained v2.2
foundation and additive v3.0 requirements. SDK packages are separate integration
artifacts and do not replace either DApp. Keep the exact implemented/tested
standard and provider matrix in `docs/STANDARDS-COMPATIBILITY.md`, without
claiming exhaustive validation of all existing standards.

The product supports both standalone and linked use. v3.0 is an additive
iteration on the original wallet: retain its readers, views, transaction path
and legacy single-trade clearing. Linked mode adds the agreed responsibility
chain in PRD §9; it must not make ArtFi, Oracle or another wallet mandatory for
standalone use.

---

## Account login methods (owner update, 2026-10-04)

Support password, authenticator TOTP (Google Authenticator/FreeOTP), local
private-key challenge signing and configured hardware CA challenge signing.
Email OTP is not a login method. The owner update on 2026-10-06 adds reset-only
email verification from noreply@8415wallet.com together with a previously reserved
security answer. Preserve fresh independent identity verification and existing
authenticator/recovery proof; email or security answers never replace them. Read
`docs/AUTH-RECOVERY.md` and `docs/EMAIL-REGISTRATION.md`. Email ownership OTP
is also required for registration; it remains unavailable as a login method. Never suggest provider connection authenticates an account.

Read `docs/ACCOUNT-AUTHENTICATION.md` and `docs/WALLET-LOGIN.md` before changing
authentication. Passwords/TOTP require server verification and revocable sessions;
client-only flags cannot implement them. Preserve origin/tenant/account/chain
binding, CSRF, one-use challenge/TOTP/recovery handling, encrypted credential
state and enrollment confirmation. Operator and hardware-CA bindings come from independently verified configuration.
Ordinary self-registration requires verified email ownership plus an exact
origin/tenant/account/chain/purpose-bound EOA control proof; it grants no operator,
tenant-management, private-record or transaction authority. Registration email is
mandatory, unique per tenant, and verified before account creation. Existing
accounts retain login access to complete verified-email migration without rekeying
or discarding credentials. See `docs/EMAIL-REGISTRATION.md`. Never trust
client-supplied identity flags or create an account from email OTP alone. No private key,
seed phrase, hardware PIN, live authenticator seed or production store key belongs
in source, logs, artifacts or a page form. Synthetic test credentials are local
fixtures only. No production provisioning, deployment or transaction is implied.

The local wallet route retains EOA/ERC-1271 support; the new server wallet route
currently verifies EOA signatures. Hardware CA integration uses a defined bridge
plus certificate-chain/purpose/time/revocation verification, not a checkbox or
universal-driver claim. Record device/middleware acceptance separately. Login and
transaction approval remain separate. Keep the immutable earlier release ZIP
unchanged; updated artifacts need their own exact source identity after review.

---

## Interface localization (owner update, 2026-10-04)

Keep the compact native six-choice language dropdown (owner update, 2026-10-06), with English as the default and
locale IDs en, zh-Hans, zh-Hant, fr, es and ja. The owner explicitly authorizes
multilingual fixed UI catalogs and selector labels; identifiers, engineering
documents and PR prose remain English. Token names, descriptions and metadata
must retain their original decoded source strings and be safely rendered as text.
Do not translate signed terms, raw transaction values, addresses or protocol
identifiers. Switching language must not reload, reauthenticate, reset consent,
repeat provider requests, or send transactions. Native labels and first-party
protocol explanations belong to the presentation layer; keep finality, contest,
freshness and legal identity distinct. See docs/UI-LOCALIZATION.md. The approved
Figma layout is a separate implementation scope; localization alone is not a
claim that it was ported. Preserve the original logo; do not redraw it.

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

For a conforming ERC-8415 asset, the wallet MUST read and render distinctly:

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
   The chain is a rolling window: the bound is on legs UNRESOLVED at once (128),
   and detached history never counts against it, so ABCDEF… keeps extending as
   AB, BC… detach behind it. Any limit MUST be enforced identically off chain and
   on chain — a kernel that permits a leg the controller refuses hands the
   execution adapter a proposal that cannot execute.

   A completed leg is NOT carried on chain. Its state is deleted at detachment;
   the chain keeps only a constant-size commitment over every leg that has left
   and the fact that it terminated, and the record goes to the off-chain register
   via its detachment log, to be asked for and checked against that commitment.
   This is the same division the projection uses — a commitment and a locator on
   chain, the record at the register — so chain state stays proportional to what
   is still open. A read of a detached occurrence MUST say it detached, never
   return a zeroed record. The opening account and the boundary — whoever the
   last detached leg handed the token to — still resolve, because the window
   starts there and a return stops there.

   Digests over inherited conditions MUST cover the active window only, or each
   forward costs gas in proportion to every forward before it, and a detached
   leg MUST NOT be nameable again as a completion target or return boundary.
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
    enforcement and W-01–W-24 evidence remain required.
11. Develop responsibility controls as an independent module, not a wrapper
    around escrow. The local kernel is an uncommitted proposal generator, not
    verified consent or account enforcement. Its input facts are a trust boundary.
    Signing/execution must use authenticated atomic adapters and alternate-path
    protection. Functional Beta testing on authorized testnets may collect the
    remaining deployment and device evidence. Independent security review remains
    required before general release; it is not a reason to mislabel or withhold
    a functional-testing Beta package.

---

## Development Rules

Current delivery interpretation: V2/V3 are functional-testing DApp Betas with
separate exact-source manifests and evidence levels. Genuine-wallet testnet,
physical-device and W-20 observations are collected during deployment testing;
independent security review remains uncompleted before general release. The
dated records below preserve historical evidence and must not override the
current source-bound CI result or turn uncollected Beta observations into a
claim that no testable Beta exists.

### Current user-directed order (2026-09-25, merge phase)

The development phase and its merge hold are over. On user instruction the
first unified validation batch was run and the five stacked PRs were merged
into `main` in dependency order: #3, #4, #5, #6, #7. The `[skip ci]` and
draft-PR arrangement, and the instruction to keep PR #3 unmerged, applied to
that phase and no longer describe this repository.

The merges were performed from this session on the user's instruction, between
08:46:46Z and 08:49:21Z. A parallel execution observed them as external and
recorded that it had not authorized them, which was accurate from where it stood.
Either way the practice it drew is the right one and is now the rule: further
repairs go in their own pull request. Do not force-revert or rewrite `main`.

What the batch established, and what it did not, is in
`docs/V3-REVIEW-AND-VALIDATION.md` and
`docs/reports/V3-LOCAL-VALIDATION-20260925.md`. In short: the full local
pipeline passes on `main` — typecheck, 622 Node cases, 29 EVM cases, the
browser entry and the reference client, across both matrix legs between the
two reports — and W-01 through W-19 and W-21 have local EVM evidence.

Nothing above is release acceptance, and the source status is unchanged:
`SOURCE_COMPLETE_PENDING_UNIFIED_VALIDATION`. Still required, none of it
satisfied by a merge:

- **actual public-testnet deployment and real transactions.** Historical
  Sepolia activity and the earlier 607/607 Node and 14/14 legacy EVM results
  do not validate the control code;
- **independent security review** of the exact kernel, adapters, verifiers,
  deployed contracts, recovery and optional payment integration. Local
  suites are preparation, never an audit;
- **genuine desktop and mobile journeys.** CLI and HTTP checks are transport
  checks, not UI evidence;
- **W-20**, which asks for one deployed same-token multi-wallet journey and
  cannot be satisfied locally by construction.

The September 25 batch had no executed GitHub Actions evidence at that time.
That historical runner blockage is superseded by the exact-source October 4
merged-main run `37209416014`, with successful Node 22 and Node 24 jobs.
Future changes require their own exact-head result; retain the old local tables
as historical local evidence, not a current repository-wide CI prohibition.

Do not describe the new source as never tested, and do not describe it as
released. Do not invent results, and do not infer that development is complete
from the presence of source files.

### Latest execution ownership and Stage 5E

2026-09-26 direct user priority: continue V3 until delivered; reject unrelated
inserted work until V3 completion. Reports and intermediate passes are not
completion. The release owner retains CI/merge ownership; this task develops, repairs
and runs development regressions without starting unrelated project tasks.

The release owner owns CI and PR merging. This task continues V3 development,
defect repairs, development regressions and stage PR delivery; do not provision
runners, change CI scheduling or merge PRs from this task. Preserve merged
rolling-window/pruning and recovery work. No report is completion.

Stage 5E adds signed pre-forward payment reservations and atomic current
settlement-authority revalidation. ForwardConsent has 16 fields, including
paymentAdapter and paymentAmount. Do not silently reuse the 14-field ABI or
an old deployment. Optional payment never authorizes completion or return.
Fresh integrated regression, independent security review and genuine public
testnet/UI acceptance remain distinct gates.

Stage 5F adds a read-only payment observation by leg ID for unused reservations
and detached legs. Do not infer responsibility completion from payment state.
Historical pre-repair Stage 5F totals were 651 Node / 49 EVM; genuine public-chain/UI acceptance and
independent review remain separate. CI and merging stay with the release owner.

Stage 5F's later canonicality repair passed 656 Node / 49 EVM locally. Stage 5G
adds a read-only verifier for a register's detached-leg export against the exact
on-chain count/commitment and live boundary. Never call a partial archive,
untrusted `verified` field or commitment-only copy verified history; never use
history verification as transaction authority or ERC temporal finality.

Stage 5H preserves raw origin-holder projection observations after prefix
detachment without manufacturing a completion proof outside the live window.
Latest integrated Stage 5I local results: 693 Node / 53 EVM,
typecheck/browser emit pass. Import records by validated indexed copy, never
input-controlled map/iterator/species. The prior 651/49, 656/49, 686/50 and 686/51
batches, plus the archive repair's 692/51, are historical and not current counts.
Stage 5I's shared local/testnet journey calls the actual SDK view, archive and
payment observers at three phases. Text-render evidence is never genuine UI
evidence.

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
linked-mode W-01–W-24 scenarios, including real selected account enforcement,
independent controls without escrow, optional funded flows, detachment,
callback/refund, recovery, independent security audit and deployed UI evidence. Report
baseline, local EVM, public-testnet and UI results separately; a documentation
change or one completed leg is not full acceptance.

## Served origin and stored state

A web origin is scheme, host **and port**, so the address a wallet is served on
is part of its origin. Every IndexedDB operation journal belongs to that origin,
including an operation left in `outcome-unknown` — the record the recovery path
exists to find. Moving a served wallet to a different scheme, host or port
strands them all.

Settle the serving address before a deployment carries genuine wallet use, and
treat a later move as data loss rather than as a configuration change.

Which address a given environment serves on, and which ports are reserved there,
is deployment configuration rather than a product requirement; it belongs in that
environment's deployment document.

## Delivery archive inventory (2026-10-05)

Historical and candidate archives are indexed in
[releases/2026-10-05-delivery-archive/README.md](releases/2026-10-05-delivery-archive/README.md).
Preserve each archive's exact bytes, source identity, checksums and candidate label.
The October 4 installation handoff remains an immutable historical artifact;
use the separately approved current package for any new deployment.
GitHub-safe mirrors differ from their private originals; do not interchange hashes.
Archive publication does not establish deployment, current-head CI, genuine-device
acceptance or a general release. Existing security and deployment rules remain in force.

## Current public installation-asset policy

Keep this repository public for investor review. Follow [the installation-asset publication policy](docs/INSTALLATION-ASSET-PUBLICATION.md): publish only verified product artifacts, retain all required notices, exclude private operations and tenant data, and verify uploaded checksums. The designated source/delivery owner maintains licensing documentation; deployment controllers must not create conflicting license terms or change visibility. Merge pull requests only after exact required CI is fully successful.
