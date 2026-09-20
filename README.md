# 8415Wallet

A reference wallet and client for [ERC-8415 — Asynchronous Register Projection for NFTs](https://github.com/GiraffeTechnology/ERC-8415).

ERC-8415 projects an off-chain register onto an ERC-721 token so that a past instant can resolve to a confirmed holder while the tradeable blockchain position may already have changed. 8415Wallet is designed to expose this distinction to users and applications.

## Why a separate wallet

An ordinary wallet answers:

> Who owns this token now?

For asynchronous registered assets, this is only one part of the answer.

ERC-8415 separates:

- **tradeable position** — `ownerOf`, the current blockchain position;
- **confirmed holder** — the register projection, updated through valid admission.

8415Wallet keeps these sequences separate and never substitutes one for the other.

## Current implementation status (2026-09-20)

The repository has progressed from a read-only reference client into an ERC-8415 settlement-aware wallet prototype.

## Implemented

### ERC-8415 reading and interpretation

- ERC-8415 projection reader interface;
- temporal queries:
  - `entryAsOf`;
  - `holderAsOf`;
  - `isFinalAsOf`;
- append-only entry history reading;
- ownership discovery from ERC-721 transfer history;
- dual sequence presentation:
  - tradeable position;
  - confirmed register holder.

### Settlement capability

The wallet now contains transaction construction support for:

- `beginSettlement`;
- `finalizeSettlement`;
- `cancelSettlement`.

Signing is separated from wallet logic through an external EIP-1193 provider interface. The wallet does not hold private keys.

### Clearing reference implementation

`ProjectionEscrow` provides a reference clearing pattern:

- asset locking;
- payment locking;
- release after projection confirmation;
- refund path after unsuccessful confirmation.

This is an application pattern, not part of ERC-8415 itself.

### Asynchronous registry simulation

The repository contains an asynchronous registrar simulation demonstrating:

- chain position moving ahead of registration;
- registration latency;
- backlog accumulation;
- finality arriving after later entries close previous intervals.

## Verification status

Current repository evidence includes:

- unit and integration tests for wallet semantics;
- Hardhat EVM validation against ERC-8415 reference implementations;
- documented Sepolia engineering validation run (2026-09-19).

The Sepolia run validates the engineering path. It is not a production deployment.

Remaining validation areas:

- independent institutional registrar integration;
- production signer and custody environment;
- complete browser/mobile wallet UX;
- production operational deployment.

## ERC-8415 Kit and Oracle integration boundary

The intended ecosystem architecture is:

```
Application
    |
Oracle
    |
ERC8415-Kit
    |
ERC-8415
```

8415Wallet is an independent wallet product.

It may consume ERC-8415 projection data through an application/infrastructure integration layer, but it is not part of ArtFi and does not embed Oracle business logic.

The current repository contains the wallet-side adapter direction; production Kit integration remains an integration stage rather than a completed production dependency.

## Architecture principle

```
User
 |
8415Wallet
 |
ERC-8415 reader / transaction layer
 |
ERC-8415 conforming asset
```

The wallet intentionally does not collapse protocol signals:

- finality is not freshness;
- a pending registration gap is not rejection;
- blockchain ownership is not automatically confirmed registration.

## What it does not do

8415Wallet is a protocol client, not an authority system.

It does not:

- adjudicate legal title;
- decide remedies between parties;
- provide investment or compliance ratings;
- write directly into the register projection;
- override register history.

It reports protocol facts. Applications and users decide how those facts are used.

## Known development gaps

1. Error classification and network failure handling hardening.
2. Security review of transaction and identity boundaries.
3. Production-grade Kit integration verification.
4. Browser/mobile wallet UX.
5. Institutional registrar and source integration.

These are delivery items. They do not change ERC-8415 semantics.

## Documents

- [AGENTS.md](AGENTS.md) — engineering rules and semantic boundaries;
- [docs/ERC-8415-Wallet-PRD.md](docs/ERC-8415-Wallet-PRD.md) — product requirements;
- [docs/STAGE-DELIVERY.md](docs/STAGE-DELIVERY.md) — delivery evidence and verification history;
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — backend integration and conformance requirements.

The ERC specification remains the source of truth.

## Development

Node 22.18 or newer.

```sh
npm install
npm run verify
npm run wallet
```
