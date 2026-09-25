# Stage 5I — connect the deployed journey to wallet observations

Date: 2026-09-26. Test tooling only; no contract, ABI, wallet authority or new
business feature. CI and merges remain exclusively with Claude Code.

## Gap and repair

The public-testnet runner executed real control transactions and direct reads,
but did not call the new detached-history verifier, wallet presentation model or
detached payment observer in that same journey. Separate SDK unit tests were
not evidence that the deployed journey exercised these consumers.

The shared core journey now actually invokes the existing SDK at three points:
after A-B-C-D forwarding, after AB detachment/optional payment release, and after
D-C-B return/optional original-payer refunds. Both the unfunded and independently
funded journeys run these observations. The assertions cover owner/holder,
raw provisional finality, the live tail, permanent return boundary, detached
count/commitment and each original leg's payment state.

Completed receipts supply the public `LegDetached` records. No unbounded remote
log query, automatic register lookup or synthetic record replaces them. Runtime
pins are captured at deployment, not recomputed to trust later substitutions.
The SDK provider exposes only chain/code/call/block read methods. Changed
archive data or runtime code rejects without a successful observation record.

## Evidence contract

Each successful `sdk-observation` is appended through the existing fsync-backed
transaction journal. Counts come from actual reads. View, archive and individual
payment block identities are recorded separately because these are sequential
canonical snapshots, **not one atomic cross-reader snapshot**. Text rendering
is identified by its digest; `readOnly=true`, `uiVerified=false` and
`independentAuditPassed=false` stay explicit. No key, signature, grant, endpoint
or raw error body is recorded.

This does not run a public chain or a browser, and cannot satisfy genuine UI
acceptance. The runner's result continues to say core journeys only, not full
V3 acceptance; its remaining scope now explicitly includes W-01 through W-24.

## Actual targeted development regressions

- Two existing local EVM core journeys pass with all three SDK observations
  required per journey, including the recorded final payment states.
- Corrupt receipt archive refuses before success evidence; restoring it passes.
- Runtime substitution refuses the deployment-time code pin.
- Unknown observation phases refuse before any provider access.

The four targeted EVM cases pass. The full integrated local batch passed
693/693 Node (108 suites), 53/53 EVM, TypeScript noEmit, browser emit and script
syntax. Narrow secret-pattern checks found zero matches in the added surfaces.
Historical Sepolia results remain historical; there is no new public-chain claim.

Public-testnet readiness was checked only for parameter presence in this local
process: all ten `WALLET_TESTNET_*` inputs are absent. This does not establish
that authorized custody or funding is absent on another server. No endpoint,
key, signer session or transaction was accessed. Exact deployed-candidate
review and configured five-actor test signing remain prerequisites to the
separate real-chain run; do not invent accounts or fake a browser provider.
