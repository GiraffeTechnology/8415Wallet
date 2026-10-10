# 8415Wallet delivery archive inventory

This directory preserves the historical and candidate archives listed below. New GitHub-safe copies have explicit `-github-safe` filenames. Keep the repository public for investor review. Follow the [current installation-asset publication policy](../../docs/INSTALLATION-ASSET-PUBLICATION.md).

## Download and verify

Download the files listed in `manifest.json`, retaining their repository-relative layout. Run `sha256sum --check SHA256SUMS` from this directory to verify the newly published ZIP files. The checksum list uses their exact published names. Reconstructed full ZIPs have separate hashes in the manifest; they are not additional downloads.

The manifest distinguishes the original archive identity from the distributed GitHub-safe bytes. The two hashes must not be interchanged. Application source identity remains separate from the commit that publishes these archives.

## Archive versions

- [8415wallet-UI-Beta-CANDIDATE-bc203c72.zip](8415wallet-UI-Beta-CANDIDATE-bc203c72-github-safe.zip): candidate
- [8415wallet-V2-V3-DApp-Beta-Handoff-1f4a9ae6-20261004.zip](../2026-10-04-login-beta/8415wallet-V2-V3-DApp-Beta-Handoff-1f4a9ae6-20261004.zip): historical
- [8415wallet-v3-beta-review.zip](8415wallet-v3-beta-review-github-safe.zip): historical
- [Xiongan-DApp-Branch-Sync-Recovery-8c786de7-20261003.zip](Xiongan-DApp-Branch-Sync-Recovery-8c786de7-20261003-github-safe.zip): historical
- [Xiongan-Wallet-Checksum-Repair-Recovery-93934f9-20261003.zip](Xiongan-Wallet-Checksum-Repair-Recovery-93934f9-20261003-github-safe.zip): historical
- [Xiongan-Wallet-SIN-Handoff-763b0067.zip](Xiongan-Wallet-SIN-Handoff-763b0067-github-safe.zip): historical

## Interpretation

Candidate and historical labels describe archive status only. This archive publication does not establish a release, deployment, current-head CI result or genuine-device acceptance, and it makes no application changes.

GitHub-safe copies include their applicable publication and omission notices. For their extracted contents, follow the current-copy checksum instructions included in each archive. References marked `HISTORICAL-REFERENCE` preserve provenance and are not current-copy verification commands.

The existing October 4 Wallet ZIP stays at its original path, unchanged and without a duplicate mirror. Its SHA-256 is `df5058bec9d5c12cffb9ca10cd7ea991e46696207a50f3d2ccf47ac375681838`, its source commit is `1f4a9ae6dd5b8b062ab4f903920cf4b39d158e36`, and its first publication commit is `909a2b39590467da326ac7e120e431319f75f8f9`. Verify it using the checksum file in that original directory.

The UI candidate has source commit `bc203c7225e5e8898cdff3303981c9ef63b8f931`; preserving it here does not change its candidate status.
