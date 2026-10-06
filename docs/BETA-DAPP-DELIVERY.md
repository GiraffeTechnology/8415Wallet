# V2 and V3 deployable DApp Beta delivery

## Product, versions and scope

The product is **8415wallet**, a general-purpose wallet with existing wallet
and asset standards compatibility and native ERC-8415 support. The platform identity is **8415wallet.com**;
that identity is not a configured URL, a DNS assertion or permission to bind a
server port. The Xiongan tenant uses the **V2** profile.

| Artifact | Wallet PRD mapping | Browser capability boundary |
| --- | --- | --- |
| `8415wallet-dapp-v2-2.2.0-beta.tar.gz` | Preserved v2.2 foundation, sections 1–8 of `docs/ERC-8415-Wallet-PRD.md` | Standalone projection/temporal/history views, protocol transaction and legacy clearing paths, separately reviewed external-asset transfers, and optional account creation/deposit/unencumbered withdrawal with basic request review and recovery. Linked responsibility controls are unavailable in this profile. |
| `8415wallet-dapp-v3-3.0.0-beta.tar.gz` | Additive v3.0, sections 1–8 retained and section 9, W-01–W-24 | V2 foundation plus protected linked receipt/forwarding, completion/detachment, scoped return, optional payments, detached history and recovery. |

Both retain optional controlled-account creation, deposit, unencumbered
withdrawal, basic account-request review and recovery. V2 restricts linked
responsibility actions rather than disabling all account utilities.

Both use a shared compiled browser runtime. The profile is explicit deployment
configuration and a UI capability boundary, not on-chain authority or a claim
that every required acceptance observation has already been collected. The
exact PRD file hash, sections and scenario identifiers travel in `RELEASE.json`.
V2 does not mean version 2 of the SDK npm tarball. SDK `pack:v2` and `pack:v3`
artifacts remain separate library deliverables; they are not hosted websites.

The release status is
`BETA_FUNCTIONAL_TESTING_NOT_INDEPENDENTLY_AUDITED`. These bundles can be
published for authorized functional Beta testing. Independent security review
is not a blocker to functional Beta publication. They have not thereby passed
an independent audit, general-release acceptance, W-20, public-chain execution
or physical desktop/mobile wallet journeys. Never replace these distinctions
with a single “passed” label.

The normal DApp control-manifest and agent-request paths enforce testnet
guards. Direct SDK consumers must enforce their own chain policy; the SDK is
not a universal mainnet barrier. The separate external-asset
surface supports Ethereum, Base, Sepolia and Base Sepolia and prompts the
user's own wallet for each operation. No key is held by the DApp. Use authorized
test assets on testnets for this handoff; package creation grants no authority
to deploy contracts, spend mainnet funds, publish to a server or change its
security settings.

## Build and validate

Requirements: the repository's Node version (at least 22.18.0), npm, Git,
GNU tar and gzip. Use the lockfile. A build must run at the root of the actual
Git repository, with a valid commit object; an exported folder must first be
restored to its verified source checkout. Do not invent a commit identifier.
Stage all intended new source files before packaging. The source exporter
includes tracked files and explicitly staged additions only, with their
current working contents. It excludes untracked files, including local `.env`
files, instead of automatically adding them. An untracked browser/runtime
source file causes a build refusal until it is deliberately staged. Public
web assets are exported from those captured Git blobs, not recursively copied
from the working directory. Hidden files and non-public file extensions are
refused even when staged; remove private operational files from the web tree.

```sh
npm ci
npm run typecheck
npm test
npm run test:evm
npm run test:package:dapp
npm run pack:dapp:all
npm run pack:dapp:verify
```

`pack:dapp` remains a V3 build alias. Explicit commands are preferred:

```sh
npm run pack:dapp:v2
npm run pack:dapp:v3
npm run pack:dapp:verify -- --profile v2
npm run pack:dapp:verify -- --profile v3
```

Each builder clears and recompiles `dist/browser`, checks every static and
literal dynamic module import, refuses bare or missing module specifiers,
checks page assets and the content-security-policy declaration, and retains
the unaudited Beta disclaimer. Nonliteral dynamic imports are refused.

Outputs in `dist/`:

- `package-dapp-v2/` and `package-dapp-v3/`: extracted deployment trees
- The two versioned DApp `.tar.gz` archives listed above
- `dapp-v2-package-manifest.json` and `dapp-v3-package-manifest.json`: complete
  release identity and each DApp archive's SHA-256
