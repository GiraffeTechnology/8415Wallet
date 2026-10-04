# V3 beta package

Date: 2026-10-03. Status: **BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED**.

This document describes the **SDK/CLI package**, not the V3 DApp. The browser
delivery, source manifest and deployment instructions are in
[BETA-DAPP-DELIVERY.md](BETA-DAPP-DELIVERY.md).

Public-chain execution, physical-device journeys and W-20 are collected during
Beta testing. They are not prerequisites for producing the functional Beta.
Independent security review remains uncompleted and is required before general
release. The normal DApp deployment and agent-request inputs reject unsupported
control chains; direct SDK use must apply its own network policy. There is no
global SDK mainnet lock.

`npm run pack:v3` builds it; `npm run pack:v3:verify` proves it installs and
works from outside this repository, and that it tells the truth about itself.

## Beta assurance boundary

The V2 SDK contains the narrower standalone reading and transaction surface. V3 adds the responsibility control
kernel. Authenticated atomic adapters and alternate-path protection exist as
development source, but the exact integration has not completed independent
security and release acceptance. Publishing V3 as a release would overstate it,
so it is published as a Beta instead: installable, integrable and
reviewable, with its status carried in the artifact name, the package
metadata, and a notice the build refuses to omit.

The build enforces this rather than trusting it. `PACKAGE-V3.md` must contain
`NOT_INDEPENDENTLY_AUDITED`, and the build fails if that notice ever claims the
package is audited, security-approved, production-ready or release-accepted.

## What it contains

| Measure | Value |
| --- | --- |
| Artifact | `8415wallet-3.0.0-beta.tgz` |
| Entries / unpacked bytes | Measured in `dist/v3-package-manifest.json` per build |
| Source modules compiled | Derived from the entry-point import graph per build |
| Runtime dependencies | 0 |
| Node | >= 22.18.0 |

Four entry points: the root reading client plus linked chain views,
`/controls`, `/controls/node-store`, and `/browser`. Plus the CLI reference
client as a bin. The consumer integration-boundary contract, PRD, integration guide, controls
security note, the V3 review record and the Stage 5J report travel inside the
tarball, because the boundaries they state are part of what an integrator is
building against.

## What the verifier proves

Nine checks, all from a temporary directory outside the repository with the
tarball installed as a dependency:

1. it installs;
2. it pulls in no runtime dependency;
3. every documented export resolves after install — the compiled-output check
   that catches the packaging failure a `.ts` tarball hides;
4. the control surface is complete and ships the authority disclosure;
5. the browser entry ships;
6. the Node operation store ships;
7. the CLI runs from the installed package;
8. it presents itself as a pre-release: the version carries a pre-release tag,
   the description says it is not independently audited, and the notice ships.
   The check tests the claim rather than a spelling, so a bare release version
   such as `3.0.0` fails it;
9. the consumer boundary contract ships with all required sections, while
   development instructions and coordination records are absent.

The build validates the actual `npm pack` file inventory; the install verifier
independently checks installed paths. A missing required document or included
development-instruction file refuses verification. This is a packaging boundary,
not a substitute for security review or a test result.

## Gates this package does not close

- complete exact-candidate public-testnet evidence (historical real runs remain valid history);
- W-20, one deployed same-token multi-wallet journey;
- independent security review of the exact tree, now including the loopback
  signer added in Stage 5J;
- journeys on a physical device. Stage 5J's browser evidence is a real browser
  at an emulated phone viewport, which is not a handset.

The V2 SDK remains the surface without the linked control kernel. Both SDKs
and both DApps can be built from the same exact source commit.
