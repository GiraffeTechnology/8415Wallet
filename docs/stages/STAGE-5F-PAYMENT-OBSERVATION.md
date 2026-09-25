# Stage 5F — payment visibility beyond the live responsibility window

Date: 2026-09-25. Additive development on Stage 5E, not release acceptance.

## Requirement and implementation

PRD 9.6 requires per-leg reserved payment and refund progress to remain visible.
The live responsibility window is insufficient: a reservation can precede any
leg, and a completed leg is deleted before its separate payment is withdrawn.

`NativeResponsibilityPaymentClient.observe(sequenceId, legId)` reads the payment
directly, with no dependency on `legAt`. It verifies controller and adapter pins,
uses one canonical block hash for state/code reads, rechecks that block and the
current chain/deployment before returning, and preserves protocol finality as
`not-evaluated`. A missing record is `unfunded`, not completed or refunded.
Transport errors, changed chain/code, reorgs and malformed output fail closed.
The authenticated intended-chain RPC remains a stated trust boundary; this is
not a proof against an entirely malicious RPC.

The UI adds a read-only leg-ID lookup for reservations, detached payments and
refunds. It discards the result if the connection changed during the read. The
unused free-form native amount input is removed: amount/adapter come only from
the exact reviewed consent. No new contract, transaction, signing or authority
surface is added. Original standalone and linked modes remain separate.

## Actual local regression

- Node 24.19.0: complete 651/651 cases, 108 suites, 0 failures/skips.
- TypeScript noEmit and browser emit: exit 0; browser JavaScript syntax: exit 0.
- Local EVM: complete 49/49. Stage 5E's 48 remain; the new real-contract case
  observes no record, Reserved, Funded, detached-but-unallocated, SettlementDue,
  and Settled. The reader's provider explicitly refuses every write/sign method.
- Fifteen new unit cases cover all seven adapter states, chain switch, reorg,
  historical code mismatch, missing block, bad quantity, malformed ABI, transport
  error, invalid IDs and unknown state. These are unit fixtures, not UI evidence.

The initial Stage 5F batch was 651/47. After PR #10's independent P2 review,
the shared forward/reservation/review eligibility repair was integrated and the
entire batch rerun: 651 Node and 49 EVM, all passing, no skips. The two additional
cases reject detached-ID and full-window reservations before accepting funds.
No former count was reinterpreted as coverage of that later repair.

CI and merging remain assigned to Claude Code. Independent exact-version review,
genuine desktop/mobile wallet interactions and public V3 testnet receipts remain
separate outstanding gates. Historical Sepolia activity is preserved, not reused.
