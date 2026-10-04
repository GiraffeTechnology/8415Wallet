# 8415wallet V3 Beta SDK package

Status: **NOT_INDEPENDENTLY_AUDITED** · functional-testing Beta · not general-release acceptance.

This tarball ships the surface the V2 package deliberately leaves out: the
responsibility control kernel, its adapters and readers, the linked chain
views, and the browser entry. It is prepared as a Beta SDK for installation, integration and review. The
versioned DApp archives are separate deliverables; this SDK does not replace
the V2 or V3 browser package.

## What you get

| Export | Contents |
| --- | --- |
| `8415wallet` | the standalone reading client and the linked chain views |
| `8415wallet/controls` | responsibility controls: consent review, client, readers, payments, detached history |
| `8415wallet/controls/node-store` | the Node operation journal store |
| `8415wallet/browser` | the browser entry the reference UI is built on |
| `8415wallet` (bin) | the command-line reference client |

Node 22.18 or newer. No runtime dependencies.

## What this package is not

- **Not audited.** No independent security review has been performed on the
  kernel, the adapters, the verifiers, the deployed contracts, recovery or the
  optional payment integration. Local suites are preparation, never an audit.
- **Not full public-chain acceptance.** Historical real Sepolia deployments
  and transactions exist. They do not establish a complete, source-bound
  W-01–W-24 result for every new package. A rehearsal is not a public-chain run.
- **Not a mandate to hold value.** Use test networks. The kernel is an
  uncommitted proposal generator, not execution authority. Authenticated atomic
  adapters and alternate-path protection exist as development source; their
  exact integration still requires independent review and release acceptance.

## What has been established

Historical development batches include TypeScript and EVM regressions,
typechecking, browser compilation and a Chromium journey at desktop and
emulated phone viewports. Building this package does not rerun those batches
or bind their outcomes to its new source commit. The historical figures live in
`docs/V3-REVIEW-AND-VALIDATION.md` and
`docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md`, which travel in this tarball.

`docs/INTEGRATION-BOUNDARIES.md` ships the consumer contract: forbidden
inferences, responsibility/payment separation, execution recovery and release
limitations. Development instructions and coordination records do not ship.
Deployment and tests use CTYun/SIN Linux environments, not Windows hosts.

## External-account companion and tenant identity

The product is 8415wallet; Xiongan is a V2 tenant. The browser entry
additionally exports the external-EOA companion. It
recognizes Ethereum/Base and their selected testnets for ETH and standard NFTs;
this source capability does not change the testnet scope of Beta control
acceptance. Normal DApp control inputs enforce supported testnets, while direct
SDK consumers must supply their own chain policy. Do not treat mainnet recognition as authorization to fund an unreviewed
client. The owner remains responsible for each genuine-wallet signing/submission
decision. No agent key, standing grant or autonomous signer is included. Read
`docs/XIONGAN-WALLET.md` for its separate custody and recovery scope. See `docs/BETA-DAPP-DELIVERY.md`
for the actual deployable DApp artifacts.
