# V3 review and unified validation handoff

Source closure is not release acceptance. Source was UNTESTED at initial freeze;
latest local validation passed 630 Node and 30 EVM cases after review repairs.
Fresh independent review, genuine UI and public-testnet gates remain open.
Preserve historical Sepolia receipts; do not relabel them as V3.

Remote PRs #3–#7 were externally merged during this task's validation. This task
did not perform those merges. Repairs now need a separate PR; no release approval
or authorization to merge further work follows from that remote state.

## Exact review surface

- Four independent contracts in `contracts/controls/`; the controller has no
  funds and never writes projection history. Token accounts enforce protected
  transfers. The optional native payment adapter is a separate liability ledger.
- `src/controls/` fixed actions, typed consent/disclosure, coherent snapshots,
  nonce-bound public recovery and canonical receipt matching.
- `web/` and `src/browser.ts` genuine provider UI. Public local state is not an
  authorization source; no signature is logged, rendered or persisted.
- `scripts/controls/` testnet runner and loopback static server. Test-only
  adversarial contracts are excluded from the deployment artifact allowlist.

Independent review must cover accepted upstream scope, EOA/1271 replay domains,
immutable account alternate paths, repeated occurrence binding, callback versus
completion races, completed-prefix permanence, reverse-hop atomicity, original
payer isolation, failed/reentrant payout, hostile/malformed RPC, journal crash and
CAS behavior, UI terms/signature scope, and proxy/registrar trust assumptions.
The accepted registrar's association of an entry with a chain occurrence is an
explicit trust boundary, not cryptographic proof of off-chain legal identity.

## Unified sequence

1. Record exact commit/tree, dependency lock, compiler and runtime versions.
2. Run typecheck, all Node cases, browser emit and all legacy/new EVM cases.
   A failed case stays failed until a recorded repair and regression rerun.
3. Check the browser bundle has no Node-only runtime dependency. Perform real
   standalone and linked desktop/mobile interactions, not API-only substitutes.
4. Obtain independent review of the exact execution boundary and resolve its
   findings before real control execution. Do not self-certify an audit.
5. With isolated test-only signing roles, deploy the frozen contracts to Sepolia
   or Hoodi, run the real same-token and funded/unfunded journeys, bind every
   receipt/readback to that deployment and retain public evidence only.
6. Produce W-01–W-21 results individually, with NOT_RUN/BLOCKED where appropriate;
   never infer them from package integrity, source presence or script exit alone.
7. Only then evaluate CI and merge the stage PRs in dependency order. PR #3's
   explicit hold remains until the user changes it; passing CI alone is not that
   authorization. *(The user lifted that hold on 2026-09-25 and the five PRs
   merged in dependency order; steps 4-6 remain outstanding, and the batch
   record below says which.)*

No deployment wallet is generated or imported by this handoff. Missing genuine
provider, signing capability, funding, review or brand inputs must be reported
precisely while other authorized validation continues. Do not fabricate evidence.

---

## First unified validation batch — 2026-09-25

Historical independent Node 22 batch below is preserved from remote commit
8dacaf472a830461ed8b0301fcae8307bf9c767a. It predates the nonce/durability repairs.
The later Windows Node 24 batch has 628 Node / 30 EVM passes after incorporating
its extended-journey wiring. These reports cover different exact trees, not one
fresh dual-runtime matrix; the latest source still needs a Node 22 rerun.

Run against the exact trees below, on this repository's own CI pipeline
definitions, executed locally. **GitHub Actions did not run any of it**, for
the reason recorded under "CI could not be evaluated".

### 1. Exact surface

| Branch | PR | Head | Node cases | EVM cases |
| --- | --- | --- | --- | --- |
| `docs/v3-standalone-linked-completion` | #3 | `bc99ff0` | 607 | 14 |
| `feat/stage4b-independent-controls` | #4 | `a7cd45a` | 607 | 14 |
| `feat/stage5a-control-sdk` | #5 | `d3d428b` | 607 | 14 |
| `feat/stage5b-wallet-workflows` | #6 | `10fbfad` | 615 | 14 |
| `feat/stage5c-validation-tooling` | #7 | `da1c9d2` + this batch | 622 | 29 |

Runtime: Node v22.22.2, npm lockfile v3, `npm ci` clean on every tree.
Compiler: TypeScript 5.9 via `tsc --noEmit`; Hardhat selects solc 0.8.26.
The separately installed npm solc package is 0.8.37, not the configured compiler.

### 2. Every step of each branch's own `ci.yml`, run locally

Each branch was checked against **its own** workflow, not the tip's — only
Stage 5C's pipeline carries the `Browser entry` step, and the earlier branches
neither define `wallet:browser:build` nor need it.

