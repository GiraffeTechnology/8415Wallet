# 8415wallet V2/V3 DApp Beta installation handoff

[Download the installation ZIP](8415wallet-V2-V3-DApp-Beta-Handoff-1f4a9ae6-20261004.zip)
from this private repository using an authorized GitHub account. This is the
unchanged October 4 manual-deployment handoff with verified wallet login before
asset/history display. It is not a deployed website or a general-release claim.

## Identity and integrity

- File: `8415wallet-V2-V3-DApp-Beta-Handoff-1f4a9ae6-20261004.zip`
- Size: `11015079` bytes
- SHA-256: `df5058bec9d5c12cffb9ca10cd7ea991e46696207a50f3d2ccf47ac375681838`
- Source commit: `1f4a9ae6dd5b8b062ab4f903920cf4b39d158e36`
- Source tree: `366a1b4e744d6414dce6a1feab390a3fe1a99095`
- Source change: [PR #50](https://github.com/GiraffeTechnology/8415Wallet/pull/50)
- Source CI: [merged-main Node 22/24 run](https://github.com/GiraffeTechnology/8415Wallet/actions/runs/37209416014)

Verify the adjacent checksum before extraction:

```sh
sha256sum --check SHA256SUMS
unzip 8415wallet-V2-V3-DApp-Beta-Handoff-1f4a9ae6-20261004.zip -d handoff
cd handoff
sha256sum --check SHA256SUMS
```

Read `START-HERE-EN.md` before configuring a deployment. Select
`dapps/v2-platform/` (2.2.0-beta), `dapps/v2-xiongan/` (the V2 Xiongan tenant),
or `dapps/v3-platform/` (3.0.0-beta). Each has its own manifest and archive;
verify its hashes and extracted `SHA256SUMS`. Keep `web/` and `dist/browser/`
together, with `web/index.html` as the browser entry. `optional-sdk/` contains
separate integration packages, not substitute DApps.

8415wallet is a general-purpose wallet with existing-standard compatibility and
additive native ERC-8415 support. Its platform domain is 8415wallet.com; Xiongan
is a V2 tenant. Implemented coverage is documented inside the ZIP.

## Manual deployment and acceptance

Deployment URLs are unset. Obtain the authorized environment, exact public
origin including its confirmed port, verified testnet contract manifests and
authorized test accounts. Follow the bundled `docs/BETA-DAPP-DELIVERY.md` for a
configuration-bound rebuild and record its new hashes. Never modify or relabel
this archived package. TCP 443 is reserved for SSH on every server; no port,
listener, SSH, DNS, TLS, firewall or credential change is authorized here.
Preserve the existing origin and recovery journals.

The source CI and archived evidence cover 1,069 Node cases, 89 local-EVM cases,
package/install checks and synthetic Chromium journeys. They do not establish
genuine-wallet prompts, physical-device compatibility, deployed endpoint and
rollback acceptance, W-20 or independent security review. Follow the bundled
manual checklist to collect those observations under separate authorization.
No live deployment or real transaction was performed for this publication.

Connecting a wallet alone does not reveal assets; a verified, expiring,
origin/account/chain-bound login is required. Login is memory-only, does not
authorize transactions and does not make public blockchain data private.

Keep the repository and archived source/evidence private. The publication
commit records distribution metadata; the built artifact's source remains the
commit listed above. Later CI builds must retain their own source identities.
