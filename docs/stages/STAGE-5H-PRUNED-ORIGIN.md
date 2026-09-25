# Stage 5H — preserve projection reads behind a detached boundary

Date: 2026-09-26. Narrow SDK repair; no contract/ABI/authority change.

The controller deliberately retains occurrence zero's initial account after
detaching a prefix. The SDK allowed that binding but indexed into the deleted
leg window to obtain the account, causing a TypeError. A real local EVM test
reproduced the crash in `RpcResponsibilityControlReader.observe` before repair.

The SDK now validates occurrence zero against the sequence's initial account.
If that occurrence is behind the live boundary, it preserves the actual
projection owner/holder/finality but does not issue a bound in-window completion
preview. Verified historical facts do not revive an already completed leg.

The regression opens A-B-C, admits B, detaches AB, then admits the original A
at occurrence zero. The view must display owner C / holder A, protocol
provisional, detached count one, a live tail and completion evidence unavailable.
Rendering succeeds; AB stays detached and completing BC is still refused by the
contract. The repaired SDK integration suite passes 5/5; the pre-repair targeted
test failed 0/1 with the captured TypeError. Complete local Node 686/686,
typecheck and browser emit pass. Complete local EVM regression is 51/51.
No public testnet or real UI result is claimed.

CI/merging belong to Claude Code. V3 is not release-accepted until exact-version
independent review, public-chain W scenarios and genuine desktop/mobile evidence
are completed. Unrelated inserted tasks remain refused until V3 delivery.
