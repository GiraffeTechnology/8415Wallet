# 8415Wallet

A reference wallet and client for [ERC-8415 — Asynchronous Register Projection for NFTs](https://github.com/GiraffeTechnology/ERC-8415).

ERC-8415 projects an off-chain register onto an ERC-721 token so that a past instant can resolve to a confirmed holder while the tradeable blockchain position may already have changed. 8415Wallet is designed to expose this distinction to users and applications.

## Why a separate wallet

An ordinary wallet answers:

> Who owns this token now?

For asynchronous registered assets, this is only one part of the answer.

ERC-8415 separates:

- **tradeable position** — `ownerOf`, the current blockchain position;
- **confirmed holder** — the register projection, updated through valid admission.

8415Wallet keeps these sequences separate and never substitutes one for the other.

## Current implementation status (2026-09-25)

PR [#2](https://github.com/GiraffeTechnology/8415Wallet/pull/2) is merged at
`438dd8ecc468d5d7af7f4fe3e19f92be5b887892`. The repository contains the
settlement-aware wallet, Kit components, external-provider signing and legacy
single-trade clearing. The v3.0 linked-wallet requirements below are an
additive development target; this documentation does not claim their delivery.

Remote observation: another execution merged PRs #3–#7 on 2026-09-25; this task
did not perform those merges or waive its earlier PR #3 hold. Review repairs are
being delivered separately and are not automatically merged. The increment adds
independent responsibility contracts and a separately imported experimental
SDK under `src/controls/index.ts`. The implementation pass is complete and its
pre-repair Stage 5F local validation ran: **651/651 Node tests, 49/49 EVM tests,
typecheck and browser build PASS**. This is **not independently audited or
deployed as V3**. Original Sepolia receipts remain historical, not V3 acceptance.
CI, independent review, genuine desktop/mobile UI and actual public-testnet
deployment/transactions remain separately required gates. Browser automation
currently fails before opening a tab; HTTP delivery is not UI verification.
See [the exact local validation report](docs/reports/V3-LOCAL-VALIDATION-20260925.md).
See [development order and remaining work](CONTROL-DEVELOPMENT-STATUS.md).
CI and merging are now assigned to Claude Code; this task continues development
and stage PR delivery. Local regression results do not replace CI or acceptance.
Stage 5E repairs the two subsequent P1 review findings: exact signed native
payment reservations must exist before forwarding and are consumed atomically;
the current settlement authority is revalidated before a token moves. Unfunded
responsibility, completion and conditional return remain independent of payment.
This changes the experimental consent ABI; old control deployments/acceptances
are not silently reused. See [Stage 5E](docs/stages/STAGE-5E-PAYMENT-RESERVATION.md).

Stage 5F adds canonical-block, read-only payment lookup by leg ID, including
unused reservations and payments whose responsibility leg has detached. It adds
no signing or contract authority. See [Stage 5F](docs/stages/STAGE-5F-PAYMENT-OBSERVATION.md).

## Implemented

### ERC-8415 reading and interpretation

- ERC-8415 projection reader interface;
- temporal queries:
  - `entryAsOf`;
  - `holderAsOf`;
  - `isFinalAsOf`;
- append-only entry history reading;
- ownership discovery from ERC-721 transfer history;
- dual sequence presentation:
  - tradeable position;
  - confirmed register holder.

### Settlement capability

The wallet now contains transaction construction support for:

- `beginSettlement`;
- `finalizeSettlement`;
- `cancelSettlement`.

Signing is separated from wallet logic through an external EIP-1193 provider interface. The wallet does not hold private keys.

### Legacy single-trade clearing

`ProjectionEscrow` provides a reference clearing pattern:

- asset locking;
- payment locking;
- release after projection confirmation;
- refund path after unsuccessful confirmation.

This is an application pattern, not part of ERC-8415 itself. It holds both the
token and payment for one trade. It remains available in standalone mode; its
tests do not demonstrate the buyer-held token and linked obligations required
by v3.0.

### Asynchronous registry simulation

The repository contains an asynchronous registrar simulation demonstrating:

- chain position moving ahead of registration;
- registration latency;
- backlog accumulation;
- finality arriving after later entries close previous intervals.


## Two supported modes

v3.0 extends the original PRD. The original 8415Wallet remains the foundation,
with its readers, temporal queries, dual histories, disclosure, protocol
transactions and existing clearing path preserved.

- **Standalone:** use the wallet independently against its configured chain,
  with optional Kit-backed reads. ArtFi, Oracle and a linked-wallet network
  are not prerequisites.
- **Linked:** independent condition/execution controls connect unresolved
  obligations while the same token moves downstream. Each leg has accepted
  conditions and scoped return authority; payment is a separate optional adapter.

Responsibility does **not** depend on escrow, a payment record or a positive
amount. For A → B → C → D, controls preserve accepted conditions while the
active tail grows and completed heads detach. In a funded scenario, a separate
adapter reserves B's payment for A, C's for B and D's for C; it cannot authorize
or revive responsibility. Completed legs remain in history.

### Completion rule — CP-01 resolved

A leg S→B is commercially complete when **both current owner and admitted
register holder are at B or a later verified position in the same token's
accepted transfer chain**. Position is verified leg/occurrence order, never
a numeric comparison of wallet addresses.

For A→B→C→D with owner=D and holder=B, the control completes and detaches AB.
If payment exists, settle it separately to A without reviving AB on payment
failure. BC and CD may still be unresolved. With holder=C, AB and BC
can complete in prefix order. Neither observation needs to equal the other,
and the token does not have to return to B before AB completes.

After AB completes, a later callback cannot cross that boundary and return
the token to A. A's completed obligation cannot be revived. ERC
`isFinalAsOf(tokenId, t)` still reports its own temporal finality: a latest
interval may remain provisional while the commercial leg is complete.
The wallet displays both facts accurately.

CP-01 is resolved as a requirement; implementation and acceptance are still
required. Do not reintroduce an extra confirming entry or a historical
finality query as an unstated payment-release prerequisite.

### Callback and refunds

For an accepted failure of unresolved AB, return requests propagate B→C→D;
actual token returns proceed D→C→B→A. In funded scenarios, each leg's payment
adapter refunds its original payer after the required return. If AB has already detached, a failure of BC
stops at B and cannot involve A.

The recipient must accept an executable, scoped return mechanism and all
still-active inherited conditions. A notification or revocable allowance is
not proof of enforceable recall. Duplicate actions, interrupted returns and
completion-versus-callback races must preserve one responsibility outcome.
Optional payment adapters separately protect each leg's principal.
The wallet executes accepted terms without choosing a discretionary
remedy or rewriting ERC history.

See [PRD §9](docs/ERC-8415-Wallet-PRD.md#9-v30-increment--standalone-and-linked-use)
for the model, owner-confirmed rule, boundaries and W-01–W-21 acceptance cases.

The current increment provides a read-only sequence view and an independent
experimental responsibility kernel in `src/controls/`. The kernel prepares
forwarding, prefix completion and reverse-hop callback transitions without any
escrow import. Its output is explicitly `UNCOMMITTED_PROPOSAL`, not permission,
a receipt or an executed transfer. Authenticated atomic account enforcement is
not shipped yet. See [implementation scope](docs/LINKED-MODE-IMPLEMENTATION.md)
and [security/audit gates](docs/RESPONSIBILITY-CONTROLS-SECURITY.md).

## Verification status

Current repository evidence includes:

- unit and integration tests for wallet semantics;
- Hardhat EVM validation against ERC-8415 reference implementations;
- documented Sepolia engineering validation run (2026-09-19).

The recorded Sepolia run remains a real engineering test of its historical
candidate, not a production deployment or v3.0 linked-chain acceptance.

For the PR #2 merge, the exact code tree was tested on CTYun Linux using Node
v22.23.3 and v24.21.0: each passed typecheck, 513/513 unit tests, 14/14 EVM
tests and the reference client. [CI evidence](https://github.com/GiraffeTechnology/8415Wallet/pull/2#issuecomment-5822071405)
records the commits and distinguishes those executed checks from the
GitHub-hosted jobs blocked before startup by the account billing/spending-limit
condition. No existing failed Actions result has been relabelled as a pass.

Remaining validation areas:

- independent institutional registrar integration;
- production signer and custody environment;
- complete browser/mobile wallet UX;
- production operational deployment.

## ERC-8415 Kit and Oracle integration boundary

The intended ecosystem architecture is:

```
Application
    |
Oracle
    |
ERC8415-Kit
    |
ERC-8415
```

8415Wallet is an independent wallet product.

It may consume ERC-8415 projection data through an application/infrastructure integration layer, but it is not part of ArtFi and does not embed Oracle business logic.

The current repository contains the wallet-side adapter direction; production Kit integration remains an integration stage rather than a completed production dependency.

## Architecture principle

```
User
 |
8415Wallet
 |
ERC-8415 reader / transaction layer
 |
ERC-8415 conforming asset
```

The wallet intentionally does not collapse protocol signals:

- finality is not freshness;
- a pending registration gap is not rejection;
- blockchain ownership is not automatically confirmed registration.

## What it does not do

8415Wallet is a protocol client, not an authority system.

It does not:

- adjudicate legal title;
- decide remedies between parties;
- provide investment or compliance ratings;
- write directly into the register projection;
- override register history.

It reports protocol facts. Applications and users decide how those facts are used.

## Known development gaps

1. Error classification and network failure handling hardening.
2. Security review of transaction and identity boundaries.
3. Production-grade Kit integration verification.
4. Browser/mobile wallet UX.
5. Institutional registrar and source integration.
6. Production execution of the independent responsibility controls: verified
   consent, protected recipient/account enforcement, monotonic detachment,
   callback recovery and optional per-leg payment adapters. The local kernel
   and legacy escrow tests alone do not establish these features.

These are delivery items. They do not change ERC-8415 semantics.

Keep the existing Stage 0–5 numbering and completed foundation work. Stage 4
adds the linked model, protected forwarding, head detachment, callback/refund
and recovery; Stage 5 demonstrates the integrated account/backend, independent
delayed registrar, testnet and real desktop/mobile journey. Full acceptance
requires standalone use plus W-01–W-21 and the independent security-audit gates
at their stated execution levels.

## Documents

- [AGENTS.md](AGENTS.md) — engineering rules and semantic boundaries;
- [docs/ERC-8415-Wallet-PRD.md](docs/ERC-8415-Wallet-PRD.md) — product requirements;
- [docs/STAGE-DELIVERY.md](docs/STAGE-DELIVERY.md) — delivery evidence and verification history;
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — backend integration and conformance requirements.

The ERC specification remains the source of truth.

## Development

Latest integrated Stage 5H plus archive-review repair: **692/692 Node and 51/51 EVM**, plus
typecheck/browser emit. Stage 5G adds verified detached history; Stage 5H repairs
the pruned-origin read crash. Earlier 651/49 and 656/49 totals are separate
historical runs, not the current count. The prior 686/51 batch predates the six
untrusted-array regressions. These are not release acceptance.

V3 is the exclusive active development priority until delivery. Development
regressions continue after demonstrated repairs; **Claude Code owns CI and PR
merging**. Do not treat a stage PR or a progress report as release acceptance.
PRs #3-#9 have merged; PRs #10/#11 cover later development and review repairs.
Stage 5B contains an additive browser workflow in `web/`
and an experimental `src/browser.ts` entry, including standalone reads without
a responsibility deployment. See
[Stage 5B](docs/stages/STAGE-5B-WALLET-WORKFLOWS.md) for exact remaining gates.
The Stage 5C implementation pass is source-complete and the first local batch
has passed after recorded repairs. Release validation remains incomplete. See
[Stage 5C](docs/stages/STAGE-5C-VALIDATION-TOOLING.md) and the
[review/validation handoff](docs/V3-REVIEW-AND-VALIDATION.md).

Stage 5F's late-reorg repair has local 656 Node / 49 EVM evidence. The additive
[Stage 5G](docs/stages/STAGE-5G-DETACHED-HISTORY.md) reads public detached-leg
exports and checks the entire ordered prefix against the pinned chain commitment,
not a register's claimed success. It adds no signing or transaction permissions.
Independent review, new V3 public-testnet transactions and genuine desktop/mobile
journeys remain distinct open gates; the previous Sepolia test is not relabelled.

Node 22.18 or newer.

```sh
npm ci
npm run verify
npm run wallet:browser:build
npm run wallet
```
