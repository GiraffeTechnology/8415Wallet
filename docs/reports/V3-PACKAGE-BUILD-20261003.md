# 8415wallet V3 package build report

Built 2026-10-03 from `main` at `18499967348a0f8bcc5a1a42b5bd4b9e6e1ac38e`
(tree `ea180768fa69dfefdc36c22cf53ef2fa1e97e00b`).

## Artifact

| | |
|---|---|
| File | `8415wallet-0.1.0-v3-candidate.tgz` |
| sha256 | `dfe0865657b5d95e11788a916144d1d3ad303ddf62ea4b242b8b8c26f548acc2` |
| Entries | 169 |
| Unpacked | 733,301 bytes |
| Source modules | 79, of which 13 are control modules |
| Runtime dependencies | 0 |
| Engines | node >= 22.18.0 |
| Declared status | `CANDIDATE_NOT_INDEPENDENTLY_AUDITED_TESTNET_ONLY` |

## Local results

Every figure below was produced by running the command, not copied from an
earlier report.

| Step | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass |
| Node suite | `npm test` | **812 / 812**, 108 suites, 0 failed |
| EVM suite | `npm run test:evm` | **59 / 59** |
| V3 package | `npm run pack:v3` | built, 169 entries |
| V3 external install | `npm run pack:v3:verify` | **9 / 9** install checks |
| Browser entry | `npm run wallet:browser:build` | pass, 55 modules |
| Reference client | `npm run wallet` | pass |
| Chromium journey | `npm run wallet:xiongan:smoke` | pass at 1440x1000 and 390x844, synthetic provider |

These are local results on one machine. They are not CI, and they are not
acceptance.

## Why this is not version 3.0

The build refuses to present itself as a release, and that refusal is enforced
rather than conventional:

```js
// scripts/package/build-v3.mjs
/** The candidate ships the control surface; what it must never ship is a claim. */

// scripts/package/verify-install-v3.mjs
check('ships as a candidate, not a release',
  installed.version.endsWith('-v3-candidate') && /not independently audited/i.test(installed.description) && ...)
```

Renaming the artifact to `3.0.0` fails `pack:v3:verify`, which runs in CI.
The package manifest states the reason in its own `openGates` field:

```
public-testnet execution
W-20 deployed same-token multi-wallet journey
independent security review
physical device journeys
```

Those are the same four gates `AGENTS.md` records as outstanding. None of them
is satisfied by a local run, a document, or a successful build.

## What is true today

- The source is complete and the full local pipeline passes on `main`.
- The static wallet is deployed and reachable at
  `https://xiongan.8415wallet.com/web/index.html`, and the served tree matches
  a local build of `main` byte for byte across all 62 files.
- No genuine wallet transaction has been executed against it. The deployment
  proves hosting, not use.

## What would make a 3.0 legitimate

In the order they can realistically be closed:

1. **Public-testnet execution.** Drive the deployed origin with a real wallet
   on Sepolia and record chain id, transaction hashes and the wallet used.
2. **Physical device journeys.** The same, from an iPhone and an Android
   handset, in a wallet application's in-app browser. Text-rendered or
   synthetic-provider evidence does not substitute.
3. **W-20.** One deployed same-token multi-wallet journey. This cannot be
   satisfied locally by construction.
4. **Independent security review** of the kernel, adapters, verifiers,
   deployed contracts, recovery and the optional payment integration. Local
   suites are preparation for this, never a substitute.

Until then the honest name is the one the build already uses.
