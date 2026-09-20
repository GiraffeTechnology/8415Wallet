# 8415Wallet

A reference wallet and client for [ERC-8415 — Asynchronous Register Projection for NFTs](https://github.com/GiraffeTechnology/ERC-8415).

ERC-8415 projects an off-chain register onto an ERC-721 token so that any past instant resolves to exactly one confirmed holder, while the chain may still be ahead of the register. 8415Wallet is the client that exposes this distinction.

## Why a separate wallet

An ordinary wallet answers one question: *who owns this token now?* For an asset backed by an asynchronous register, that is not the same as the registered holder.

ERC-8415 keeps two sequences separate:

- **tradeable position** — `ownerOf`, which moves immediately on-chain;
- **confirmed holder** — the register record, which changes only after a valid admission.

8415Wallet shows both sequences and explains their relationship at a requested instant.

## Current implementation status (2026-09-20)

This repository has moved beyond a read-only prototype. The current implementation includes:

### Completed implementation

- ERC-8415 projection reader SDK;
- temporal queries (`entryAsOf`, `holderAsOf`, `isFinalAsOf`);
- ownership discovery from ERC-721 transfer history;
- dual-sequence display (tradeable position vs confirmed holder);
- settlement transaction builders:
  - `beginSettlement`
  - `finalizeSettlement`
  - `cancelSettlement`
- EIP-1193 transaction signer integration (external wallet/provider signing);
- Projection-based clearing reference contract (`ProjectionEscrow`);
- asynchronous registrar simulation showing registration latency and backlog behaviour;
- Kit adapter architecture and application integration path.

## Verification status

The repository contains:

- unit and integration tests for wallet semantics;
- Hardhat EVM tests against ERC-8415 reference implementations;
- a documented Sepolia test run record (2026-09-19) covering deployment, settlement flows and live-network behaviour.

The Sepolia record is an engineering validation run, not a production deployment. Remaining validation items include independent registrar operation, production signer deployment, and full application/UI acceptance.

## Architecture

```
User
 |
8415Wallet
 |
ERC-8415 SDK port
 |
Native Infrastructure Kit adapter / direct chain reads
 |
ERC-8415 conforming ERC-721 contract
```

The wallet intentionally does not collapse protocol signals into a single status:

- finality is not the same as freshness;
- a pending registration gap is not a rejection;
- ERC-721 ownership is not substituted for register confirmation.

## What it does not do

8415Wallet is a faithful record client, not an authority system.

It does not:

- adjudicate legal title or entitlement;
- determine remedies between parties;
- provide investment, compliance or risk scores;
- write directly into the projection;
- override register history.

It reports protocol facts. Applications and users decide how those facts are used.

## Known development gaps

The following items remain before production-grade deployment:

1. Complete production hardening of error classification across all network paths.
2. Complete security review of transaction and identity boundaries.
3. Production-grade Kit integration verification.
4. Browser/mobile wallet UX layer.
5. Independent registrar and institutional source integration.

These are implementation completion items, not changes to the ERC-8415 semantic model.

## Documents

- [AGENTS.md](AGENTS.md) — engineering rules and semantic boundaries;
- [docs/ERC-8415-Wallet-PRD.md](docs/ERC-8415-Wallet-PRD.md) — product requirements;
- [docs/STAGE-DELIVERY.md](docs/STAGE-DELIVERY.md) — delivery evidence and verification history;
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — backend integration and conformance requirements.

The ERC specification remains the source of truth. Where this repository differs from the standard, the standard takes precedence.

## Development

Node 22.18 or newer.

```sh
npm install
npm run verify
npm run wallet
```

CI runs verification workflows for pull requests and main branch updates.
