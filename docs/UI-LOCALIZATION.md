# Wallet interface localization

The interface has a compact, always-visible six-choice language control. English
is the default. Supported locale identifiers are `en`, `zh-Hans`, `zh-Hant`,
`fr`, `es` and `ja`. The short labels are paired with native-language accessible
names and the active choice is exposed with `aria-pressed`. The document's
`lang` follows the selected locale.

## Fixed presentation catalogs

`web/locales/` contains fixed, immutable message catalogs. No remote
translation service, automatic browser translation, CDN or additional credential
is used. The explicit owner request permits multilingual interface strings;
source identifiers, engineering documentation and pull-request prose remain
English.

`web/i18n.mjs` owns UI messages, one-pass literal interpolation, plain-text
rendering and presentation bindings. Unknown saved locale IDs fall back to
English; blocked local storage does not prevent switching. The only persisted
preference is `8415wallet.ui.locale.v1`. Locale selection is not an authentication
session and never restores account access after reload.

Switching updates existing text nodes and accessible labels. It does not rebuild
forms, navigate, read a provider, rerun a transaction, reset a consent checkbox,
change a review digest, or modify submitted values. Cached presentation data is
re-rendered without refreshing a chain observation. Existing expiry and logout
handlers clear private displays and their presentation bindings, including
one-time enrollment secrets and recovery codes.

## Token and transaction boundaries

Token names, symbols, descriptions and other metadata retain the exact decoded
source strings accepted by the existing metadata validator. There is no metadata
translation, normalization or replacement by a catalog match. Untrusted JSON
cannot forge the identity-based internal presentation markers. All output is
written with `textContent`; token-supplied markup remains literal text.

Addresses, hashes, token IDs, chain IDs, protocol function/enum identifiers,
raw integer amounts, original user-supplied terms and signatures retain their
original meaning and values. Technical JSON keys remain stable. Decimal display
formatting uses `BigInt` for the integer component and never rounds or converts
a transaction amount through `Number`. It affects a separate human-readable
amount only. The raw amount and transaction object are unchanged.

Native ERC-8415 renderers accept an optional presentation callback; its default
is identity, preserving existing English SDK and CLI output. The browser binds
the original view with its renderer, then localizes known first-party labels and
prose on each paint. Template matches are anchored to compile-time English copy.
Only explicitly enumerated nested first-party labels/prose are translated inside
captures. Addresses, hashes, numeric facts and other captures remain literal.
RPC revert reasons are explicitly excluded from translation.

Settlement review and Clearing observation localization uses separate display
copies of known first-party prose fields. It never changes the reviewed object,
its canonical digest, preflight outcome codes, parameters or protocol state.
Finality, contest, freshness, legal identity and payment remain separate facts
in every catalog. Source-only signed terms remain source-only.

## Scope and verification

This change localizes the existing V2/V3 browser implementation. It does not
claim that the separately approved Figma layout has been implemented or that a
reference site's pixels were matched. No deployment, genuine wallet operation,
physical device acceptance or independent security audit is implied.

Required checks include:

- Exact key and placeholder parity for all six catalogs, translated fixed
  disclosures, invalid preferences and storage-denial fallback.
- Locale switches during login/enrollment, after logout and during an existing
  transfer review; no added provider calls, repeated sends, consent changes or
  private-data revival.
- Exact metadata/amount/address/digest preservation and literal rendering of
  adversarial metadata, braces and forged JSON markers.
- Native renderer output and first-party review prose in all locales, while
  original view/review objects and opaque revert reasons stay unchanged.
- Existing full Node, typecheck, local EVM, browser build and package checks.
- `node scripts/controls/i18n-ui-smoke.cjs`: real Chromium, both release profiles,
  all six locales, desktop and phone-width viewports, using only a synthetic
  provider and local fixture. Screenshots and assertions are emitted in the
  existing CI matrix. Viewport emulation is not physical-device acceptance.

A blocked browser launch or unavailable CI runner is not a browser pass. Merge
requires all required checks for the exact final head to be green. Earlier
immutable release archives are not replaced by this source change.
