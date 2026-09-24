# Development Environment

## Requirements

Node 22.18 or newer. That is where Node runs TypeScript from source without a
flag, which is what lets this project ship with no build step. The repository
has no runtime dependencies; TypeScript, the Node type definitions, solc and ethereum-cryptography are
development dependencies. Python 3 is needed for the SDK checks.

## Commands

```sh
npm install
npm run verify      # typecheck + tests
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

## Container

```sh
docker compose -f docker/compose.yaml run --rm kit
```

## Layout

```
api/         Stage 1   HTTP surface: temporal routes, admission endpoint
engine/      Stage 1   projection kernel
             Stage 2   verification engine and proof profiles
             Stage 4   settlement composition
adapters/    Stage 3   chain abstraction, mock adapter first
contracts/   Stage 3   frozen Solidity interfaces and identifier helpers
sdk/         Stage 5   JavaScript and Python SDKs
console/     Stage 6   institutional console
tests/       every stage
docker/      Stage 0   development container
```

## Rules that bind every stage

- finality is derived on query from admitted history, never stored as a flag;
- admitted history is append-only: no rewrite, no delete, no retroactive
  mutation of `effectiveAt`, commitment or holder;
- an open gap never blocks an ERC-721 transfer;
- commitment uniqueness is per token, never enforced across tokens;
- state names come from the standard: open gap / closed gap, provisional /
  final, admitted;
- no frontend talks to a chain directly; everything goes through the engine and
  the adapter layer.

The full rule set is in `AGENTS.md`.
