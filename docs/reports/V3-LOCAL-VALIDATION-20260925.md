# 8415Wallet V3 — implementation and first local validation

Date: 2026-09-25. Verdict: **IMPLEMENTED_LOCAL_VALIDATION_PASS**.
**Not full PRD acceptance, not production ready, not independent security approval.**

## Source and stage delivery

*(Later the same day, after the unified validation batch, the user lifted the
merge hold and PRs #3-#7 merged in dependency order. The paragraph below
records the state when this report was written and is left as it stood.)*

PR #3 remains unmerged. Independent controls are in draft PR #4; SDK/account/
payment adapters in #5; browser/consent/recovery integration in #6; validation
and deployment tooling in #7. No stage was merged during this work.

Stage 5C initial source tree: `47636e407dcc23c4ef8eae9854fa75419859deb1`.
Local commit `0b4df952a6c686dbcde9d8011ddd1d96238fc8b3` and GitHub commit
`2e5ed43c48411b97d0c465f4f7e97eadfdb89c3b` have this identical tree. The later
validation repair adds explicit Python selection, reverted-depth gating and
pre-send crash recovery; the Git commit containing this report records those
exact changes. No package version or lockfile was changed.

## Actual executed results

| Gate | Observed result |
| --- | --- |
| Node runtime | v24.19.0 |
| TypeScript 5.9.3, noEmit | exit 0 |
| Browser TypeScript emit | exit 0; Node-only runtime imports absent |
| Node complete suite | 622 tests / 107 suites; 622 pass, 0 fail, 0 skipped |
| Hardhat 2.29.0 compiler | 6 new Solidity files compiled, solc 0.8.26, viaIR, optimizer 200 |
| EVM complete suite | 28 pass: 14 legacy + 14 new control/adversarial/SDK cases |
| Standalone CLI | exit 0, retained original reference-client output |
| Actual loopback HTTP/module closure | 49 resources loaded, 3 forbidden paths returned 404, POST returned 403 |
| Genuine browser UI | NOT_RUN: browser tool kernel-asset write failed with OS error 3 before tab creation; one reset/retry identical |
| New V3 public-testnet transactions | NOT_RUN |
| Independent security review | NOT_COMPLETED |
| GitHub CI run 36113801906 | FAILURE before any step; both Node 22/24 jobs runner_id=0, steps=[]; log retrieval BlobNotFound |

Lock SHA-256: `76f6bf9e45013bf4a22e3e174aa2c6ce08a16001f7c06bfbafd4b3a4c92c8f17`.
Compiler config SHA-256: `97367501d7f80a22af1bf6f5f01d789ea41fdf1490205c50ab067ca4ddc2067f`.
HTTP checks are transport checks, not a screenshot, wallet prompt or UI PASS.

The two added SDK/EVM integration cases actually use the application SDK for
EIP-712 review/signing, exact receipt recovery, protocol observations, completion,
standalone withdrawal, optional payment allocation/refund, and refusal of omitted
upstream conditions. Contract calls and signatures execute on the local EVM;
only selected-account presentation is a test fixture. This is not genuine UI.

GitHub CI head: `d02292969515d48a9a129961b8faa211a2a36833`. Its exact runner
failure cause could not be retrieved: the available connector rejects the check
annotation endpoint, and neither job produced a log. Do not infer a code failure,
billing diagnosis or PASS. Codex independently reported review Running on that
head after the explicit PR #7 request; no final review verdict is available yet.

A limited changed-source scan found one credential-shaped URL in an unchanged
dummy refusal fixture in tests/kit/sdk.test.ts. The added diff contains no such
literal. No private-key block or supported access-token pattern was found by
that limited scan; it is not a comprehensive secret audit. The temporary
loopback UI process was stopped after the HTTP check.

## Failures preserved and repairs

1. Initial npm invocation unavailable on this host. Used the installed locked
   Node tool entrypoints directly; no tool or dependency was silently skipped.
2. Initial full Node run failed two Python SDK cases: python3 ENOENT. Added a
   shell-free explicit PYTHON interpreter override and Windows default selection;
   reran all cases, including real loopback authenticated Python transport.
3. Recovery review found old identical calldata needed an explicit nonce binding.
   Submission templates and exact receipt verification now bind nonce; negative
   test refuses a different nonce even when the rest of the transaction matches.
4. A reverted receipt formerly bypassed requested confirmation depth. It now
   stays confirming until the configured depth; no early journal unlock.
5. A crash before a send template was durably prepared could strand the journal.
   An explicit CAS discard is permitted only while submission is null; it cannot
   discard a prepared/unknown send. A predecessor's later CAS cannot authorize
   sending after the record was discarded.
6. A first HTTP-check regex matched quoted prose in a comment. Replaced only
   the external probe with AST import/export inspection; 49 real resources passed.

Only two Python bytecode cache files created by the initial test were removed;
the interpreter now uses -B. No chain objects, assets or historical reports were
deleted. No new V3 transaction was signed/broadcast and no wallet material was
loaded during this local campaign.

## Remaining actual gates

Fresh GitHub CI on the repaired source, independent exact-boundary review, genuine
desktop/mobile provider journeys and a new source-bound Sepolia/Hoodi deployment
with canonical transactions/readbacks remain required. The prepared runner needs
five distinct authorized test roles and explicit bounded fees/budget. The original
2026-09-19 Sepolia deployment and 14 transactions remain valid historical work,
not evidence for these new controls. Do not call this report all-W-01–W-21 PASS.