| Branch | typecheck | node tests | browser entry | EVM | reference client |
| --- | --- | --- | --- | --- | --- |
| #3 | pass | pass | n/a | pass | pass |
| #4 | pass | pass | n/a | pass | pass |
| #5 | pass | pass | n/a | pass | pass |
| #6 | pass | pass | n/a | pass | pass |
| #7 | pass | pass | pass | pass | pass |

The emitted browser bundle contains no `node:` import, so step 3's
"no Node-only runtime dependency" check holds. Its **real desktop and mobile
interaction half is NOT_RUN** — no browser is driven here.

Only the Node 22 leg of the `[22, 24]` matrix was executed here: this
environment has one runtime. The Node 24 leg was executed separately and is
recorded in `docs/reports/V3-LOCAL-VALIDATION-20260925.md` (v24.19.0, 622
Node cases). Between the two reports the matrix is covered; neither report
covers both legs on its own.

### 3. Finding, fixed in this batch

`runExtendedJourneys` was exported from the scenario kit and called only by
`scripts/controls/public-testnet.cjs`. That runner has never been executed, so
locally the journeys were dead code and every EVM run this repository has made
skipped them. Among them was the **only linked-mode observation of W-03** — a
real open gap is ordinary lag and never blocks an accepted forward — together
with the tail-extension, repeated-occurrence and callback-race journeys.

They pass as written; only the wiring was missing. The local EVM suite now
calls them, and with the SDK-to-EVM cases added alongside it the suite stands
at **29 cases**.

### 4. W-01 – W-21, individually

Local EVM evidence is local-level evidence. It is not testnet evidence and not
UI evidence, and nothing below should be read as either.

| ID | Local EVM | Testnet | UI |
| --- | --- | --- | --- |
| W-01 | pass | NOT_RUN | NOT_RUN |
| W-02 | pass | NOT_RUN | NOT_RUN |
| W-03 | pass (wired in this batch) | NOT_RUN | NOT_RUN |
| W-04 | pass | NOT_RUN | NOT_RUN |
| W-05 | pass | NOT_RUN | NOT_RUN |
| W-06 | pass | NOT_RUN | NOT_RUN |
| W-07 | pass | NOT_RUN | NOT_RUN |
| W-08 | pass | NOT_RUN | NOT_RUN |
| W-09 | pass | NOT_RUN | NOT_RUN |
| W-10 | pass | NOT_RUN | NOT_RUN |
| W-11 | pass | NOT_RUN | NOT_RUN |
| W-12 | pass | NOT_RUN | NOT_RUN |
| W-13 | pass | NOT_RUN | NOT_RUN |
| W-14 | pass | NOT_RUN | NOT_RUN |
| W-15 | pass | NOT_RUN | NOT_RUN |
| W-16 | pass | NOT_RUN | NOT_RUN |
| W-17 | pass | NOT_RUN | NOT_RUN |
| W-18 | pass | NOT_RUN | NOT_RUN |
| W-19 | pass | NOT_RUN | NOT_RUN |
| W-20 | **BLOCKED** | **BLOCKED** | **BLOCKED** |
| W-21 | pass | NOT_RUN | NOT_RUN |

W-20 asks for one *deployed* same-token multi-wallet journey. It cannot be
satisfied locally by construction, and no signing key, funded account or
provider exists in this environment.

### 5. CI could not be evaluated

Every GitHub Actions run in this repository since 2026-09-19 has failed, and
they fail without running anything:

```
job      verify (22) / verify (24)
steps    []            (no step ever started)
runner   runner_id=0, runner_name=""
elapsed  3-4 seconds
```

This is not the branches. A push to `main` — the already-merged, previously
green tree — fails identically (`438dd8ec`, 3s, `runner_id=0`), while runs on
2026-09-18 and earlier succeeded on that same pipeline.

What is established is the negative: no runner is assigned, no step runs, and
the same outcome reaches a tree that was green a week ago, so **a code failure
is ruled out**. The cause is not established. Job logs return `BlobNotFound`
for every affected run, so the runner-side reason could not be read, and this
report does not name one.

So handoff step 7's "evaluate CI" is **BLOCKED**, and the table in section 2 is
what stands in its place: the same pipeline, the same commands, run here.

### 6. Still outstanding, unchanged by this batch

- independent security audit of the exact kernel, adapters, verifiers and
  deployed contracts (step 4) — **NOT_RUN**. Local suites are preparation;
  this batch does not self-certify one;
- public-testnet deployment and real transactions (step 5) — **NOT_RUN**,
  no signing capability here;
- real desktop and mobile journeys (step 3) — **NOT_RUN**;
- W-20 — **BLOCKED**, as above;
- a GitHub Actions run on any of it — **BLOCKED**, as above.

Status remains `SOURCE_COMPLETE_PENDING_UNIFIED_VALIDATION` for everything
above. This batch raises local execution evidence from "untested" to "the full
local pipeline passes on all five trees"; it does not make anything a
release PASS.
