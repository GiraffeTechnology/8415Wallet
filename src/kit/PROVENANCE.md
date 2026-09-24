# Provenance

The code under `src/kit`, together with `contracts/`, `conformance/`,
`docker/` and `docs/kit/`, came from the ERC-8415 Native Infrastructure Kit
(`GiraffeTechnology/ERC8415-Kit`) at commit `d3e9645`, which is dedicated to
the public domain under CC0-1.0. This repository carries the same dedication.

It was merged rather than depended on. The two codebases had converged on the
same protocol model from opposite ends — the Kit's `tsconfig.json` was
byte-identical to the wallet's but for its `include` list, and both were
Node 22 ESM running TypeScript from source with no build step and no runtime
dependencies — and each had grown its own Ethereum reader, ABI codec,
projection type model and conformance notion. Keeping two of each in step
across two repositories was work with no product in it.

## What changed in the move

- Paths. `engine/`, `api/`, `adapters/`, `sdk/` and `console/` now sit under
  `src/kit/`; the Kit's tests are under `tests/kit/`; its documents under
  `docs/kit/`. Relative imports within the Kit tree are unchanged.
- `tests/kit/contracts.test.ts` and `tests/kit/adapter.test.ts` now hash with
  this repository's own Keccak-256 instead of `ethereum-cryptography`. This
  removed a dependency and, more usefully, made the check cross-cutting: solc
  produces the ABI from the Solidity interfaces, this repository's Keccak turns
  those signatures into selectors, and the two are compared. Neither derivation
  can see the other's inputs.
- `tests/kit/repositoryStructure.test.ts` asserts the merged layout. Its two
  substantive checks — the frozen interface identifiers, and that the removed
  v1.0-era task documents have not returned — are unchanged.
- The Docker image and compose service were renamed off the Kit's path.

## What did not change

No file under `src/kit`, `contracts/` or `conformance/` had its behaviour
altered by the merge. The Kit's own test suite runs here as it ran there, and
`npm run verify` is a single gate over both halves.
