# V2 product package — delivery record

Built from the V2 closeout (`docs/V2-CLOSEOUT.md`). This records how the package
is produced, what it contains, what was verified, and what it is not fit for.

## Build

```sh
npm run pack:v2          # build the tarball + manifest
npm run pack:v2:verify   # build, then install it and exercise it
```

| | |
|---|---|
| artifact | `dist/package/8415wallet-0.1.0.tgz` |
| sha256 | `412255ede84c1897d9d3680a9f2a9973d1e6bfae1f74602d0a9f7cacecc576cd` |
| entries | 122 |
| unpacked | 552 KB |
| source modules | 57 |
| runtime dependencies | **0** |
| engine | Node ≥ 22.18.0 |
| entry | `v2.js`, compiled from `src/v2.ts` |

Reproducible: two consecutive builds produced the identical sha256 above.

## The contents are derived, not listed

`scripts/package/build-v2.mjs` walks the import graph of `src/v2.ts` and the CLI
and packages what it finds. It then **asserts** that the graph never reaches
`src/controls/**`, the linked-chain preview or the browser entry, and fails the
build if it does.

A hand-written allowlist would drift the moment a module moved, and the one thing
this package must guarantee is that the unaudited v3.0 control kernel is not in
it. Verified at build time (the assertion) and again after install (the surface
probe below).

## It ships compiled JavaScript, and it has to

The repository runs TypeScript directly and has no build step. That property does
not survive packaging, and it took an install to find out:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is
currently unsupported for files under node_modules, for
".../node_modules/8415wallet/src/v2.ts"
```

A tarball of `.ts` files packs cleanly, installs cleanly, and then cannot be
imported at all. The package therefore compiles to `.js` with `.d.ts` beside it.
`npm run pack:v2:verify` exists so this cannot silently regress: building the
package is not evidence that it works, installing it is.

## Verified after installing, from outside the repository

7/7:

| Check | Result |
|---|---|
| installs from the tarball | ok |
| no runtime dependencies | ok — 1 installed package, itself |
| imports after install | ok — 86 exports |
| V2 surface complete | ok — session, readers, transport, signer, views, builders |
| unaudited v3 surface absent | ok — `prepareResponsibilityTransition`, `buildLinkedChainView`, `renderLinkedChain` all unreachable |
| CLI runs the bundled scenarios | ok — via `node_modules/.bin/8415wallet` |
| CLI keeps the two facts apart | ok |

The shipped `.d.ts` were also compiled against by a consumer outside the
repository (`new WalletSession(reader)` typed through `Erc8415Reader`), clean
under `--strict` with `nodenext` resolution. Bad input is refused with a stated
reason rather than a stack trace: `--contract is not an address: 0xabc`.

## Verified against the live chain

The installed package — not the repository — read the real Sepolia deployment:

```
8415wallet --rpc <sepolia> --contract 0xaeeb157f40ffdad51693275258a465763be66cd8 \
  --chain-id 11155111 --token 841501 --from-block 11739196
```

```
TRADEABLE POSITION   0xde3c1d455c2cce1bacf1e70aac7fa3b8ccb1ec2b
CONFIRMED HOLDER     0xde3c1d455c2cce1bacf1e70aac7fa3b8ccb1ec2b
  Admitted by        entry v2 of 2, effective 2026-09-19 17:58:00 UTC (1789840680)
ALIGNMENT            agree
FINALITY OF PRESENT  Provisional
SETTLEMENT GAP       none open
```

Three things worth noting in that output, because they are the properties most
easily got wrong: the present instant reads **provisional** even though the
holder agrees and the entry is admitted, which is correct because the newest
entry's own instant is never final; agreement is reported as agreement between
records and explicitly **not** as verified identity; and the two facts are
printed separately rather than merged into one "owner".

## Fit for what

**The reading client — fit for production reads.** No key material, no inference
of the confirmed holder from `ownerOf`, and a failed read surfaces as a failure
rather than degrading to a neighbouring answer. Every PRD §8 condition has a
named passing test behind it in the closeout.

**Signing — builds and refuses, never custodies.** EIP-1193 only; the key stays
with the provider. Refuses on chain mismatch, account mismatch and failing
preflight before anything is broadcast.

**The legacy clearing contract — test-only.** `ProjectionEscrow` has had one
public-chain run (Sepolia, 2026-09-19, 14 transactions, explicitly
`TEST_ONLY_NO_REAL_VALUE`) and no independent audit. Do not put real value behind
it. Note the package ships the *client*: the contract itself is not in the
tarball, only the views and reader that read a deployment of it.

**Not in the package:** the v3.0 control kernel and contracts, the linked-chain
preview, the browser entry, the test suites, and the chain tooling.

## What no public chain has shown yet

The register's lag is the reason this standard exists. It is modelled and tested
in process, and has never been demonstrated on a public chain with an independent
registrar — the 2026-09-19 run's two validators were the buyer and the seller, so
it showed a projection being written rather than one lagging behind a market.
`docs/issues/001-asynchronous-registrar-on-chain.md` is still open.

This does not affect the reading client's correctness. It means the product's
central operational claim is evidenced by tests, not by a public chain, and a
deployment should know that before quoting it.

## Not covered by this package

An independent security review, a browser or mobile journey, and any v3.0 claim.
GitHub Actions has not run any of it: every run in this repository since
2026-09-19 fails within seconds with no runner assigned, including pushes to
`main`, so every figure here is a local run on Node 22.22.2.