- `8415wallet-source-<git-content-tree>.tar.gz`: source corresponding to the
  exact content tree used by the build, shared when both profiles use one tree

Every DApp contains `RELEASE.json`, `SHA256SUMS`, the PRD, this runbook, `web/`
and `dist/browser/`. The entry is **`web/index.html`**. Serve the complete
layout; moving the HTML to the archive root breaks its relative module paths.
The source archive is a separate handoff artifact, not a public web directory.
It is an exact content-tree review/backup export, not a Git clone: it contains
no `.git` directory or original commit objects. Its runtime sources can be
compiled after installing the lockfile, but reproducing release metadata
requires the verified Git checkout with the same original commit, index tree
and content tree. Do not create a replacement commit and claim its metadata
reproduces the original release.

`RELEASE.json` records the real Git commit, its tree, the current index tree,
the content tree including local changes, whether that tree differs from the
commit, every source file's SHA-256, the PRD SHA-256, every shipped runtime
file's SHA-256, config digest, build commands, lockfile digest and toolchain
versions. An uncommitted build is clearly marked dirty; its commit alone must
never be presented as the complete source identity. The content tree and source
archive identify those changes. The build refuses source changes during emit.

The verifier checks archive digest, exact full inventory, runtime resolution,
profile/config agreement, PRD hash and source file hashes, then reconstructs
the source archive's Git tree and compares it to the release metadata. It does
not infer that the named commit is on a remote, or that CI passed.

For a reproducibility check, build twice from the same unchanged source and
configuration with the same locked toolchain. Compare the corresponding
archive digests and manifests. For the exact command recorded in
`RELEASE.json`, copy the artifact’s public `web/release-config.json` into
`dist/release-input/v2.json` or `v3.json` in that verified checkout first. This
ignored configuration input does not change the source tree. The source
archive alone is insufficient to reproduce the original commit metadata.
Files are sorted; file modes, owners, group and
modification times are normalized; gzip stores no timestamp. Build timestamps,
local paths and deployment secrets are excluded from metadata. Different
profiles intentionally produce different DApp archives even with a shared
source archive.

## Explicit profile, tenant and endpoint configuration

Source templates are `config/releases/v2.json`, `v3.json` and
`xiongan-v2.json`. Their deployment URL is deliberately `null`; that means no
endpoint has been assigned. The source browser defaults to the V3 template.
Packaging writes the chosen template to the artifact's
`web/release-config.json` without modifying the source template.

Copy the desired template to a public deployment configuration file. Keep the
schema, product, platform and profile unchanged; set the approved tenant and
confirmed environment/URL. The configuration must contain exactly:

```json
{
  "schema": "8415wallet-release/1",
  "product": "8415wallet",
  "platform": "8415wallet.com",
  "profile": "v2",
  "tenant": { "id": "xiongan", "label": "Xiongan" },
  "deployment": { "environment": "unconfigured", "url": null }
}
```

For an assigned endpoint, replace the deployment object with its environment
(`ctyun`, `sin`, `other`, or local testing `local`) and the **complete confirmed
entry URL**, including scheme, host, any configured non-default TCP port, path
prefix and `/web/index.html`. Standard HTTPS may omit its default port. Nonlocal
endpoints require HTTPS; local HTTP is restricted to loopback. Credentials,
queries, fragments, encoded and noncanonical paths are refused. A configured
release also refuses browser actions at any different origin or entry path;
there is no preview override. Build a separate explicit local configuration
for loopback preview instead of changing a deployed release URL. Never put RPC keys, wallet keys, bearer
tokens or account credentials in this public file.

Take the web endpoint from the target environment's deployment configuration;
which ports it reserves is stated there, not here. The installer enforces
whatever that configuration lists as reserved and has no environment-specific
rule of its own. If the endpoint has not been supplied, deliver the unconfigured
artifact and record the missing endpoint instead of inventing a link: a platform
name alone is not a URL and must not be converted into an invented endpoint.


The configured URL is the **public browser endpoint**, which is not necessarily
an origin server's listener. Obtain each endpoint and listener allocation from
deployment configuration, preserving configured reservations and occupied ports.
A separately managed TLS front door and its upstream may use different ports;
record both allocations and the actual TLS termination boundary in deployment
evidence. Environment names are metadata and do not determine port eligibility.
No proxy, external service, DNS change, listener allocation or public URL is
created or authorized by this package.

