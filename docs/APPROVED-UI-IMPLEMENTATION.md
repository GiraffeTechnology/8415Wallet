# Approved wallet UI implementation candidate

## Design source

Figma file: https://www.figma.com/design/GC1LZrwILgOzni1VuhzsgM

The implementation follows the approved light wallet system, with the desktop
overview at 6:2, native detail 6:3, transfer 6:4, review 6:5, receive 6:6,
activity/recovery 6:7, V3 responsibilities 6:8, NFT detail 15:414, mobile overview
7:1021, password 10:422, authenticator 10:423 and tenant identity 10:427.
The functional implementation retains explicit configuration, full addresses,
raw integer amounts and protocol disclosures instead of design sample values.

This is a candidate port, not a claim of rendered/pixel-equivalent acceptance.
The local Chromium process cannot start in the current execution environment:
its singleton socket creation returns EPERM. All rendered checks must run on a
working Chromium executor before this candidate is accepted. No browser/device
pass should be inferred from Node DOM fixtures, screenshots of Figma, or a source
review. The added CI journeys are mandatory, not an alternative to that gate.

## Original assets

The giraffe is the supplied 931 by 931 JPEG, copied without editing, resizing,
recoloring, cropping, tracing or re-encoding. It is rendered with object-fit:
contain at an equal-width/equal-height display slot.

- File: `web/assets/giraffe-original.jpg`
- Bytes: 76,616
- SHA-256: `08f239d0eebdd0aa2b8fe09345c50297405db8e2345fa7304b205b65ad126c3c`

Non-brand SVGs are verbatim current Figma SVG_STRING exports, not redraws:
wallet 5:7, grid 5:37, clock 5:33, settings 5:60, shield 5:29, down 5:19 and
link 5:43. Their 24 by 24 roots, paths, per-path caps/joins and link clip are
preserved. Current settings circles have the actual ink fill. Temporary Figma
URLs are not used in shipped code. DM Sans 400/500/600/700 is served locally;
the SIL Open Font License is included beside the font files. No asset loading
contacts a font CDN, artwork server or tracking origin at runtime.

## Preserved boundaries

- General-purpose wallet: ERC-721/ERC-1155 NFT holdings and native ERC-8415 are
  first; ETH and ERC-20 operations remain available.
- V2 platform, V2 Xiongan tenant and V3 platform are distinct validated release
  profiles. The Xiongan profile does not enable V3 responsibilities.
- Login remains verified and revocable/expiring under the existing adapters.
  Navigation, locale, avatar and account connection cannot authenticate anyone.
- Password, TOTP, local challenge signing, registered wallet and hardware CA
  flows use the existing service/provider boundaries. There is no email OTP,
  key-entry form, production credential or new server authentication path.
- Reviews show full recipient/account/contract fields and exact raw amounts.
  Dismissal, Escape, changing inputs, logout and identity changes preserve the
  existing invalidation checks. Navigation never signs or sends.
- Current owner, confirmed holder, finality, contest/gap and freshness remain
  distinct. Current-finality=true is displayed as a protocol inconsistency,
  not a green settled state. An error never substitutes owner for holder.
- Native transaction initiation and external submission invalidate all affected
  summary snapshots. They must be explicitly read again, including after an
  unknown transaction outcome. No automatic retry is introduced.
- NFT reads use an exact standard, contract and token ID, strict ERC-165 probes,
  pinned-block revalidation and current-account checks. ERC-721 owner and
  account-held quantity are separate; ERC-1155 integer quantities remain exact.
  Reads do not mutate operation journals, fetch metadata/artwork, or sign.
- Tenant avatars are optional browser-local preferences keyed by actual origin,
  release profile and tenant ID. They do not modify the platform logo, tenant
  name, host, authentication service or server configuration. See TENANT-AVATAR.md.
- Token-provided metadata and signed terms remain unchanged in all six locales.

## Validation and release gate

Run typecheck, Node tests, the local EVM suite, browser build, all existing
synthetic browser suites plus `scripts/controls/approved-ui-smoke.cjs`, and the
DApp/SDK integrity and install tests. The new browser matrix includes desktop
and mobile viewports for V2 platform, V2 Xiongan and V3 platform. The existing
six-language matrix is preserved. Browser helper navigation uses visible UI
controls and never changes hidden/inert or bypasses login.

Required CI must be green at the exact published head before merge. Local
passes do not substitute for hosted CI. Artifacts from an unmerged branch are
candidates, carry their exact source identity, and must not replace an earlier
approved release. Genuine wallets, hardware CA devices, public-testnet
transactions and independent security acceptance remain separate gates.
