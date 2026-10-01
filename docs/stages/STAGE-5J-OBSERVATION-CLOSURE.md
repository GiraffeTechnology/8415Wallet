# Stage 5J continuation — public gap timing and replayable observations

Base: `ab21f61916b3836c615379c9787b6ea9ace8c88a` (2026-09-30).
This is an existing Stage 5J repair, not a new product stage or release approval.

## Demonstrated problem

The public run completed seven core/extended journeys but stopped in the
continuous detachment fixture. Its deadline was latest block time + 3 seconds.
A separate read-only Sepolia diagnostic observed latest 1790764176 and pending
1790764188: the +3 call reverted with DeadlinePassed while +120 succeeded.
This reproduces the timing defect; the original failed estimate's raw selector
was not retained and is not claimed recovered. A separate +120 detach retest
does not make the original whole run successful.

The old observer also made several unpinned latest reads. Later replay at the
preceding receipt block corroborated values but could not prove that was the
original observation block. New code must preserve that distinction.

## Implementation

- `gapTiming` selects 120 seconds for Sepolia/Hoodi and 3 for explicit local
  chain 31337, validates the contract's settlement period and uint64 range,
  and refuses unknown chains. It never silently reduces the public window.
- Only the explicit local chain may send clock-advance transactions. A public
  chain with no block for 2.5 seconds is no longer mistaken for an autominer.
  The dedicated loopback rehearsal config produces a block every two seconds;
  its public test-chain ID does not make its results public-chain evidence.
- Cancellation still waits for the chain timestamp to exceed the actual
  deadline, with a 180-second wall-clock ceiling. No time warp, resend or
  contract-rule change. The deadline is inclusion headroom, not a guarantee
  of public-network liveness; a delayed transaction can still fail normally.
- Every new detach row records block number/hash/timestamp. All contract reads
  use that hash, followed by a canonical-height hash recheck before returning
  the row. Missing/pruned/unsupported historical reads or a detected reorg
  refuse the row, never fall back to latest. This relies on the intended RPC;
  it is not a proof against a malicious RPC or future reorganization.
- ERC finality remains the contract's `isFinalAsOf` answer, not inferred from
  commercial completion, block pinning or owner/holder agreement.

## Development validation

Results are recorded after execution; they are not public-chain acceptance.
On the repaired source, Linux Node 24.18.0: 716/716 Node cases (108 suites),
59/59 local EVM cases, typecheck and browser emit all passed. The 10 new
offline cases also passed on Windows. These are development regressions,
not CI or a fresh public-testnet run; CI and merge remain with the release owner.
New offline cases cover the observed next-block timestamp, local/public policy,
unknown/mainnet/coercible IDs, invalid periods/timestamps/overflow, every field's
hash pin, open-gap reads, reorg and unavailable-block refusal.
The existing real local EVM detachment cases additionally replay their 14 row
block identities, including entryCount for the continuous shape.

## Remaining delivery, without expanding scope

1. Release owner reviews, runs CI and merges this repair; this task does not
   schedule CI or merge it.
2. Rebuild the exact merged source and execute the complete public-testnet
   runner in a fresh evidence directory. Never splice the earlier incomplete
   run and separate retest into that new result.
3. Reconcile W-01–W-24 individually at their specified evidence levels, retain
   real transaction and browser evidence, and resolve exact-version review
   findings. Package/source presence is not acceptance.
4. UI remains sufficient for functional tests; visual redevelopment is deferred
   by the user and is not an extra prerequisite for this repair.

No deployment, test-wallet access, signing, transfer, public RPC or CI operation
is performed by these source edits. Contract bytecode/ABI/business scope is unchanged.
