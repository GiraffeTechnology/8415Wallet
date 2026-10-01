# Stage 5B — connection lifecycle closure

This increment completes the existing browser workflow's connection-change
boundary. No contract, ABI, payment rule or responsibility predicate changes.

Account, chain and disconnect events invalidate the current connection and
clear review text and acknowledgement. Async connection setup commits its
session only after deployment verification and journal loading have completed
without such an event. Failed reconnection does not retain an old session.
Delayed reads, reviews and signatures cannot restore invalidated page state.

A completed acceptance deliberately remains in memory across an account-only
switch: the buyer signs and the seller reconnects before forwarding. It is
cleared by chain changes, disconnection, deployment reload or page reload.
A signature arriving after invalidation is discarded instead. Existing SDK
consent, actor, chain, revision and on-chain execution checks remain mandatory.

Invalidating the page cannot cancel a wallet prompt or prove that a transaction
was not submitted. Durable operation journals remain intact; return to the
original account and deployment to reconcile an unknown or submitted operation.
There is no automatic retry or automatic journal clearance.

`tests/browser-connection.test.ts` exercises the actual page handlers with
deterministic DOM/provider boundaries. These regressions are not physical-device,
genuine-wallet, public-chain or independent security acceptance. Public-testnet
and complete V3 acceptance remain separate from source delivery.