```sh
npm run pack:dapp:v2 -- --config /path/to/confirmed-public-config.json
npm run pack:dapp:v3 -- --config /path/to/confirmed-public-config.json
npm run pack:dapp:verify
```

The requested profile must match the file. Xiongan with V3 is refused. Tenant
identity changes display/configuration; it does not authenticate a sender,
select a wallet account, prove a deployment or authorize a transaction.
The runtime loader fails closed on missing or malformed configuration; it must
not silently fall back from a broken V2 configuration to V3.

The separate user-imported contract deployment manifest continues to bind
chain ID, token/controller/payment addresses and exact runtime code hashes.
A website release profile never substitutes for those chain checks.

## Static host deployment checklist

1. Record the selected profile/tenant, full confirmed endpoint, source content
   tree, DApp/source archive digests and the deployer's authorization. Verify
   the artifacts before copying. Keep the previous release and its manifest.
2. Extract into a new versioned directory on the approved host, outside the
   active web root. Run `sha256sum -c SHA256SUMS` in that directory. Never
   overlay an old release with a partial extraction.
3. Configure only the already approved web listener and route. Keep `web/` and
   `dist/browser/` under one root. Direct navigation to the exact configured
   `/web/index.html` must work, including under a path prefix.
4. Serve `.mjs` and `.js` as `text/javascript`, `.json` as `application/json`,
   `.css` as `text/css`, and `.html` as `text/html`. Use `X-Content-Type-Options:
   nosniff`, `Referrer-Policy: no-referrer`, and a response CSP including
   `frame-ancestors 'none'`. Preserve the page's other restrictions. `frame-ancestors`
   is a response-header requirement, not satisfied by a meta tag.
5. Use HTTPS for a deployed nonlocal origin. Recovery journals depend on a
   secure context and durable browser storage. Do not add a service worker or
   cross-origin RPC proxy as part of this static deployment.
6. Prevent mixed release caches. Use `Cache-Control: no-store` for HTML,
   `release-config.json` and these non-content-addressed runtime module paths,
   or an equivalent versioned immutable release route with an atomic switch.
   The deployment must never mix a new page/config with old modules.
7. Check the actual status, MIME and hash of the entry, config, every page asset
   and browser module. An HTTP 200 for the page alone is not application testing.
8. Atomically switch the approved web root or release route. Do not change the
   origin, clear browser storage, or silently migrate operation journals.
9. Run the manual tests below on the exact URL. Record browser/wallet versions,
   profile, tenant, source/runtime hashes, chain/deployment identities, timestamp
   and the observed result. Record unsupported or blocked paths explicitly.

The repository loopback development server is not a production host. Its
`WALLET_BROWSER_PORT` setting is for a locally selected available test port and
does not allocate any CTYun/SIN port.

## Rollback and recovery

Restore the prior verified immutable directory using the same approved web
route and origin. Recheck its SHA-256 inventory, exact profile, config and
runtime consistency. A changed hostname, scheme or port changes the storage
origin and can strand recovery journals; changing the tenant label alone does
not migrate them. Preserve a copy of both manifests and rollback observations.

Never delete browser journals, reset wallet nonces or resend a transaction to
make a deployment look clean. A submitted hash is not completion. Unknown
submission outcomes remain blocking until reconciled using the original
account/chain/deployment and matching canonical transaction evidence. A UI
rollback cannot reverse a chain transaction or a completed responsibility.
If an older runtime cannot interpret a newer saved journal, stop execution and
use the compatible release to reconcile; do not erase or downgrade the journal.

## Manual acceptance and evidence levels

Use separate rows for each version, tenant, browser/device, wallet and chain.
Mock-provider browser tests demonstrate deterministic rendering and recovery
logic. Local EVM tests demonstrate contract/adapter behavior. Neither is a real
wallet prompt, mobile-wallet journey, deployed W-20 or independent review.
Screenshots alone cannot prove signing, chain execution or device identity.

### Shared standalone and external-account journey

- Confirm product, V2/V3 Beta label, tenant and unaudited scope at the exact
  deployment URL. Verify missing/corrupt config prevents actions. Confirm
  Xiongan identifies V2 and cannot expose linked actions.
- Open in a genuine desktop wallet extension and a supported physical mobile
  wallet's in-app browser. Connect without importing keys. Reject a connection
  prompt once, retry deliberately, and switch accounts/chains mid-read.
- Import the exact public contract manifest. A wrong chain, runtime-code hash,
  unsupported interface, unavailable RPC or malformed response must fail
  explicitly; no owner address may stand in for an unavailable holder.
