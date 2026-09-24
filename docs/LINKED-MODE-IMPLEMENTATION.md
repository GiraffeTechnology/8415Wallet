# Linked mode: first implementation increment

This increment implements the **read-only application model and completion
preview**, not a linked payment contract, protected account or live-chain
execution. It does not replace standalone wallet behavior or ProjectionEscrow.

## Public surface

- `LinkedChainSnapshot` separates the accepted sequence and per-leg principal,
  original payer, terms, currency and actual execution outcome.
- `LinkedChainReader.observe` is an optional read-only integration port.
- `buildLinkedChainView` checks structural and observation bindings, then
  evaluates the user-confirmed CP-01 predicate.
- `readLinkedChainView` calls the configured reader once and refuses a response
  for another sequence. Backend failures propagate without a cached fallback.
- `renderLinkedChain` distinguishes recorded outcome, unexecuted predicate,
  protocol temporal finality and the historical return boundary.

All exports are available from `src/index.ts`; no dependency, signing method,
RPC endpoint, protocol interface or existing wallet session changed.

## Evidence contract

The adapter is a **trust boundary**, not implemented authentication. It must
authenticate the accepted sequence, terms, execution outcomes and both owner
and admitted-holder occurrence associations. A `kind: 'bound'` object is not a
cryptographic proof. Never forward untrusted JSON directly to this view.
The existing ownership-history `apparently-registered` correlation is not such
an adapter and is deliberately not used here.

Inputs bind chain ID, contract, lossless token ID, sequence ID, revision, block
number and hash. The adapter must increment revision for every accepted terms,
sequence or outcome change and read all facts from a coherent block. Repeated
addresses require explicit unique occurrences; missing or ambiguous association
has no completion prefix. Evidence at a different block/revision is refused.

The model accepts canonical lowercase addresses and nonzero 32-byte IDs;
principal is a positive uint256 in base units. Native currency uses the zero
payment-asset address. Processing is bounded to 4,096 complete legs; an oversized
sequence is refused rather than truncated and reported as complete. This is a
local SDK limit, not a new protocol rule.

## CP-01 and outcomes

Owner and holder positions are sequence positions, never numeric addresses.
For A→B→C→D, owner=D/holder=B yields AB in `completionPrefix`; holder=C yields
AB and BC. A provisional or unavailable ERC finality answer does not invent an
extra completion prerequisite. Owner-only or holder-only progress is insufficient.

`completionPrefix` is **not execution authorization** and never mutates an
outcome. Only actual backend `released` records create detached history and move
the return boundary. Those records must form a prefix. A later holder regression
does not reinterpret a recorded release. Actual refunds form a suffix; a
committed return/refund suppresses release previews so competing outcomes are
not advertised together. This does not itself authenticate callback authority
or enforce monotonic persistence across backend snapshots.

Each principal and original payer remains separate; no amount is pooled, netted
or transferred. Duplicate reads have no side effects. Real execution must
atomically revalidate the predicate and terms, serialize callbacks/releases,
enforce scoped forwarding and persist receipt-backed progress.

## Verification and outstanding delivery

`node --test tests/linkedChain.test.ts` covers the 16 owner/holder combinations,
repeated addresses, exact domain/block/revision binding, malformed chains,
released-prefix/refunded-suffix consistency, no optimistic detachment, late
admission during callback, transport errors and truthful text rendering.

This is local coverage of **parts** of W-04/W-05/W-08/W-09/W-15/W-16/W-19, not
acceptance of those scenarios. Still required:

1. Authenticated coherent linked backend and receipt-backed durable outcomes.
2. Enforceable recipient account acceptance and alternate-path protection.
3. Segregated payment contract with atomic release and actual return/refund.
4. Concurrency, crash/restart and callback progression at the execution layer.
5. Real testnet multi-wallet and desktop/mobile journeys (W-20).

No new chain transactions, wallet changes or testnet acceptance are claimed.
The earlier real Sepolia evidence remains historical evidence for its candidate.
