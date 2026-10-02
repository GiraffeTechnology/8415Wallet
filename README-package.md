# 8415wallet

A reading client for [ERC-8415](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634)
asynchronous register projections: an off-chain register's answers, projected
onto an ERC-721, read without being conflated with the token itself.

Node 22.18 or newer. **No runtime dependencies.**

```sh
npm install 8415wallet
```

## What it is for

A projected token carries two different facts, and most integration mistakes
come from merging them:

| Fact | Read with | What it is |
| --- | --- | --- |
| tradeable position | `ownerOf` | who holds the ERC-721 now |
| confirmed holder | `holderAsOf` | who the register confirmed at an instant |

They are not the same question, and agreement between them is not verified
identity of the underlying right. This client keeps them apart everywhere, and
never derives one from the other — including when a read fails.

```js
import { WalletSession, RpcErc8415Reader, HttpCallTransport } from '8415wallet';

const reader = new RpcErc8415Reader(
  new HttpCallTransport('https://your-node.example'), 11155111n, '0xTokenContract');
const wallet = new WalletSession(reader, { account: '0xYourAccount' });

const view = await wallet.assetView(1n);          // position and holder, side by side
const at = await wallet.temporalQuery(1n, 1764547200n);  // the answer at an instant
```

It also ships a command-line client:

```sh
npx 8415wallet
```

## Three signals it refuses to merge

- **final / provisional** — whether a later admission can still change the
  answer at an instant. Taken from `isFinalAsOf`, never recomputed here.
- **contested / not contested** — whether an open gap covers that instant.
  Finality does not depend on it.
- **fresh / stale** — the optional watchtower layer, which measures a head's
  reorg exposure. Freshness is not finality, and stale is not pending.

An instant before the first entry is *not covered* rather than an error, and a
transport failure is reported as a transport failure, never as a fact about the
register. `docs/INTEGRATION-BOUNDARIES.md` states the full contract, and
`docs/INTEGRATION.md` covers backends and the read-and-act boundary.

## What it is not

This package is the standalone reading surface. It deliberately does **not**
contain the linked-responsibility control kernel, which is unaudited and
published separately as a testnet-only candidate — the build fails if its
import graph reaches that code.

It is not a generic NFT wallet, a marketplace, or an adjudicator of legal
title. It reports what is recorded and what is still open; the parties' own
terms decide what to do about it.

## Status

Local validation passes, and the package is verified by installing it from
outside its repository. It has **not** had an independent security review.
`docs/V2-CLOSEOUT.md` states exactly what was and was not established.

## Licence

CC0-1.0.
