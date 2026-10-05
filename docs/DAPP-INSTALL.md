# Reusable 8415wallet DApp delivery

8415wallet is delivered as an installable **DApp**, with separate V2 and V3
functional-Beta profiles. SDK archives remain supporting developer artifacts.
This kit includes both compiled UIs, the dependency-complete same-origin auth
runtime and installer, public configuration tooling, exact source, verification,
static install/upgrade/rollback tooling, and this guide. Xiongan is an optional
V2 tenant preset; there is no assigned server address or deployment permission
in the public kit.

## Requirements and trust

- Install an operator-approved Node >=22.18 runtime. Node itself is not bundled.
  UI and auth installation need no npm registry or build step on the host.
  The auth component additionally needs Linux/systemd and the existing nginx
  TLS site; OpenSSL 3 is needed only for configured hardware CA verification.
- Obtain the archive's SHA-256 **and exact Git content tree** through an
  independently trusted release channel. A manifest shipped next to an archive
  is an integrity aid, not publisher authentication. Use reviewed verifier code
  from that trusted source checkout for the initial archive verification.
- Select an explicit tenant, profile, public config and dedicated absolute
  target directory. Confirm the existing full entry URL including its allocated
  port and `/web/index.html` suffix. Preserve the deployment’s configured port
  reservations; CTYun reserves TCP 443 for SSH. This is not a product-wide 443
  prohibition. Never infer a replacement port or change the browser origin.
- These commands do not authorize deployment. Production SSH/deployment remains
  with the separately authorized deployment operator. They never configure TLS,
  firewall, SSH, listeners, accounts or unrelated services.

## Build and verify a kit

From the reviewed source checkout, stage intended new source files and finish
edits before packaging. The kit builder reuses the existing DApp and auth
builders/verifiers and requires every component to have the same content tree.
Do not place local bindings, endpoints, secrets or operational logs in Git.

```sh
npm ci
npm run typecheck
npm test
npm run test:evm
node scripts/package/build-delivery.mjs
```

`--offline` asks the auth builder to use only its existing npm cache. `--reuse`
assembles already-built `dist/` components after verification and rejects a
stale source tree. Building requires Git, GNU tar/gzip and the locked development
toolchain. Installing the resulting kit does not.

Outputs are `dist/8415wallet-dapp-delivery-TREE.tar.gz` and
`dist/delivery-package-manifest.json`. Preserve the release owner's trusted
SHA-256 and tree separately. The outer verifier validates every archive header
before extracting anything: path traversal, links, devices, duplicate paths,
PAX/long-name overrides and overlarge payloads are refused. It checks exact
inventories, nested digests, UI identity, auth production dependencies, Git
source blobs/tree and bundled installer code against that source.

From the trusted checkout, with values obtained from the approved handoff:

```sh
node scripts/package/verify-delivery.mjs \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_SOURCE_TREE" --extract "$NEW_PRIVATE_KIT_DIRECTORY"
```

The extraction directory must not already exist. It contains the verified
outer files plus safely extracted `runtime/auth/`. The auth runtime is private
server material. Never set a web root to this kit, its exact-source archive,
`runtime/auth/`, a repository checkout or a complete release directory.
Only a static release's **`public/`** files may be served.

## Generate tenant configuration and review routes

Run the following tools from the verified checkout or extracted kit. The
configuration contains only the exact public release schema; unknown fields
are refused. It must never contain passwords, OTP seeds, keys, private bindings,
RPC secrets or bearer tokens. Output files are created exclusively, never
silently overwritten.

```sh
node deploy/dapp/install.mjs config \
  --tenant "$TENANT" --label "$PUBLIC_TENANT_LABEL" --profile v2 \
  --environment other --url "$EXISTING_FULL_ENTRY_URL" \
  --reserved-ports "$CONFIRMED_RESERVED_PORT_LIST_OR_none" \
  --output "$NEW_PUBLIC_CONFIG_FILE"

node deploy/dapp/install.mjs plan \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_SOURCE_TREE" --tenant "$TENANT" --profile v2 \
  --config "$NEW_PUBLIC_CONFIG_FILE" --target "$DEDICATED_UI_TARGET" \
  --output "$NEW_STATIC_NGINX_PLAN"
```