- Read owner and holder separately; inspect a current provisional instant, a
  historical final instant, before-first-entry coverage, open gap, closed gap,
  cancelled settlement, settlement/ownership histories and collision scope.
  Keep finality, contest and freshness separate. Registry references stay opaque.
- Review and execute only authorized protocol/legacy-clearing test transactions
  through the user's wallet. Confirm read snapshots and actor authority remain
  visible. Legacy clearing is a single-trade pattern, not W-20 evidence.
- Prepare an external ETH/ERC-20/NFT transfer using authorized test assets. Verify the
  exact chain, account, asset, recipient and amount; reject once, repeat only
  after a genuinely new review; exercise duplicate clicks and account changes.
  No import or review alone may submit a transaction.
- Reload during prepared/submitted/unknown recovery states; reconcile without
  automatic resend. Test wallet rejection, a dropped connection, a matching
  replacement hash and explicit same-nonce replacement evidence separately.
  Persist unresolved outcomes and check wallet activity before retrying.

### ERC-20 balance and transfer

1. On an authorized supported testnet, select ERC-20 and enter the exact token
   contract. Read balance and optional metadata. Confirm the raw balance and
   actual chain/address; metadata is not identity and decimals are never assumed.
2. Enter recipient and a positive integer raw amount. For a six-decimal token,
   1000000 raw units displays as 1 only when valid decimals are returned. With
   absent/malformed optional metadata, raw-unit review remains explicit.
3. Prepare, inspect the full raw and formatted amount, token/runtime pin,
   recipient, chain/account and expiry, then acknowledge and confirm in the
   genuine wallet. No approval or allowance is requested.
4. Verify the canonical transaction/receipt and exact Transfer event, then
   acknowledge the terminal receipt. Capture the actual hash and raw output.
5. Repeat rejection, duplicate click, account/chain change, reload, lost-response
   matching-hash recovery and canonical different-transaction replacement tests.
   Missing/wrong Transfer effects must not become a success assertion.
6. Locally exercise true-return, legacy empty-return, false-return and malformed
   return fixtures. A false/malformed simulation result refuses preparation.
   Do not represent fee-on-transfer/rebasing tokens or arbitrary proxy upgrades
   as supported by these standard transfer tests.

### V3 linked journey and W-01–W-24 mapping

- W-01–W-03: establish funded AB, extend the same token to D with inherited
  conditions, and show ordinary independent registrar lag without invented
  rejection or a registrar-imposed transfer lock.
- W-04–W-06 and W-19: prove both owner and admitted-holder occurrence progress,
  process completed prefixes, show the unresolved tail, concurrent extension
  and accurate provisional protocol state. Refuse owner-only/holder-only or
  ambiguous evidence.
- W-07–W-12 and W-17–W-18: exercise accepted return D→C→B→A, then the case where
  detached AB makes B the boundary. Refund only original payers after actual
  required return. Interrupt/restart bounded hops and test races/replay/late
  admission without reactivating detached obligations.
- W-13–W-16: refuse unsupported recipient enforcement, alternate-path bypass,
  ambiguous repeated-address occurrences, RPC faults and malformed evidence.
- W-20: record one deployed same-token, genuine multi-wallet journey covering
  views, enforceable acceptance, detachment and callback, plus its funded
  segregated-payment/refund variant. Link canonical receipts and device/wallet
  observations to this exact release and deployment. Local EVM/mock results
  cannot fill this row.
- W-21: repeat responsibility acceptance, forwarding, completion/detachment and
  scoped return without a payment adapter. Payment is optional and never the
  authority for a responsibility outcome.
- W-22–W-24: extend beyond the lifetime window while enforcing 128 unresolved
  legs; detach one to free one slot; verify detached records and commitment,
  nonreusable leg IDs, live-tail reads, absolute occurrences and payment access.

Keep remaining genuine-wallet, physical-device, independent-registrar and
W-20 observations open until actual evidence is recorded. These are the
purpose of the Beta deployment/testing handoff; do not report them as already
passed merely because the deployable archives build successfully.

## Login before viewing assets

The public entry stays open. A verified, origin/account/chain-bound wallet login
is required before assets, balances, holdings, histories and recovery journals
are loaded or displayed. Login is memory-only and must be repeated after reload;
connecting an account alone is insufficient. See [wallet login and its exact
privacy boundary](WALLET-LOGIN.md). Public blockchain data remains public, and
this client-side gate is not private-API authorization.
