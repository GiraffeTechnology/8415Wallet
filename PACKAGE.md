# 8415wallet — V2 standalone reading client

An installable build of the wallet surface closed out in `docs/V2-CLOSEOUT.md`
against PRD §8: the projection and temporal reads, the dual histories,
disclosure, conformance and identity checks, the protocol transaction builders,
and authorized signing that keeps the key on the provider's side of the call.

## What is fit for what

Read this before putting anything behind it. The package contains two kinds of
thing and they are not at the same level of assurance.

**The reading client — fit for production reads.** It never holds key material,
never infers the confirmed holder from `ownerOf`, and surfaces a failed read as a
failure rather than degrading to a neighbouring answer. Every condition in PRD §8
has a named passing test behind it. Node 22.18 or newer, no runtime
dependencies, no build step.

**Signing — builds and refuses, never custodies.** The shipped signer is
EIP-1193 only: the key stays with the provider. It refuses on a chain mismatch,
an account mismatch and a failing preflight before anything is broadcast.

**The legacy single-trade clearing contract — test-only.** `ProjectionEscrow`
has had exactly one public-chain run (Sepolia, 2026-09-19, 14 transactions,
explicitly `TEST_ONLY_NO_REAL_VALUE`) and **no independent security audit**. Do
not put real value behind it. It ships as a reference implementation and as the
thing the escrow views read, not as an audited custody contract.

**Not in this package at all:** the v3.0 responsibility-control kernel, its
contracts, and the linked-chain preview that reads them. AGENTS.md forbids
connecting that kernel to signing or execution before authenticated atomic
adapters, alternate-path protection and an independent audit are complete, and
none of those is done. The build asserts the package cannot reach it — see
"Provenance".

## Install

```sh
npm install ./8415wallet-<version>.tgz
node -e "import('8415wallet').then(w => console.log(typeof w.WalletSession))"
```

The CLI installs as `8415wallet`:

```sh
npx 8415wallet --rpc <url> --contract <address> --chain-id <id> \
  --token <id> --from-block <deployment block>
```

With no `--rpc` it runs the bundled in-memory scenarios, which is the quickest
way to see every view without touching a chain.

## Use

```js
import { WalletSession, RpcErc8415Reader, HttpCallTransport } from '8415wallet';

const transport = new HttpCallTransport(rpcUrl);
const reader = new RpcErc8415Reader(transport, chainId, contract, { fromBlock });
const session = new WalletSession(reader);

const view = await session.assetView(tokenId);
// Two facts, never merged, and their agreement is not verified identity.
view.tradeablePosition.owner;
view.confirmedHolder.holder;
view.alignment.aligned;
```

`docs/INTEGRATION.md` covers the reader port, the atomic-read shape a dependent
transaction should use, and the error taxonomy.

## The one thing to know about time

A read is a snapshot. `holderAsOf`, `isFinalAsOf` and `openGapOf` can move
between the read and an action that depends on it. Where a transaction depends on
such a read, the recommended shape is the on-chain atomic read — calling these
inside the same transaction as the dependent action. That closes the window
rather than narrowing it.

## What no public chain has shown yet

The register's lag is the reason this standard exists, and it has been modelled
and tested in process but never demonstrated on a public chain with an
independent registrar. The 2026-09-19 Sepolia run's two validators were the buyer
and the seller, so it showed a projection being written, not one lagging behind a
market. `docs/issues/001-asynchronous-registrar-on-chain.md` is the run that
would show it, and it is still open.

This does not affect the reading client's correctness. It means the product's
central operational claim is evidenced by tests, not by a public chain.

## Provenance

`dist/v2-package-manifest.json` accompanies each build and carries the tarball's
sha256, its entry count, and the exclusion assertions the build enforces.

The file list is derived from the import graph of `src/v2.ts` and the CLI, not
hand-maintained, and the build fails if that graph ever reaches
`src/controls/**` or the linked-chain preview. A hand-written allowlist drifts
the moment a module moves; this cannot.
