# V3 simulated security audit — 2026-10-02

## Verdict and scope

**SIMULATED_AUDIT_COMPLETE_WITH_RESIDUAL_FINDINGS.** This is a source review and reproducible adversarial test exercise, not a third-party audit, formal verification, production authorization or full product acceptance. No CI or PR merge was performed for this exercise.

All execution used managed CTYun Linux. Windows was used only for source and report editing. No production asset or mainnet transaction was involved.

- Initial reviewed revision: `06282ed491d550dc8262ca4d7612a6ce0deadb2a`, tree `e963b8ccf319acf21a3085092247ffa3d90d3b64`.
- Patched dependency revision: `3ab44cb2e2d7f911a782fe62a29a1f91aa630737`, tree `d55188d379599bee2e204d4eb78ab0481c14c1a4`.
- Changes after the initial revision are limited to package overrides and the regenerated lockfile. Contracts, client semantics and application source are unchanged.

## Method and observed coverage

Read the controller, controlled wallet, signature verifier, optional payment adapter, durable operation journal and browser/static-server boundaries. Executed the security-relevant existing regression suites rather than inferring success from code inspection.

| Threat | Evidence exercised | Observed result |
| --- | --- | --- |
| Unauthorized movement, alternate approval/operator/execute surfaces | Controlled account and EVM adversarial cases | Rejected |
| Wrong domain, expired or forged consent, stale revision and nonce replay | Responsibility and consent cases | Rejected |
| Reentrancy, duplicate refund and recipient payout failure | Real local EVM adversarial contracts | State remains terminal; no duplicate payout |
| Failed return hop or projection identity substitution | Fault-injection EVM cases | Atomic rollback and identity refusal |
| Completion crossing a detached boundary | Prefix completion and return journeys | Completed prefix is not recalled |
| Pending/unknown outcome and cross-tab journal races | Session, durable journal and connection suites | No automatic resend; uncertain state retained |
| Corrupt receipt/history, changed runtime pin and reorganization | Receipt, detached-history and observation suites | Refused or explicitly non-final |
| Provider quantity mismatch | Six new pending-nonce regressions | Safe integers accepted only for pending nonce; invalid values rejected |

Initial security subset: **274/274 tests**, zero failed/skipped. EVM security subset: **24 passing**. These are selected regression results, not a claim that every possible exploit or adversarial input has been examined.

After dependency remediation: **760/760 full unit tests**, **59 EVM tests**, typecheck, browser build, V3 package build and isolated package verification all exited zero. Dependencies were installed from the new lockfile with `npm ci --ignore-scripts`; application tests then ran explicitly. This was not CI.

## Findings and disposition

### SA-01 — Development dependency advisories

Initial npm advisory query: **19 affected dependency entries**: 7 high, 2 moderate, 10 low, no critical. Counts include transitive/metavulnerability propagation; they are not 19 demonstrated application exploits.

Pinned patched versions through explicit overrides: adm-zip 0.6.1, tmp 0.2.7, serialize-javascript 7.1.2, undici 6.29.0, diff 8.0.3, cookie 0.7.2 and uuid 11.1.1. The lockfile was regenerated, installed and regression tested; no forced Hardhat major migration or compiler downgrade was used.

Post-remediation advisory query: **0 critical, 0 high, 0 moderate, 9 low**. The remaining entries propagate from elliptic through the development Hardhat/ethers-v5 dependency graph. The [elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84) lists no patched version and describes a signing implementation risk. This finding remains open, not waived or silently suppressed.

Containment: development tooling is test-only and must not handle production signing material. The shipped V3 package has an empty runtime dependency map; its verified import closure does not import elliptic, ethers or Hardhat. The browser uses the genuine wallet provider, not a bundled elliptic signer. This reduces exposure but does not make the development dependency safe for arbitrary secret-bearing use. A separately reviewed tooling migration remains appropriate before any production signing environment uses this graph.

### SA-02 — Genuine-provider pending nonce interoperability

MetaMask 13.50.0 returned numeric `0` for the pending nonce, while the client expected hexadecimal text. The original request failed before signing. The narrow fix accepts non-negative safe integers only at the pending-nonce boundary and preserves strict receipt/block quantity parsing. PR #38 tracks this repair.

The later genuine UI attempt reached durable `outcome-unknown` with a prepared nonce-zero template and no transaction hash. Wallet confirmation was not observed. The journal was preserved and no transaction was resent. This is an **open UI acceptance item**, not a successful transaction or a proven security bypass.

### SA-03 — Acceptance and infrastructure boundaries

Four deployed loopback instances retain the previous merged baseline. This patch has not been installed over them or merged. Earlier isolation/HTTP checks remain baseline evidence, not newly relabelled patch acceptance. The remaining genuine UI write/multi-wallet tests, physical-device coverage and independent review are not closed by this report.

The limited high-confidence tracked-file scan checked 280 files and found no private-key PEM blocks or GitHub token matches. It is not exhaustive secret detection, and it does not inspect private custody storage. No key, mnemonic, raw signature, cookie, credential or private custody location is included in these artifacts.

## Evidence identity

- Initial simulated security result: `2be7b975826af5d4af1df2758226724561305608472d1bf4f8a9a7a8189f8cc2`.
- Initial dependency advisory result: `1882e4a63961ef4895aca8054ac306d75c5ead171f0a8fde6596b3bd81ad1b94`.
- Patched closure proof: `9928cc0294d33ac941d362c6fc2baa788bc7302c2e819d2bd4c64ad288c08906`.
- Patched full-unit log: `235e7a4b2f9a504f90c8b68a46032987691068057cbb01d0db593a99b1ee5e63`.
- Patched EVM log: `db6e37bbdee48d72a1f05995e88070aee241bba1af2e3aec66bf62645293466a`.
- Package verification log: `b226e8f55e7f9107d56daa5947680fa99495f4de8c79dd7f6d9fb6071713871c`.
- Candidate archive: `adc21f8a350e0d90b4676163c58087a87bef1873b9e83cc076b80038930a13e0`; 160 unique safe entries, no runtime dependencies. Candidate notices remain intact.

These exact results belong to their named revisions. A later documentation-only commit does not create a new runtime test result; a later code or lockfile change requires renewed validation.