The optional `--reserved-ports` writes `deployment.reservedPorts`; provide the
confirmed comma-separated list, or `none` for an explicitly empty list. The
selected entry port must not be in that list. For CTYun the list includes 443;
other deployments use their own actual reservations. Omitting the option
retains the existing public schema without inventing a reservation.

Use `v3` explicitly for the V3 profile. `--environment local` accepts loopback
URLs only and is for synthetic local testing; nonlocal deployments require
HTTPS. The `xiongan` tenant is V2 only. The shipped unconfigured templates have
null URLs and cannot be installed until an endpoint is explicitly selected.

The plan changes no target, route or listener. It emits exact file locations
under the confirmed entry prefix, pointing only to `TARGET/current/public`.
It contains no general root, fallback rewrite, auth proxy, server or listen
block. An authorized deployment operator reviews it inside the existing exact
TLS vhost, preserves all unrelated routes, runs nginx's config check and
applies the static allowlist through the approved deployment process. During
upgrades, prepare/review new exact locations before switching UI code; retain
needed older exact routes during the transition. Unlisted files should remain
unserved. Never expose the private kit as a fallback root.

## Install or upgrade the static UI

The dedicated target's existing parent must be trusted. An existing unmanaged
nonempty target, symlinked path, unsafe permissions or an operation lock causes
refusal. The tool writes only inside that target.

```sh
node deploy/dapp/install.mjs install \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_SOURCE_TREE" --tenant "$TENANT" --profile v2 \
  --config "$NEW_PUBLIC_CONFIG_FILE" --target "$DEDICATED_UI_TARGET"
```

Record the returned `release`, `sourceTree` and `receiptSha256` in the trusted
deployment record for rollback. The target contains an immutable identity,
`releases/RELEASE/public/`, a hashed `INSTALL.json`, a static nginx plan, and an
atomically switched `current` symlink. Only public UI runtime assets are copied;
no server code, source export, docs, credentials or node_modules enter `public/`.
The selected public config is a declared local overlay with its own receipt
hash; it does not falsely retain the preconfigured UI's original file digest.

For a reviewed next kit, prepare its route plan, then repeat the command with
`upgrade` instead of `install` and that kit's trusted pins. Upgrade is explicit
and requires a managed current release. Tenant, profile, deployment environment,
origin and exact entry path must remain unchanged. A profile/URL migration is
a separately planned operation; do not bypass the refusal by deleting identity
files. Existing browser operation journals stay under their existing origin.
The tool does not clear browser storage or copy any credential store. Check the
actual entry and needed assets afterward. Users reload and authenticate afresh;
there is no promise that an already-open page hot-swaps all modules atomically.

## Verified static rollback

Use the saved receipt and tree for the particular older installed release:

```sh
node deploy/dapp/install.mjs rollback \
  --target "$DEDICATED_UI_TARGET" --tenant "$TENANT" --profile v2 \
  --release "$SAVED_RELEASE" --receipt-sha256 "$SAVED_RECEIPT_SHA256" \
  --tree "$SAVED_SOURCE_TREE"
```

Rollback verifies the external receipt hash, tree, exact file inventory, public
file hashes, config boundary and generated route plan before the atomic switch.
Retain/review the needed exact static routes for that version, then verify the
unchanged entry URL. It never rewinds a browser journal or auth state. A failed
verification leaves `current` unchanged. Interrupted staging or stale locks
require operator inspection; do not delete locks blindly or overwrite releases.
Only the installer owner can change these local paths. This is not protection
against an already-compromised host administrator.

## Same-origin auth component

Follow [AUTH-INSTALL.md](AUTH-INSTALL.md) using the already verified extracted
`runtime/auth/` directory as `PACKAGE_DIRECTORY`. Set the same tenant and the
exact UI origin. Its separate `prepare`, human credential activation,
`enable-proxy`, `upgrade`, `rollback-code` and proxy `rollback` operations retain
the existing TLS vhost and independently protected tenant auth paths. Only the
user handles real credentials in the prescribed trusted terminal. Auth restarts
revoke sessions. Never restore old encrypted credential state during a code
rollback: that could revive consumed authenticator/recovery values.

## Evidence boundary

Synthetic tests cover full-kit verification, bounded extraction, config
creation, static route planning, atomic release switching, rollback and
negative/tampered cases. Package verification establishes integrity and exact
source correspondence given trustworthy external pins. It establishes neither
production installation nor genuine-wallet, physical-CA, public-chain/W-20,
independent-security-audit or general-release acceptance.
