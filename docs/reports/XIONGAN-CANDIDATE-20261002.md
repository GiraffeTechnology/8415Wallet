# Xiongan candidate development evidence — 2026-10-02

Base: `97f4dbc6e7437b6f013b47d0fc7782cf916b9d77`, Git tree
`c7592c786ad4a1e26a22e2164a2ef7481c2731e8`. All 282 source blobs were restored
through the authorized repository connector and individually checked against
Git blob SHA-1 before changes. This is a local managed-Linux source candidate.

## Implemented

- Xiongan branding and the existing ERC-8415 UI retained.
- Separate external-EOA companion for Ethereum/Base ETH and ERC-721/ERC-1155,
  with genuine-provider owner confirmation as the only signing route.
- Public agent request parsing, full immutable review binding and no autonomous
  signer, credential, raw-signature import, token approval or standing grant.
- Durable pre-send journal, explicit recovery/speed-up/cancellation proof,
  canonical receipt/effect verification and truthful unknown-outcome handling.
- Shared page operation lock and connection-generation revocation across both UI
  surfaces; same-account switch-back cannot resurrect old in-flight review.

## Observed validation

- Baseline Node: **760/760** passed.
- Updated TypeScript check and browser compilation: **passed**.
- Updated Node: **785/785**, zero failed/skipped/cancelled.
- Package build and isolated install: **V2 8/8, V3 9/9** passed; no npm publication.
- Local EVM: **59 passing**. No contract changes in this candidate.
- Separate AI-assisted code/test review reproduced and retested eight concerns:
  late reorg terminal clearing, matching/replacement hash recovery, review-field
  tampering, NFT event provenance, switch-away-and-back races, cross-panel
  concurrency, safely releasing a provably unsent reservation, and a TypeScript
  narrowing error. All were fixed; the final focused reviewer run was **42/42**.
  This is source/development review, not an independent external audit.

## Browser execution blocker

A reproducible Playwright/Chromium synthetic-provider script is included as
`scripts/controls/xiongan-ui-smoke.cjs`. Its intended desktop and narrow-viewport
journeys cover prepare/no-send, account-switch revocation, the cross-panel lock,
submission/reload/reconcile and unknown/restart/no-resend/recovery.

**It has not passed in this workspace.** Chromium startup fails before opening
any page because its local process socket is refused by the runtime
(`socket() failed: Operation not permitted`), including the approved unsandboxed
retry with writable XDG directories. The available cloud browser also refuses the
loopback URL with `net::ERR_BLOCKED_BY_CLIENT`. No local screenshots, IndexedDB browser journey, genuine MetaMask result or
physical-device pass is claimed. The same synthetic journey is added to the
existing CI matrix using the hosted runner's installed Chrome/Chromium, without
changing its runner selection or schedule. Exact-head CI is checked separately. Deterministic
DOM/provider regressions are labelled as such and do not replace these tests.

Historical public-chain and genuine read-only MetaMask evidence stays attributed
to its original revisions. The earlier genuine UI unknown outcome is not claimed
resolved: its original instance/wallet journal is not available in this workspace.
No user secrets, persistent credentials, real assets or public-chain signing/
broadcast were involved. Local EVM tests use only their existing deterministic
fixture signers. PR merging, CI ownership, deployment and
npm publication remain with the release owner.
