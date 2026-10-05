# 8415wallet

8415wallet is a general-purpose wallet compatible with existing wallet and asset standards, with native [ERC-8415 asynchronous register projection](https://github.com/GiraffeTechnology/ERC-8415) support. Its native projection views show the ERC-721 tradeable position separately from the register-confirmed holder, temporal finality, open gaps and chain freshness. Record agreement does not verify legal identity or title.

## V2 and V3 DApp Beta

- **V2 Beta:** the retained wallet PRD v2.2 foundation, sections 1–8: standalone projection and temporal views, dual histories, disclosure, conformance and identity checks, the three protocol settlement transactions, and legacy single-trade clearing.
- **V3 Beta:** the same standalone foundation plus wallet PRD v3.0 section 9: accepted linked responsibilities, permanent completed-prefix detachment, bounded returns, separate optional payments and committed detached history. The acceptance matrix includes W-01 through W-24.
- **Product and platform:** the product is 8415wallet and its UI platform domain is 8415wallet.com. Xiongan is a V2 tenant, identified separately from the product.

Both DApp packages are functional-testing Betas. Genuine wallet/public-testnet, physical-device and W-20 deployment evidence is collected after deployment; it is not silently supplied by local tests. The code is not independently audited. SDK tarballs are separate integration artifacts and do not replace either DApp.

See [DApp packaging and deployment](docs/BETA-DAPP-DELIVERY.md), [PRD coverage](docs/BETA-PRD-COVERAGE.md), and [the Xiongan tenant boundary](docs/XIONGAN-WALLET.md).

## Login methods

Assets and history stay hidden until login. Choose password, an authenticator
code (Google Authenticator / FreeOTP), a local wallet/private-key signature, or
a configured hardware CA token. OTP means RFC 6238 TOTP; email OTP is not used.
Password, TOTP and CA methods require the same-origin authentication service and
an independently provisioned account-to-wallet binding. Local wallet signing
still works in a static deployment. Keys stay in the wallet or hardware device;
login never approves a transaction.

[Account authentication](docs/ACCOUNT-AUTHENTICATION.md) covers setup, encrypted
TOTP storage, recovery codes, revocable sessions, hardware-CA adapter requirements
and deployment inputs. The generic CA bridge is implemented and cryptographically
tested; a specific physical device/middleware is not yet accepted. No production
credentials or services are provisioned by the feature. The old immutable handoff
archive is unchanged and does not contain these new login methods.

## Build and verify

Use Node 22.18 or newer and the committed lockfile.

```sh
npm ci
npm run verify
npm run wallet:browser:build
npm run wallet
npm run pack:dapp:all
```

The package manifests record exact source commit/tree, PRD hash, runtime hashes, profile, entry point and build commands. A shared runtime is explicit: V2 enables its standalone feature profile; V3 additionally enables linked responsibility controls.

The local reference server is `npm run wallet:browser:serve`. Its loopback address is for development only. Deployed URLs must contain the confirmed scheme, hostname, port and entry path. TCP 443 is reserved for SSH on CTYun and SIN; do not guess a replacement port or rewrite an origin used by an unresolved browser journal.

## Protocol and custody boundaries

- The wallet consumes ERC-8415; it does not change its frozen interfaces or invent a rejection state.
- `ownerOf`, register holder, temporal finality, open-gap contest and optional chain freshness remain separate facts.
- An off-chain read is a snapshot. Integrating contracts should use atomic on-chain reads for dependent actions.
- Standalone use does not require ArtFi, Oracle, a linked wallet, or a payment adapter. The optional Kit adapter accelerates projection reads while chain facts remain chain reads.
- A linked leg completes only when both owner and admitted-holder evidence reach its buyer occurrence or later in the same accepted chain. Completion is an application outcome, not ERC temporal finality.
- Only completed prefixes detach. Later returns stop at the live boundary; optional payment failures cannot reactivate a detached obligation.
- The browser uses the owner's external wallet provider. It accepts no private key, mnemonic, imported signature or standing signing permission.
- Unknown outcomes remain durable and cannot be silently retried. A direct standard wallet rejection is distinct from a transport failure, lost response or unverified replacement.

## Existing assets and standards compatibility

The external-account companion supports ETH and explicitly configured ERC-20, ERC-721 and ERC-1155 transfers on Ethereum, Base and their supported testnets. It is a separate custody surface from ERC-8415 controlled accounts. It has no automatic NFT discovery, swaps, bridges, arbitrary calldata or delegated keys. Mainnet reach of that surface is not authorization to test with real assets; deployment testing uses authorized testnet assets only.

The normal DApp control manifest and agent-request paths require supported testnets. Direct SDK integrators must enforce their own chain policy; the DApp restriction is not a global SDK mainnet barrier.

Compatibility is a product requirement across existing standards; the native ERC-8415 feature does not restrict the product to ERC-8415 assets. See the [implemented and tested compatibility matrix](docs/STANDARDS-COMPATIBILITY.md) for exact operations, evidence and remaining integration limits. This Beta does not claim exhaustive validation of every standard or token implementation.

## SDK artifacts

`npm run pack:v2` and `npm run pack:v3` create SDK/CLI tarballs; `pack:v2:verify` and `pack:v3:verify` test installation from outside the checkout. The V2 SDK intentionally excludes the linked control/browser surface. The V2 DApp remains a separately built browser deliverable.

## Requirements and historical evidence

- [Wallet PRD](docs/ERC-8415-Wallet-PRD.md): retained V2 foundation and additive V3 requirements.
- [V2 closeout](docs/V2-CLOSEOUT.md): dated semantic evidence and its asynchronous-registrar limitation.
- [Integration boundaries](docs/INTEGRATION-BOUNDARIES.md): protocol, custody and SDK responsibilities.
- [Public evidence](docs/public-evidence/README.md): exact historical runs.
- [Stage delivery history](docs/STAGE-DELIVERY.md): implementation and verification history.
- [September local validation](docs/reports/V3-LOCAL-VALIDATION-20260925.md): historical source-bound results.

Earlier Sepolia receipts and test totals remain evidence for their named versions. They do not validate a newer source tree, artifact or deployed origin. Current CI and build evidence must identify the exact tested commit; publication, merge and hosting do not themselves establish full PRD acceptance.

## Login before viewing assets

The public entry stays open. A verified, origin/account/chain-bound wallet login
is required before assets, balances, holdings, histories and recovery journals
are loaded or displayed. Login is memory-only and must be repeated after reload;
connecting an account alone is insufficient. See [wallet login and its exact
privacy boundary](docs/WALLET-LOGIN.md). Public blockchain data remains public, and
this client-side gate is not private-API authorization.

## Interface languages

The browser UI supports English, Simplified Chinese, Traditional Chinese, French,
Spanish and Japanese through fixed source catalogs and a compact language control.
Token metadata remains source-original. See [UI localization](docs/UI-LOCALIZATION.md)
for privacy, transaction-value and verification boundaries.
# Authentication deployment preparation

The Xiongan account-service and browser-local authenticator QR preparation is
documented in [AUTH-PROVISIONING-PREPARATION](docs/AUTH-PROVISIONING-PREPARATION.md).
The service/proxy templates are **not activated**; the public template has no
account binding and intentionally cannot start. New regression sources have not
been run in this preparation. Existing UI deployment and test evidence are not
promoted to genuine authentication acceptance.
