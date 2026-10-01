# V3 development closure and CI handoff

Date: 2026-10-01. **SOURCE_SCOPE_CLOSED_PENDING_CI_REVIEW**.
Validation of this integrated tree: **NOT_TESTED**.
Release status: **NOT_RELEASE_ACCEPTED / NOT_INDEPENDENTLY_AUDITED**.

This freezes the existing PRD Stage 0–5 development scope for CI and review.
It does not create another product stage or assert that unexecuted code is
correct. Any demonstrated CI, review or functional defect reopens its affected
development row. Historical tests and real Sepolia activity remain valid for
their exact versions, not for this new integration.

## Source mapping

| Requirement | Actual implementation surface | Closure boundary |
| --- | --- | --- |
| Stages 0–1: typed protocol, conformance, chain/Kit binding | `src/sdk/port.ts`, `conformance.ts`, `identity.ts`, `src/adapters/rpc/`, `src/adapters/kit/` | Immutable IDs, independent conformance and backend disagreement paths; no protocol redesign |
| Stages 2–3: position/holder, temporal results, two histories | `src/wallet/assetView.ts`, `temporalQuery.ts`, `history.ts`, `ownershipHistory.ts`, renderers | Raw temporal finality remains distinct from alignment, contest and freshness |
| Standalone usability and disclosure | `registration.ts`, `acquisition.ts`, `riskSurfaces.ts`, `collisions.ts`, `auditTrail.ts`, `web/app.mjs` | Cross-token UI and bounded scan added; registry locators are never resolved |
| Stage 4: original protocol transactions | `src/sdk/transactions.ts`, `src/wallet/session.ts`, `src/adapters/signing/eip1193Signer.ts` | SDK builders/revalidation/external signing preserved; reference-page readers are not a generic transaction composer |
| Existing standalone clearing | `contracts/escrow/ProjectionEscrow.sol`, `src/sdk/escrow.ts`, `src/wallet/escrowView.ts` | Preserved legacy single-trade path, not authority for linked responsibility |
| Stage 5: optional freshness/Kit | `src/wallet/freshness.ts`, `src/sdk/watchtower.ts`, RPC/Kit adapters and CLI | Optional integration; unavailable data never becomes protocol finality |
| W-01–W-03, W-13–W-15, W-21: accepted protected forwarding | `ControlledWallet.sol`, `ControlSignatures.sol`, `ResponsibilityController.sol`, `authorization.ts`, `consentReview.ts`, `accounts.ts` | Independent of payment; exact EIP-712 domain, inherited terms and account paths |
| W-04–W-06, W-08–W-09, W-19, W-22–W-24: completion/window/history | Controller `completeThrough`, `detached`, `legAt`, `inheritedHash`; `detachedHistory.ts`, `view.ts` | Both owner and admitted occurrence; permanent prefix; 128 unresolved-leg window; committed off-chain archive |
| W-07, W-10–W-12, W-17–W-18: conditional return and recovery | Controller `beginReturn`, `returnHop`, `closeSequence`; `session.ts`, `execution.ts`, `operationJournal.ts`, file/IndexedDB stores | Accepted authority, atomic bounded hops, canonical receipt reconciliation and no automatic resend |
| Funded variants | `NativeResponsibilityPayments.sol`, `NativePaymentsFactory.sol`, `payments.ts` | Exact signed reservation, segregated allocation/refund/payout; failure cannot revive responsibility |
| W-16: malformed/unavailable evidence | `authorization.ts`, `execution.ts`, `client.ts`, strict archive/journal parsers | Fail-closed paths remain; caller flags are not verified evidence |
| Functional linked UI | `web/index.html`, `app.mjs`, `public-store.mjs`, `src/browser.ts` | Fixed actions, consent review, journal recovery and account/chain invalidation; visual redesign deferred |
| W-20 and public-chain/device validation tooling | `scripts/controls/public-testnet.cjs`, `scenario-kit.cjs`, `detach-observation.cjs`, `browser-journey.cjs` | Source tooling only; real execution and device evidence remain acceptance work |
| Package delivery | `scripts/package/build-v3.mjs`, `verify-install-v3.mjs`, `v3-document-contract.mjs` | Consumer boundaries shipped; development instructions excluded; install verification still required |

The source mapping is based on code paths, not a claim that every runtime
outcome has passed. The independent-review scope in V3-REVIEW-AND-VALIDATION.md
and the registrar/proxy/provider trust assumptions remain in force.

## Integrated development inputs

Base main: `ab21f61916b3836c615379c9787b6ea9ace8c88a`.

| PR | Exact input commit | Included work |
| --- | --- | --- |
| #30 | `043f8b7c2669d240e3c22c5efd8e738010e4df91` | Public inclusion budget and hash-bound detach observations |
| #31 | `ad9c8aff10f9124f858a230f059a1456bef0beec` | Connection/review invalidation, including late asynchronous results |
| #32 | `7ecce7b79036f8cd35dcc1f4494d7bae0c579012` | Consumer package boundary and inventory checks |
| #33 | `db7cbfa052323bdd17a361d6bce81cf241a5bc59` | Live selected-account/network checks before standalone send |
| #34 | `83b2bb80290ad30bf72a95a59b93bbc4d834521b` | Cross-token functional UI, bounded scan and regression sources |

Closure delta: capture standalone wire fields before asynchronous provider
reads, with one additional mutation regression; update current documentation
without rewriting historical evidence. The release PR binds the final commit
and tree externally, avoiding a self-referential commit hash in this file.

## CI and merge instructions

1. Review the single integrated closure PR against the base above. Do not also
   merge the five overlapping input branches; retain their history and close
   them as superseded only after the integration is accepted. If main changes,
   rebase/integrate explicitly and record the resulting new commit/tree.
2. The development commits use `[skip ci]`; the CI owner must deliberately
   enable a fresh run using a CI-eligible reviewed commit. Do not call an absent
   or skipped run green and do not disable workflow/security checks.
3. Run clean locked install, typecheck, Node suites, browser compilation, EVM
   suites and reference client per the existing Node 22/24 CI matrix. Add actual
   V2/V3 package build and external install verification to the release checks;
   these are not all covered by the current ci.yml. Preserve failures and repair
   them, not their assertions. No production version bump or audit-label removal.
4. Integration-specific focus: detach observations, signer account/wire binding,
   browser connection and collision boundaries, holder views and package document
   inventory. New cases in this closure were authored but not executed here.
5. CI/merge actions belong to the release owner. Managed CTYun/SIN Linux hosts
   own deployment and functional testing; this development handoff performed no
   tests or deployment. No Windows runtime substitute is permitted. Existing CI
   configuration was not changed by this handoff.
6. Merge only the reviewed, passing exact candidate. CI failure or review
   finding is a repair request, not permission to label source or release PASS.

## What still separates a merge from product delivery

- Final-tree independent security review and closure of required findings.
- Fresh Linux deployed standalone/linked testnet journeys, funded and unfunded,
  W-01–W-24 reconciliation, receipt/readback/recovery and package evidence.
- Genuine functional desktop/mobile wallet journeys; emulation and handler
  fixtures are not physical-device or wallet-session acceptance.
- Environment, version and source-bound delivery report with no keys, secrets,
  raw signatures, private endpoints or infrastructure identifiers.

These are validation/release gates, not invented new features. A finding may
require further code repair. CI and merging alone never satisfy them.
