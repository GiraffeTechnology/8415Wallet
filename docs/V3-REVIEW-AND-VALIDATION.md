# V3 review and unified validation handoff

Source closure is not release acceptance. All new source is UNTESTED at this
checkpoint. Preserve historical Sepolia receipts; do not relabel them as V3.

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
   authorization.

No deployment wallet is generated or imported by this handoff. Missing genuine
provider, signing capability, funding, review or brand inputs must be reported
precisely while other authorized validation continues. Do not fabricate evidence.
