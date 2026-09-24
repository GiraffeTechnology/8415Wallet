# Independent responsibility controls — implementation increment

User clarification, 2026-09-25: responsibility depends on controls, NOT escrow.
v3.0 extends the original wallet and supports standalone and linked use.

## Implemented locally

- `src/sdk/linked.ts`: control-bound accepted leg records, without mandatory
  principal, currency or escrow fields.
- `src/wallet/linkedChainView.ts` and `renderLinkedChain.ts`: coherent read-only
  sequence/CP-01 preview, recorded outcomes and return boundary. Predicate
  satisfaction is not confirmed execution. The view conservatively suppresses
  new completion previews when callback/returned history exists; it is not used
  as the execution kernel.
- `src/controls/responsibility.ts`: independent deterministic transition kernel,
  no wallet-view, payment, escrow, signer, storage or network dependency.

Kernel commands:

| Command | Local invariant | Proposed effect |
| --- | --- | --- |
| `forward` | Current owner; exact recipient consent record; all active inherited terms | Append active obligation plus one token transfer |
| `complete-prefix` | Both bound occurrences at buyer or later; no callback in flight | Permanently complete the selected prefix; no payment call |
| `begin-return` | Active root; accepted return authority/condition; no competing callback | Mark its unresolved suffix returning; no token movement yet |
| `return-hop` | Correct authority; last outstanding hop first | One exact return transfer and its returned outcome |

Every proposal binds chain/token/sequence/control/revision; the next revision
increments once. Completed history is never reactivated. Returned history is
preserved. A shorter callback may leave earlier active obligations to complete
or return later. Forwarding a sequence with returned history is conservatively
refused (`CONTROL_SEQUENCE_RESTART_REQUIRED`); a safe new-sequence lifecycle is
not shipped. Work is bounded to 4,096 legs, not silently truncated.

For A→B→C→D, owner D/holder B permits AB completion, independently of ERC
temporal finality. After AB completes, BC's callback stops at B. Duplicate
accounts use distinct occurrences. Currency amounts and payment failures cannot
authorize or revive responsibility. Existing standalone sessions and legacy
ProjectionEscrow remain unchanged; the new kernel does not import them.

## Critical integration boundary

Update: on-chain accounts/controller, consent/receipt SDK and read-view source
are now being implemented locally. They are not compiled, tested, deployed or
audited; see [current checkpoint](../CONTROL-DEVELOPMENT-STATUS.md). The following
warnings remain applicable to the pure kernel itself. New source is not a
completed authenticated integration or acceptance evidence.

`prepareResponsibilityTransition` returns `UNCOMMITTED_PROPOSAL`. It does not
authenticate signatures, prove accepted terms, transfer tokens, commit state or
produce execution receipts. Tests supply model facts, not cryptographic proofs.
Do NOT expose the function directly to arbitrary JSON callers or treat its
`next` state as already committed. Structural matching of consent/facts is not
proof of their authenticity. The same warning applies to `kind: bound` view data.

The future production adapter must authenticate actor and full recipient consent,
verify callback conditions and the admitted-holder occurrence, read authoritative
state, compare-and-swap the revision, execute effects and persist the next state
**atomically**. A transfer failure must revert state; retry must check persisted
progress and not replay a confirmed transfer. A local read/check followed by a
separate transaction does not close TOCTOU. Completion evidence must be read
inside that same execution boundary, not trusted from an earlier snapshot.

The recipient/account component must actually prevent alternative transfer,
approval, arbitrary-call, delegation and upgrade bypasses. It must retain
standalone functionality when no active condition applies. No production account
or evidence adapter is shipped in this increment.

## Audit and remaining delivery

See [security review scope](RESPONSIBILITY-CONTROLS-SECURITY.md). Self-tests cover
the local state machine, not production enforcement or an independent audit.
Remaining: authenticated account/execution/evidence adapters; new-sequence
recovery after return; receipt/reorg-backed persistence; separately scoped funded
adapter integration; full EVM adversarial tests; actual testnet and UI W-01–W-21;
independent security audit and remediation. No new chain activity is claimed.
