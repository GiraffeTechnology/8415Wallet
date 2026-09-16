# Integrating a backend

The wallet reads a projection through one interface, `Erc8415Reader`
(`src/sdk/port.ts`). Everything above it — the asset view, the temporal query,
the history walk, the gap views, the risk surfaces — is written against that
interface and nothing else. Binding a new backend means implementing it.

## What an adapter must do

Pass the contract's answers through, unchanged, including its reverts.

An adapter computes nothing. In particular it does not:

- derive finality, from anything. `isFinalAsOf` is the only source;
- smooth over a revert, or turn one into a default value. `entryAsOf` and
  `holderAsOf` revert for an instant preceding the first entry, and that
  revert is information;
- fill in a value the contract did not return;
- fall back to `ownerOf` when a projection read fails.

Run `checkReaderConformance` (`src/sdk/readerConformance.ts`) against it. The
harness verifies the entry walk, strict monotonicity, commitment uniqueness,
that `holderAsOf` agrees with `entryAsOf`, that the finality rule holds at its
boundaries, that the two reverting calls revert before the first entry and
that `isFinalAsOf` does not. It returns findings rather than throwing, so a
caller sees all of them at once.

Both shipped adapters are held to it in `tests/readerConformance.test.ts`,
the rpc one over the real calldata encoding.

Note what the harness is not: it does not certify a deployment. The ERC's own
test cases cover contract conformance, and a wallet is in no position to
certify one. This checks that an adapter faithfully relays what a contract
said.

## The shipped adapters

| Adapter | Use |
| --- | --- |
| `src/adapters/rpc` | `eth_call`, `eth_getBlockByNumber`, `eth_getLogs` against a node |
| `src/adapters/memory` | A contract model enforcing the four invariants; for tests and the reference client |

`getLogs` is optional. Without it the projection still reads, but gap
transitions cannot be shown, and the wallet says so rather than rendering an
empty settlement history.

## The Native Infrastructure Kit adapter

Not built, deliberately.

PRD §2 names the Kit as a backend alongside direct chain reads, and the port
is shaped so its adapter drops in beside the rpc one without anything above
moving. But the Kit (`GiraffeTechnology/ERC8415-Kit`) is at Stage 0 — its
repository contains documents and no implementation, and it exposes no
Register API to bind to.

Writing a client for an API that does not exist would mean inventing its
endpoints, payloads and error shapes, and then shipping tests that prove the
invented client matches the invented API. That is a passing test suite that
establishes nothing. When the Kit ships its Register API, its adapter needs to
do two things: implement `Erc8415Reader`, and pass `checkReaderConformance`.
Those are the same two things the rpc adapter does, and the harness is
already there for it.

## The watchtower

The watchtower freshness layer is a separate contract with a separate port,
`WatchtowerReader` (`src/sdk/watchtower.ts`). It is kept apart on purpose:
they answer different questions, and a single combined reader would invite the
conflation the freshness layer must not cause.

Freshness measures reorg exposure of an attestation. It is not registrar
finality and not projection finality, and no code path lets a freshness answer
reach the finality or contest display. The contract's enum names its deepest
state `FRESH_FINAL`; the wallet labels it **Reorg-safe** and shows the raw
enum value beside it, marked as raw data.
