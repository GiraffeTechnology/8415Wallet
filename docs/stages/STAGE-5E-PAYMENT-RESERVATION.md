# Stage 5E — atomic funded acceptance and live authority

Date: 2026-09-25. Post-review repair of the two P1 findings on PR #8 head
`2a982919162c6bbcd674c4524d180d03475859e8`. This is not audit approval.

## Implementation

- ForwardConsent now includes signed `paymentAdapter` and `paymentAmount`.
  Zero/zero explicitly means unfunded; nonzero/positive means native-payment
  delivery precondition. Old 14-field acceptances are refused, not upgraded.
- The controller creates one immutable, fixed-code native adapter on demand.
  It never holds funds. Caller-selected fake adapters are refused. Controller
  runtime is 21,469 bytes; adapter runtime is 5,689 bytes with solc 0.8.26,
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

Node 24.19.0: typecheck/browser emit exit 0; full Node 633/633; full EVM
36/36 (14 legacy plus 22 control/adversarial/SDK cases), no skipped tests.
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
CI has failed before any runner/step was assigned; no green status is fabricated.
No merge, public deployment, real-asset operation or new public-chain receipt
is asserted by this stage.
