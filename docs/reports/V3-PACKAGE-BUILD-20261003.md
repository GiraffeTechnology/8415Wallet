# 8415wallet V3 package build report

Built 2026-10-03 from `main` at `18499967348a0f8bcc5a1a42b5bd4b9e6e1ac38e`
(tree `ea180768fa69dfefdc36c22cf53ef2fa1e97e00b`).

## Artifact

| | |
|---|---|
| File | `8415wallet-3.0.0-beta.tgz` |
| sha256 | `dfe0865657b5d95e11788a916144d1d3ad303ddf62ea4b242b8b8c26f548acc2` |
| Entries | 169 |
| Unpacked | 733,301 bytes |
| Source modules | 79, of which 13 are control modules |
| Runtime dependencies | 0 |
| Engines | node >= 22.18.0 |
| Declared status | `BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED` |

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

## Why this is 3.0.0-beta and not 3.0.0

The build still refuses to present itself as an accepted release, and the
refusal is still enforced. What changed is that the check now tests the claim
instead of one spelling of it:

```js
check('ships as a pre-release, not an accepted release',
  /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(installed.version) &&
  /not independently audited/i.test(installed.description) &&
  notice.includes('NOT_INDEPENDENTLY_AUDITED'), installed.version);
```

Exercised in both directions: `3.0.0-beta` passes 9 of 9, and removing the
pre-release tag to make it `3.0.0` fails that check at 8 of 9.

The earlier form required the version to end `-v3-candidate`, which blocked a
beta on a naming detail rather than on anything about the artifact.

## Gates, restated for a beta

Three of the four previously listed gates were not preconditions at all.
Public-chain execution, physical device journeys and W-20 are what a beta
exists to collect; listing them as blockers describes the build as waiting for
its own purpose. They are now recorded as `betaCollects`.

Independent security review is different in kind, so it is recorded as
`beforeGeneralRelease` rather than as a blocker. What makes that tolerable is
where the mainnet reach actually sits:

| Surface | Mainnet reachable |
|---|---|
| Control kernel: responsibility chains, forwards, detachment, returns, payments | **No.** `web/app.mjs` refuses a non-testnet deployment with `CONTROL_TESTNET_REQUIRED`; `src/xiongan/agentRequest.ts` refuses a non-testnet agent request with `AGENT_TESTNET_REQUIRED` |
| Asset transfers: ETH, ERC-721, ERC-1155 | Yes, including Ethereum mainnet and Base. This layer holds no key and sets no amount ceiling; the final authority is the user's own wallet confirmation |

The large, novel, unaudited surface already cannot touch mainnet. The part that
can is a thin wrapper over a transaction the user's wallet confirms.

For functional testing, set the wallet to Sepolia before connecting.

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
