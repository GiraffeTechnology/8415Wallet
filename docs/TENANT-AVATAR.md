# Optional browser-local tenant avatar

The tenant avatar is a local presentation preference. It is **not a global or
server tenant profile**, an account avatar, a verified identity, a login factor,
or transaction authority. It never replaces the supplied Giraffe platform logo.
The approved UI must retain the platform brand and place this image only in an
explicitly labelled tenant-avatar badge/settings preview.

## Boundary and persistence

- Scope: validated release origin (scheme, host and port), release profile ID
  (`v2`/`v3`), and tenant ID. Tenant labels and wallet-account addresses are not
  keys. V2 Xiongan remains distinct from the V3/default tenant.
- The caller supplies the resolved `getReleaseProfile()` result. The avatar
  module revalidates its release identity, tenant and deployment, verifies the
  actual location against configured deployment URLs, and refuses opaque origins
  and insecure non-loopback HTTP origins. Unconfigured development releases are
  still bound to the actual browser origin.
- Storage: IndexedDB database `8415wallet-local-tenant-avatars-v1`, store `avatars`.
  Each row contains only schema, full context key and raster `Blob`. File names,
  credentials, account/session data and image URLs are not persisted.
- Saving changes only this browser profile on this origin. Other browsers,
  devices, ports, tenants and release profiles do not inherit it. Same-origin
  scripts and people sharing this browser profile can access it; this is not an
  authorization or confidentiality boundary. Clearing site data removes it.
- There is no network upload, remote-image fetch, auth-service call, global
  configuration write, localStorage fallback or claimed server synchronization.
  Simultaneous saves in different tabs use last committed write semantics;
  there is no cross-tab synchronization guarantee.

Suggested settings disclosure: “Saved in this browser only for this tenant and
release. This does not change the tenant profile on other devices.”

## Raster validation

`AVATAR_LIMITS` currently permits at most 2 MiB, dimensions 1–2048 pixels per
axis, and at most 4,194,304 decoded pixels. PNG, JPEG and WebP are the only
accepted MIME types. The module checks the actual binary signature/container
header, verifies MIME agreement, bounds declared dimensions before image decode,
then requires a successful browser decode and bounded decoded dimensions.
Decoded dimensions must match the header (JPEG orientation may exchange axes).
Persisted images go through the same validation again before display.

SVG, GIF, HTML, remote URLs, data-URL strings, missing/other MIME types, forged
MIME headers, excessive dimensions, empty/oversized files and decoding failures
are refused. An extension or file-picker `accept` filter is not validation.
Original raster bytes are retained; there is no crop, metadata stripping,
re-encoding or guarantee that raster animation is removed. The feature does not
send raster metadata anywhere.

The default decoder uses `createImageBitmap` and closes its bitmap. A browser
without it uses an `Image` loaded from a short-lived local object URL, revoked on
success, refusal or cancellation. No remote-image path exists.

## Integration API

Exports from `web/tenant-avatar.mjs`:

- `TenantAvatarError`: stable `code` and matching message, with no provider error
  text, private file names or uncontrolled decoder messages.
- `AVATAR_LIMITS`: immutable byte/dimension/pixel limits.
- `createTenantAvatarContext(profile, location)`: frozen origin/profile/tenant
  scope. Store APIs accept only contexts returned by this validator.
- `validateTenantAvatar(blob, { signal, decodeImage })`: validated raster record
  `{ blob, mime, width, height }`. Decoder injection is for deterministic tests;
  production should retain the default browser decoder.
- `BrowserTenantAvatarStore`: IndexedDB adapter with `read(context, options)`,
  `write(context, validatedAvatar, options)`, `remove(context, options)`.
  `options` may contain an `AbortSignal` and an `isCurrent()` revision guard.
  `read` returns a raster Blob or null. Transaction request success is not
  completion: writes/removals resolve only after transaction completion.
- `TenantAvatarController({ store, decodeImage, urlApi })`: UI-independent
  controller. Production can construct it with no options.

Example (the controller never reads or writes DOM):

```javascript
const avatar = new TenantAvatarController();
avatar.setContext(await getReleaseProfile(), window.location);
renderTenantAvatar(await avatar.load());

// A user's local file selection only stages a preview.
renderAvatarSettings(await avatar.select(fileInput.files[0]));
// Separate explicit Save / Cancel / Remove controls:
renderTenantAvatar(await avatar.save());
renderAvatarSettings(avatar.cancel());
renderTenantAvatar(await avatar.remove());
```

Catch every async refusal; show a localized, fixed message keyed by `error.code`.
Do not echo raw exceptions. `snapshot()` returns a frozen value containing:

- `context`, `savedUrl`, `previewUrl`
- `hasSaved`, `hasDraft`
- `status`: `unavailable`, `empty`, `loading`, `validating`, `draft`, `saving`,
  `saved`, `removing`, or `error`
- `errorCode`: null or a stable refusal code

Render `savedUrl` in the tenant badge; render `previewUrl ?? savedUrl` in
settings. If either is null, remove the image `src` and render a text/initials
fallback. Do not copy these URLs into persistent storage, a release file or
platform-brand elements. Use `textContent` for tenant labels and localized
status messages. Keep a visible browser-local disclosure, size/type hint and
accessible file-input label. Cancel/Close/Escape should call `cancel()` and
clear the file input so the same file may be selected again.

Only call `save()` after `select()` completes. `cancel()` preserves the last
confirmed saved image. A failed save retains its draft for retry, and a failed
removal preserves the last confirmed saved image. Storage-disabled/private-mode,
quota and transaction errors are surfaced, never described as saved. The UI
should keep avatar failure separate from wallet operation/authentication status.

Call `setContext` before loading a new release/tenant and `dispose()` when the
controller/page is no longer needed. `setContext` always clears old displayed
and draft images, including if the new context is refused. Call `cancel()` when
a settings dialog is dismissed or authentication invalidation should terminate
an outstanding edit; this does not delete an already saved local preference.
If hiding all tenant decoration is required on logout, dispose the controller
and create/reload it only when that UI is next shown.

Each new operation cancels the previous operation. A revision guard prevents
late reads/decodes/writes from repainting a different context or newer
selection. Pending IndexedDB writes are aborted on cancellation where the
transaction is still active. Cancellation cannot undo a transaction that had
already committed before the cancel event; any such write belongs only to its
captured old context. Reopening/reloading gives the committed stored result.
Do not claim cancellation rolls back an already completed save.

All display object URLs are revoked on replacement, cancelled draft, successful
remove, context change and disposal. Late decoded image resources are closed.
The caller must stop using revoked old snapshot URLs and render the current
snapshot after synchronous cancel/context/disposal operations.

## Static hosting requirements

Add `tenant-avatar.mjs` to any static-module allowlist. CSP needs
`img-src 'self' blob:` for local raster previews. This does not require `data:`,
remote image hosts, wider `connect-src`, inline scripts, uploads or auth changes.
Retain other CSP and release-origin checks. Use the existing confirmed development
and deployment port; no listener or SSH/443 changes are part of this feature.

## Verification

`node --test tests/tenant-avatar.test.ts` covers context isolation, origin/release
refusal, all three raster formats, MIME/signature mismatch, unsafe dimensions,
file-name omission, explicit staging/save, cancellation/reselection/reload,
stale-context reads and decodes, resource cleanup, storage failures, transaction
completion/abort, corrupted rows and absence of network/auth/DOM write paths.
The IndexedDB unit fixture validates transaction-event behavior; it is not
labelled genuine browser evidence. End-to-end UI and device acceptance remain
separate from these unit checks.
