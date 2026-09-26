# Stage 5G — verify detached responsibility history

Date: 2026-09-26. Implements PRD 9.3/9.6 and W-23/W-24's consumer-side
verification gap. This is additive, read-only development, not release approval.

## Why this increment exists

The contract already deletes completed legs and folds their full public records
into `detachedCommitment`. The previous SDK showed the count and commitment but
had no way to check a register's copy. A count alone does not deliver the
required accessible, verifiable detached history.

`DetachedResponsibilityHistoryClient.observe(sequenceId, document)` now:

1. Rejects extra document/record fields, noncanonical decimal integers, wrong
   chain/controller/sequence and malformed public values. Copies input before
   any asynchronous read so a caller cannot mutate the object mid-observation.
2. Reads the existing pinned control snapshot at an EIP-1898 canonical block.
3. Requires all detached records, starting at zero, in order. Recomputes the
   exact Solidity ABI/Keccak fold, checks every intermediate hash, then compares
   the final digest AND count with that chain snapshot and the live boundary.
4. Rechecks chain/runtime and finally canonical block hash. Missing, changed,
   out-of-order, duplicated or stale records produce no verified partial result.
5. Returns immutable public records, chain/token/sequence/revision/block binding,
   `readOnly=true` and `protocolFinality=not-evaluated`. It never signs, sends,
   allocates payment, resolves a registry locator or decides legal identity.

The contract and its ABI are unchanged. Original standalone readers, linked
execution and optional payment controls remain independent. The authenticated
intended-chain provider and configured code pin remain trust assumptions; this
does not defeat an entirely malicious provider or prove external legal facts.

## Public import contract

Exact top-level keys: `schema`, `chainId`, `controller`, `sequenceId`, `records`.
Schema is `8415-detached-history/1`; chainId is a decimal string. Each record has
exactly `occurrence` (zero-based decimal string), `legId`, `fromAccount`,
`toAccount`, `termsHash`, `acceptanceHash`, `returnAuthority`,
`returnConditionHash`, `detachedCommitment`, as emitted by `LegDetached`.

Supply the full prefix; a partial range cannot verify against a linear final
commitment without the missing prefix. Empty records are accepted only when the
chain reports zero detached count and zero commitment. No success flag, receipt
signature or secret input is accepted. Occurrence numbers are lossless uint256.

The browser adds a public-file read/verify button with a 4 MiB review budget. It
uses text-only output and discards an observation if the connected session
changes. This is not a lifetime transaction limit; the SDK does not cap the
number of historical records at the live window's 128 legs. Over-budget browser
files are refused, never silently truncated or called verified. Large archives
still require a suitable caller review budget; no automatic remote download is
introduced.

## Validation and remaining gates

Review 4106621481 identified caller-controlled `records.map` dispatch. Six new
regressions failed against that version: own mapper, mapper validation bypass,
map getter, Array species, sparse holes and inherited indices. The repair uses
an indexed copy into newly constructed frozen plain records before any RPC;
it never calls an input map/iterator or constructor/species hook. Targeted Node
is now 36/36; typecheck passes. The integrated Stage 5H tree with this repair
passed 692/692 Node (108 suites), 51/51 local EVM, browser emit and JS syntax.
The counts below describe the original Stage 5G batch, not the repaired head.

Targeted Node: 30/30, with an independent ethers ABI/Keccak fixture, 130 detached
records, repeated accounts, changed fields, swapped/missing/extra/duplicate
records, domain/anchor/boundary drift, RPC faults and mid-read input mutation.

Targeted local EVM: 1/1. Real reference/control deployments emit the records;
the SDK verifies a detached prefix with a live tail, repeated-wallet positions,
and complete history after every leg is pruned. A stale export fails; even a
forged archive with every intermediate hash recomputed fails against the real
chain commitment. The reader rejects all write/sign RPC methods.

These are local regressions, not public-testnet or genuine desktop/mobile
acceptance. Independent code review, CI/merge by the release owner and the exact
deployed V3/W-20/UI campaign remain required. Historical Sepolia tests remain
valid historical evidence but do not accept this revision.

Complete integrated Node regression: 686/686, 108 suites, zero failures/skips.
Complete integrated local EVM regression: 50/50 (including the new real-log case).
TypeScript noEmit, browser emit and browser JavaScript syntax all exit 0.
The emitted browser tree contains no Node-only imports. A narrow secret-pattern
check of the new source/test/report files found no matches; it is not an audit.
