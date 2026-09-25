# Stage 5E — atomic funded acceptance and live authority

Date: 2026-09-25. Post-review repair of the two P1 findings on PR #8 head
`2a982919162c6bbcd674c4524d180d03475859e8`. This is not audit approval.

## Implementation

- ForwardConsent now includes signed `paymentAdapter` and `paymentAmount`.
  Zero/zero explicitly means unfunded; nonzero/positive means native-payment
  delivery precondition. Old 14-field acceptances are refused, not upgraded.
- The controller creates one immutable, fixed-code native adapter on demand.
  It never holds funds. Caller-selected fake adapters are refused. Controller
  runtime is 23,887 bytes; adapter runtime is 5,631 bytes with solc 0.8.26,
  viaIR, optimizer 200 (below EIP-170).
- Buyer reserves the exact signed consent before forwarding. Reservation digest
  binds sequence, asset, leg, parties, price, terms, inherited scope, authorities,
  revision, nonce and deadline. Only the controller consumes it, atomically with
  token movement; failed movement reverts consumption, nonce and leg state.
- Original payer can cancel an unused reservation only after nonce/revision/
  deadline/sequence closure invalidates it, then withdraw to itself once.
  A used reservation follows existing Completed/Returned allocation rules.
- Forward rechecks the live projection's accepted settlement authority within
  the same transaction. No invented authority migration or projection writes.
- SDK, signed disclosure, durable public journal, UI and real-reference scenario
  runner use the same ABI. UI reserves its in-memory accepted consent; it never
  persists the signature. Zero-payment flows are still fully independent.

This is NOT a return to escrow-driven responsibility: payment existence or
failure cannot establish completion, undo detachment or authorize recall.
Token is held in the recipient controlled account. Payment is an optional
separate native ledger; its payout failure does not restore a completed leg.

## Actual local checks

Integrated onto main `4775490cd5b20f06133eb414dc08cc736d4bd21f`, preserving
PR #9 rolling-window pruning and PR #8 recovery. Node 24.19.0: typecheck/browser
emit exit 0; full Node 636/636 (108 suites); full EVM 48/48 (14 legacy plus
34 control/adversarial/SDK/window cases), no skipped tests. Payment allocation
continues by leg ID after its on-chain record has detached. The added SDK
scenario reserves after a completed prefix, refuses a substituted predecessor,
then forwards, detaches and allocates without reading deleted records.

Initial integration run: 45 EVM passed, one new test failed because its assertion
used receipt.status instead of receipt.state. Corrected the assertion to the
actual public receipt contract, reran that case and then the full 46-case suite.
No runtime failure or partial run was relabelled as a pass.

Independent PR #10 review on `2f5241ef6bc25df14dfca649e0a115d5c0331595`
reported P2: a detached leg ID or a 129th unresolved leg could accept a
reservation even though forwarding was impossible. The controller now exposes
a read-only eligibility check backed by the same private validation used by
forward. Reservation and recipient review use it before accepting funds or
prompting a signature. It covers the active bound, all historical IDs,
sequence/revision/identity/authority, recipient/nonce/deadline, ownership and
explicit payment profile. Seller and signature authorization remain in forward;
eligibility is neither authorization nor a promise against subsequent races.
Two real-EVM regressions prove refusal leaves principal and nonce unchanged,
recipient review cannot prompt, a fresh ID is still accepted, and detaching one
head frees a reservable slot. Authority drift before reservation is also refused.
Fresh independent retest of the repair is pending; the review is not an approval.
Five added EVM tests exercise unpaid forward, wrong payer/amount/terms/adapter,
digest replacement, replay, original-recipient refund, expiry/closure,
authority drift, transaction rollback and completed-buyer exit before payout.
The fourth SDK/EVM test executes reserve/reconcile/invalidate/cancel/payout.
Three new Node tests cover explicit profile/schema, signed field binding and
public-only reservation receipt restoration.

The EVM expiry negative uses local time manipulation; public scenario runner
does not. Local test accounts are not evidence of a genuine UI or public chain.

## Remaining acceptance

Fresh independent review, exact new-tree Node 22 validation, real wallet desktop/
mobile UI, and actual V3 public-testnet deployment/transactions are still needed.
The earlier 630/30 Linux run is retained as separate Stage 5D evidence. GitHub
Historical CI failed before any runner/step was assigned; current CI and merging
belong to Claude Code. This task neither changes runners nor claims CI status.
No merge, public deployment, real-asset operation or new public-chain receipt
is asserted by this stage.
