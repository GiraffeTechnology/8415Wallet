# ERC-8415 Wallet AGENTS.md

## Product Boundary

8415Wallet is an application-layer wallet/reference client for ERC-8415 temporal projection semantics.

It is NOT:

- a generic NFT wallet;
- an ERC-3643 wallet clone;
- a token trading application;
- a replacement for ERC-8415 protocol semantics.

The wallet MUST consume ERC-8415 semantics, not redefine them.

---

## Source of Truth

Codex MUST read:

1. AGENTS.md
2. docs/ERC-8415-Wallet-PRD.md

The wallet implementation must remain aligned with ERC-8415 Native Infrastructure semantics.

---

## Core Semantic Rules

The wallet MUST support:

- holderAsOf(tokenId, instant);
- entryAsOf(tokenId, instant);
- isFinalAsOf(tokenId, instant);
- provisional/final distinction;
- admitted projection entries;
- open gap / closed gap awareness.

The wallet MUST NOT assume:

- current owner == historical holder;
- blockchain confirmation == legal finality;
- proof verification == finality;
- gap closure == finality;
- cancellation == rejection event.

---

## Application Boundary

The wallet is a consumer of ERC-8415 infrastructure.

Architecture:

User
 |
Wallet UI
 |
ERC-8415 SDK
 |
Projection / Admission Infrastructure
 |
ERC-8415 Contract

---

## Development Rules

Every stage requires:

- implementation;
- tests;
- documentation;
- delivery evidence.

Do not create protocol changes inside the wallet project.

Do not introduce rollback or veto semantics.

---

## Completion Requirement

The wallet is complete only when users can understand:

- current execution state;
- projected holder state;
- provisional vs final status;
- evidence/admission context;
- settlement gap status.
