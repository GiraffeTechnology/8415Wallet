# Third-party and separately licensed material

The proprietary notice in LICENSE applies only to the expressly covered
original material owned by the identified rights holder. The materials listed
below, and any other third-party or separately licensed material, remain
governed by their applicable licenses. Listing a component does not claim
ownership of it. An omission from this inventory does not extinguish its
license or change its ownership. Specific independently applicable license
or dedication notices take precedence over a general proprietary designation
for the material they identify. The proprietary restrictions and attribution
requirements do not apply to independently licensed or public-domain material.

Preserve the original license texts and all notices required by those licenses.
Where a component has been modified, retain the required modification notices.
License texts included for third-party compliance apply to the identified
material; their inclusion alone does not license separate proprietary
material under those terms.

## Component notices

### ERC8415-Kit and separately marked interfaces and contracts

- Source: https://github.com/GiraffeTechnology/ERC8415-Kit at
  `d3e9645f4e6e833cf87dcf24817c2d5c5052edb1`; CC0-1.0.
- Imported scope and modifications are recorded in `src/kit/PROVENANCE.md`:
  `src/kit/`, `conformance/`, `docker/`, `docs/kit/`, `tests/kit/` and originating
  contracts. That record does not attribute all later contracts to the Kit.
- The full CC0 text is at `LICENSES/CC0-1.0.txt`. Independently marked Solidity
  files retain their existing SPDX identifiers and applicable terms.
- Source notices and project records identify the respective rights holders;
  no exclusive ownership or corporate copyright assignment is inferred.

### QR Code Generator for JavaScript

- Copyright (c) 2009 Kazuhiko Arase; MIT License.
- Upstream identified in its header: http://www.d-project.com/.
- `web/qr-generator.mjs` retains the full MIT permission and disclaimer text
  and upstream attribution. Static DApp packages carry that same notice.
- Its header does not record an exact upstream release. No claim that the
  vendored implementation is identical to an upstream release is made.

### DM Sans fonts

- Copyright 2014 The DM Sans Project Authors
  (https://github.com/googlefonts/dm-fonts); SIL Open Font License 1.1.
- Four bundled font files under `web/assets/` retain the complete notice at
  `web/assets/license-dm-sans.txt`. The notice's original bytes are preserved.
- The precise upstream font release is not recorded in that notice.

### jsQR test fixture

- `tests/vendor/jsqr.cjs` is accompanied by the complete Apache License 2.0
  text in `tests/vendor/JSQR-LICENSE.txt`.
- The copied license appendix does not establish a named copyright owner or
  exact upstream revision; none is invented here. The decoder is test-only,
  not a production dependency, and both vendored files remain unchanged.

### ethers and other installed dependencies

- ethers 6.17.0 is pinned by `package-lock.json`; its own MIT copyright and
  license notice remains at `node_modules/ethers/LICENSE.md`.
- The browser build copies it to `dist/browser/vendor/ETHERS-LICENSE.md`
  alongside the browser bundle. Dependency-complete auth packages retain
  the dependency's own license files.
- Other installed dependencies retain their respective licenses and notices.
  This component inventory is not an exhaustive dependency or ownership audit.

## Packaged notices

The SDKs, auth runtime, static DApp archives and complete delivery kit carry
`LICENSE`, `THIRD_PARTY_NOTICES.md` and `LICENSES/CC0-1.0.txt`. Static DApps also
carry identical copies under `web/legal/` for the installed public runtime.
QR, DM Sans and ethers notices travel with their relevant runtime assets.
Component inclusion varies by distribution; any included separately licensed
material remains subject to its applicable notices and terms.

## Explicit exclusions

The ERC-8415 specification and ERC8415-Kit retain their own applicable terms.
This notice does not modify either upstream project or relicense its material.
Specific independently applicable notices and valid prior grants control for
the material they identify. No new attribution condition is imposed on
independently licensed or public-domain material.
