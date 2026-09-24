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

### Reading a history from a real node

Two things about `getLogs` are not obvious until it meets a public endpoint,
and both were found by running against one.

A projection's history spans the contract's whole life, and no provider will
serve that in one request — Sepolia's PublicNode answers `exceed maximum block
range: 50000`. The reader therefore walks the range in windows
(`logWindow`, default 10,000). A window the node refuses **raises** rather
than returning the logs gathered so far: a short history is indistinguishable
from a projection that never moved, and handing one over would be the quiet
failure this layer exists to prevent.

The scan starts at the contract's deployment block. With an archive node the
reader finds it by bisecting `eth_getCode`, about two dozen requests, once.
Most public endpoints prune state and cannot answer, in which case the reader
refuses and says so — supply `fromBlock` (or `--from-block` on the CLI), which
whoever deployed the contract has.

```ts
new RpcErc8415Reader(transport, chainId, contract, {
  fromBlock: 11_739_196n,   // the deployment block
  logWindow: 10_000n,       // below every cap seen so far
});
```

### A revert and a failure are not the same thing

`ContractRevertError` means the contract declined. `TransportError` means the
node did not answer — unreachable, rate limited, refusing a query, or
returning something that is not a reply. Only `eth_call` can produce a revert,
because nothing else executes contract code.

`NoContractAtAddressError` is a third thing again: `eth_call` against an
address with no code succeeds and returns nothing, so without naming it the
ABI decoder ends up reporting a mistyped address as a truncated payload. It is
kept apart from non-conformance because the remedy differs — one is the wrong
address, the other is the wrong contract.

This matters more than it looks. The distinction has failed here twice: an
unreachable endpoint once surfaced as "the contract does not advertise
`0x6309e170`", and a provider's log-range policy once surfaced as
`call reverted`. Both were the transport wearing the contract's clothes, and
both were absorbed by callers that treat a revert as an answer. Nothing above
the port may render a `TransportError` as a fact about the register.

## The Native Infrastructure Kit adapter

Built, and composed rather than substituted.

`KitErc8415Reader` (`src/adapters/kit`) reads the projection through a Kit
deployment's HTTP API — `registerId`, `verificationProfile`, `entryCount`, the
entry walk, `entryAsOf`, `holderAsOf`, `isFinalAsOf` and the open gap — and
takes a chain reader for everything else. `RpcErc8415Reader` satisfies that
companion shape as it stands:

```ts
const chain = new RpcErc8415Reader(transport, chainId, contract);
const reader = new KitErc8415Reader(
  new KitProjectionApi({ baseUrl, apiKey }),
  chain,
  chain.source,
  { chainIdentity: chain },
);
```

### What stays on chain, and why

| Read | Source | Reason |
|---|---|---|
| `ownerOf` | chain | The tradeable position. An index serving it beside the confirmed holder asserts the equivalence ERC-8415 denies. |
| `supportsInterface` | chain | An indexer vouching for the contract it indexes is circular. |
| `chainInstant`, `chainInstantAt` | chain | `block.timestamp` is a property of the chain. |
| `settlement`, `settlementPeriod`, `isSettlementAuthority` | chain | The Kit's API serves only the gap currently open; a settlement history is mostly closed gaps. |
| `getLogs` | chain | Not in the Kit's API. |

So the kit adapter needs a node behind it. That is the design, not a
limitation to route around: a Kit-only wallet could not show the position at
all.

### Two failure modes it keeps apart

The Kit answers "the projection does not cover that instant" with a 404 and a
code. That is the API's spelling of the contract's revert, and the adapter
raises `ContractRevertError` for it, exactly as the rpc adapter does — which
is why `checkReaderConformance` passes unchanged against it.

Every other refusal — unauthenticated, unreachable, a 5xx, a malformed body,
an integer that is not a decimal string — raises `KitTransportError`. Nothing
above the port may render that as a statement about the register. This is the
same distinction the rpc adapter draws between a revert and a transport
failure, and it exists because a wallet that reports an unreachable backend as
a fact about who holds an asset is worse than one that reports nothing.

### What it checks rather than trusts

- **The index is indexing this deployment.** `registerId` and
  `verificationProfile` are specified immutable, so the adapter compares the
  Kit's pair against the chain's once, on the first read that needs them, and
  raises `BackendDisagreementError` on a mismatch instead of preferring one
  side. Pass `crossCheckIdentity: false` to decline the check; nothing then
  cross-checks the index.
- **`currentEntry` really is current.** The Kit's API has no route for it, so
  it is read as `entryAt(entryCount)` — leaning on the invariant that versions
  run consecutively from 1 — and then refused unless the returned version
  matches the count and its interval is still open. A lagging index gets a
  refusal, not a superseded entry labelled "current".
- **Integers survive the wire.** Every instant, version and token id crosses
  as a decimal string and is read as a `bigint`. `Number` is never involved:
  an `effectiveAt` far enough in the future to end a projection permanently is
  exactly the value worth reporting accurately, and it does not survive a
  double.
- **The base URL cannot leak the key.** Plain http to a non-loopback host, or
  a URL carrying embedded credentials, is refused at construction.

Both adapters are held to `checkReaderConformance`, over the Kit's own wire
format. Separately, the Kit's Ethereum adapter derives its function selectors
from the compiled Solidity ABI while this wallet derives its own by hashing
signature text; `tests/kitCrossCheck.test.ts` compares the two tables, so a
signature drifting on either side fails the build and names the call.

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
