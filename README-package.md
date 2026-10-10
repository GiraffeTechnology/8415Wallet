# 8415wallet

This V2 SDK is the native ERC-8415 integration surface of the general-purpose
8415wallet product. The product supports existing wallet and asset standards;
this SDK tarball is separate from its versioned DApp Beta deliverables.

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
published separately as a Beta SDK intended for testnet use. Direct SDK
consumers enforce their own chain policy. The V2 build fails if its import
graph reaches that linked control code.

This is the narrower V2 SDK artifact of the general-purpose 8415wallet product,
which supports existing wallet and asset standards with native ERC-8415 features.
The SDK is not a marketplace or an adjudicator of legal
title. It reports what is recorded and what is still open; the parties' own
terms decide what to do about it.

## Status

Local validation passes, and the package is verified by installing it from
outside its repository. It has **not** had an independent security review.
`docs/V2-CLOSEOUT.md` states exactly what was and was not established.

## License

Licensing notice issued in 2026. Copyright remains with the respective
copyright holders identified in source notices and project records.
All rights reserved for the material covered by [LICENSE](LICENSE).

This repository is public so investors and other readers can review the work.
Public visibility does not grant an additional license to use its covered
material. The original material covered by LICENSE is proprietary. Except for applicable
GitHub platform rights, legal exceptions, valid prior grants, and independently
applicable licenses, copying, modification, redistribution, commercial use, and
deployment require separate written permission from the copyright owner.
Authorized copies of covered material must preserve the required notices,
identify this repository and the source version, and clearly identify
modifications. Attribution alone does not grant permission.

The ERC-8415 specification, erc8415-kit, and independently licensed components
are excluded and retain their own applicable terms. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
