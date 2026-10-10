# 8415wallet public product kit: verify, install and rebuild

This is curated, rebuildable product source for the V2/V3 DApps, dependency-complete
auth runtime, installers and independent SDK packages. It is not the full developer
repository: repository tests, EVM fixtures, development preview/control journeys,
private operations and historical release archives are intentionally absent.
`npm test`, `npm run verify`, `npm run test:evm` and development-preview commands are
not supported by this curated source. The root package scripts retain
their full-repository definitions (including the export-tooling regression test); their presence is not a completeness
claim. In particular, the build section in `docs/DAPP-INSTALL.md` and the full-matrix
section in `docs/AUTH-INSTALL.md` describe full-repository validation. Use the curated
rebuild commands below instead; do not restore private or historical inputs to run
those repository-only commands.

The exact 263-path input boundary has been approved for a local product build.
The version-2 policy records only reviewed product paths, modes, blob identities,
byte SHA-256 values and mandatory categories. Full-repository commit/tree pins are
provided externally at invocation time. Embedding the final full-repository tree
inside its own versioned policy would be self-referential and is not permitted.
The third-party notice makes distribution-specific component inclusion explicit:
any included separately licensed material retains its applicable notices and terms.
No source-availability promise is made for components absent from this curated kit.
This guide is a separate companion to the kit, with its digest in the build report.
It is not an added outer-archive member. Local approval is not publication or
deployment approval. Verification status and final artifact pins belong in the
corresponding build report, never inferred from this guide.

## Start here: verify and extract

Use Node >=22.18, an independently trusted source checkout containing the existing
strict verifier, and the release owner's independently conveyed final archive
SHA-256 and product Git tree. First run the origin verifier described below against
the same artifact to bind the reviewed upstream and policy. Then use the unchanged
strict delivery verifier for safe extraction into a nonexistent private directory:

```sh
node "$TRUSTED_CHECKOUT/scripts/package/verify-delivery.mjs" \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_PRODUCT_TREE" --extract "$NEW_PRIVATE_KIT_DIRECTORY"
```

Keep the extracted kit and `runtime/auth/` private. Never serve the kit, source,
repository or auth runtime as a web root. Only installer-produced `public/` files
may be served. The installed auth runtime already includes pinned production
dependencies; deployment needs no npm registry access.

## Configure, plan and install (authorized deployment operator only)

Set each placeholder from independently approved deployment configuration. Confirm
the tenant, V2 or V3 profile, exact existing HTTPS entry URL including port and
`/web/index.html`, reserved ports and dedicated target before any installation.
From the verified extracted kit:

```sh
node deploy/dapp/install.mjs config \
  --tenant "$TENANT" --label "$PUBLIC_TENANT_LABEL" --profile v2 \
  --environment other --url "$EXISTING_FULL_ENTRY_URL" \
  --reserved-ports "$CONFIRMED_RESERVED_PORT_LIST_OR_none" \
  --output "$NEW_PUBLIC_CONFIG_FILE"

node deploy/dapp/install.mjs plan \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_PRODUCT_TREE" --tenant "$TENANT" --profile v2 \
  --config "$NEW_PUBLIC_CONFIG_FILE" --target "$DEDICATED_UI_TARGET" \
  --output "$NEW_STATIC_NGINX_PLAN"

node deploy/dapp/install.mjs install \
  --archive "$KIT_ARCHIVE" --sha256 "$TRUSTED_KIT_SHA256" \
  --tree "$TRUSTED_PRODUCT_TREE" --tenant "$TENANT" --profile v2 \
  --config "$NEW_PUBLIC_CONFIG_FILE" --target "$DEDICATED_UI_TARGET"
```

Use `v3` explicitly for V3. Unconfigured/null-URL templates cannot be installed.
Review the generated exact static routes in the existing approved TLS vhost; the
installer does not configure TLS, firewall, SSH or unrelated listeners. Save the
returned release, source tree and receipt SHA-256 for rollback. See the included
`docs/DAPP-INSTALL.md` for `upgrade` and receipt-pinned `rollback`. Preserve the exact
origin, tenant and entry path so browser operation journals remain accessible.
Never delete identity/state/lock files to bypass an installer refusal.

For same-origin auth, read `docs/AUTH-INSTALL.md`, independently verify account
bindings, the root-owned Node binary and existing TLS site, and use the verified
private `runtime/auth/` as `PACKAGE_DIRECTORY`. Set `PACKAGE_DIRECTORY` to the
absolute path of that verified extracted auth runtime, not the outer kit directory.
These operator commands are shown
for separately authorized execution, not run by product packaging:

```sh
PACKAGE_DIRECTORY="$(cd "$NEW_PRIVATE_KIT_DIRECTORY/runtime/auth" && pwd -P)"

node "$PACKAGE_DIRECTORY/deploy/auth-xiongan/install.mjs" prepare \
  --package "$PACKAGE_DIRECTORY" --node "$ABSOLUTE_NODE_EXECUTABLE" \
  --origin "$EXISTING_HTTPS_ORIGIN" --tenant "$TENANT" \
  --bindings "$PRIVATE_BINDINGS_JSON" --reserved-ports "$HOST_RESERVED_PORT_LIST_OR_none"

node "$PACKAGE_DIRECTORY/deploy/auth-xiongan/install.mjs" check --tenant "$TENANT"

node "$PACKAGE_DIRECTORY/deploy/auth-xiongan/install.mjs" enable-proxy --tenant "$TENANT" \
  --nginx-site "$EXACT_EXISTING_TLS_SITE_FILE"
```

Between `prepare` and `enable-proxy`, the user personally performs credential
activation in the prescribed trusted terminal using `server/operator-activate.mjs
--activate --tenant TENANT` from the installed runtime. No real credentials belong
in arguments, chat, source, archives or this guide. `prepare` alone does not start
a service. `enable-proxy` starts the tenant unit and changes the existing auth
route, so it requires separate deployment authorization. SMTP network/credential
permissions are a separate review. Auth upgrades/rollback preserve encrypted state;
never restore old state or consumed recovery/TOTP values. UI rollback is independent
of auth-code rollback. Read the supplied auth guide for all activation, state-format
and mail requirements.

## Review and authority gates

1. Review every path and hash in `config/product-source-allowlist.json`, its
   mandatory categories, the candidate source identity and all five tooling files.
   No wildcard grants export membership. Families are completeness checks only.
2. Resolve every review hold. Only a deliberately reviewed policy may change its
   status to `approved-for-local-build` with empty `holds` and `blockers`. That edit
   changes the policy digest and predicted product identity; recalculate and review
   them. The checked-in policy records local input-boundary approval. Tooling review and an explicit build invocation remain separate gates.
3. Pin the exact allowlist SHA-256, tooling SHA-256, upstream commit, upstream snapshot tree and
   predicted product tree through a separately trusted review channel. Never use
   values merely asserted by an archive as external trust anchors.
4. After tooling review and explicit build approval, use `--mode build` and a nonexistent output
   root with an existing parent. An existing directory, even empty, is refused.
   A failed run is preserved for diagnosis and never silently reused or deleted.
5. Publication, upload, remote Git changes, deployment and production acceptance
   are separate decisions. The export/build/verification commands do not publish
   or install services; the separately authorized installation commands above do
   change their dedicated targets.

A policy digest is the SHA-256 of the exact JSON file bytes. The tooling digest is
SHA-256 of pretty-printed JSON plus newline containing the ordered `{path, sha256}`
records for the two scripts, synthetic test file and this guide, in `TOOLING_FILES`
order. The policy is pinned separately, so neither digest is self-referential.
Obtain these values using a reviewed local hash command or the exported
`computeToolingPin()` helper. Recomputing a digest is not approval.

## Read-only inspection (default)

Run from the reviewed repository checkout containing the export tooling, supplying
trusted pins. A separately pinned export-tooling workspace remains supported:

```sh
node scripts/package/build-public-product.mjs \
  --source /absolute/path/to/reviewed-upstream-checkout \
  --allowlist config/product-source-allowlist.json \
  --allowlist-sha256 REVIEWED_POLICY_SHA256 \
  --tooling-sha256 REVIEWED_TOOLING_SHA256 \
  --upstream-commit REVIEWED_UPSTREAM_COMMIT \
  --upstream-tree REVIEWED_UPSTREAM_SNAPSHOT_TREE \
  --require-clean true
```

`--mode inspect` and `--mode plan` are equivalent. Neither creates files, stages
source, writes Git objects or starts packers. They verify actual HEAD against the
external upstream commit, hash its genuine commit object, derive and verify its
commit tree, verify the complete staged index against the external snapshot tree,
and check each selected working-tree file
and object, mode, SHA-1/SHA-256, exact public-family inventory and mandatory
package/compiler/runtime/installer/legal/document/import/asset closure. Excluded
tracked history/operations stay outside the selection. Untracked extra files in
source families, symlinks, links/special files, unknown additions and altered bytes
or executable bits fail closed. Source object access alone does not certify that a
reviewed document contains no private material; human boundary review is required.

Clean source is required by default. `--require-clean true` requires HEAD's tree,
the staged snapshot, every tracked working-tree file's bytes/mode and all
nonignored untracked-file state to be clean. The tracked-file check includes hidden
CI files and does not trust Git's assume-unchanged or skip-worktree flags.
For an explicitly reviewed local staged candidate, pass `--require-clean false`;
this still verifies the genuine HEAD/commit tree, exact staged snapshot and every
selected product byte. The origin records the staged relation, tracked-worktree
match, untracked-file presence and actual upstream dirty state without private
path names. A clean generated product commit never erases upstream dirtiness.

The two export-tool modules and the two exact reviewed generated Python caches
are excluded from product-family completeness checks and cannot be product inputs.
Other unknown source-family members remain failures. Policy, tests, guide and CI
are not copied into the curated source. The separately delivered guide is hash-bound
through the tooling identity.

Inspection prints a predicted local product commit and tree, review status and
input identities. It does not materialize the product. Paths are not permission
to open every document link: historical, operations and private/QA links are not
automatically followed or copied into the product.

## Explicit build after approval

```sh
node scripts/package/build-public-product.mjs --mode build \
  --source /absolute/path/to/reviewed-upstream-checkout \
  --allowlist config/product-source-allowlist.json \
  --allowlist-sha256 REVIEWED_APPROVED_POLICY_SHA256 \
  --tooling-sha256 REVIEWED_TOOLING_SHA256 \
  --upstream-commit REVIEWED_UPSTREAM_COMMIT \
  --upstream-tree REVIEWED_UPSTREAM_SNAPSHOT_TREE \
  --require-clean true \
  --product-tree REVIEWED_PREDICTED_PRODUCT_TREE \
  --output /absolute/path/to/new-output-root --offline true
```

Offline mode requires an already populated npm cache. Omit it or set it to false
only when fetching the lockfile-pinned npm dependencies is authorized. The builder
runs `npm ci --ignore-scripts --no-audit --no-fund` inside the fresh product checkout,
then the unchanged `scripts/package/build-delivery.mjs`. That existing builder runs
the V2 and V3 DApp packers, dependency-complete auth packer, and their strict
verifiers before assembling and verifying the delivery kit. The wrapper adds
exact upstream-origin and nested source/UI boundary checks. The independent SDK
build inputs remain available, but the wrapper does not produce SDK tarballs or
mislabel them as the full DApp delivery kit.

The output root contains:

- `product/`: 263 reviewed source files plus `PRODUCT-ORIGIN.json`, then ordinary
  isolated dependency/build directories when packers run
- `PRODUCT-BUILD-REPORT.json`: the truthful local product commit/tree, source and
  tooling pins, verification status, and final outer archive SHA-256
- `PUBLIC-PRODUCT-KIT.md`: this companion guide, separately hashed in the report
- `publication/`, created only after strict build verification, with exactly:
  - `8415wallet-dapp-delivery-PRODUCT_TREE.tar.gz`, keeping the validated archive name
  - `PUBLIC-PRODUCT-KIT.md`
  - `PRODUCT-BUILD-REPORT.json`, a fixed-shape sanitized public report
  - `SHA256SUMS`, covering the archive, guide and public report (not itself)
- Failure records only if a run fails; partial output is never called verified

The public report includes genuine upstream commit/commit-tree/snapshot identity,
accurate dirty state, independent policy/tooling hashes, local product identity,
and archive/guide hashes. It contains no local paths, private configuration,
full-repository manifests, command logs, environment values or failure records.
The checksum file binds the public report as well; the report has no self hash.

For an authorized CI publication step, append `--github-output "$GITHUB_OUTPUT"`
to the explicit build command. The argument must identify the existing regular
file supplied by the `GITHUB_OUTPUT` environment variable, outside the source and
output roots. The wrapper never creates or guesses that file. It appends outputs
only after successful strict archive verification and exact four-file revalidation:
`archive_path`, `guide_path`, `checksums_path`, `report_path`, plus upstream/product
identity and SHA-256 pins. Inspection and failed builds emit none. The upload step
must list only those four outputs and be success-gated. Never upload a `dist/*`
glob, an old full-repository delivery archive, the build output root or a diagnostic
report. The wrapper itself does not upload anything.

The unchanged delivery inventory carries the generated origin only within the
nested source archive. No extra origin/report/guide files are inserted in the
outer delivery archive, and `DELIVERY_FILES` is not weakened.

## Origins and trust

`PRODUCT-ORIGIN.json` is the sole generated source file. It lists every selected
upstream path, Git mode, Git blob SHA-1 and byte SHA-256, the genuine upstream commit/commit tree and
externally pinned staged snapshot with its relation and actual dirty state, and separately records the generator's tooling identity.
It never claims that generated provenance was an upstream blob. It contains no
self hash, product tree, eventual product commit, clock-dependent value or private
workspace path. Its bytes are bound by the new product Git tree instead.

The fresh repository has exactly one deterministic local root commit, fixed export
identity and epoch timestamp, no parent, no copied Git directory, no upstream
history, no remotes and no signatures. Its clean source state is truthful even
when the upstream candidate is staged content rather than a new upstream commit.
This local commit is never described as an upstream author's commit or GitHub CI.

These distinct identities preserve the existing auth, DApp and delivery schemas.
All source inventory entries refer to the complete new product tree. Existing
strict validators remain authoritative; the origin verifier adds restrictions and
never bypasses them. Consumers need independent final product-tree and archive
pins from a trusted release source. Self-consistent checksums, even recomputed
through every nested manifest, do not authenticate a publisher or prove authorship.

## Verify a completed kit

```sh
node scripts/package/verify-product-origin.mjs \
  --source /absolute/path/to/trusted-upstream-checkout \
  --allowlist config/product-source-allowlist.json \
  --allowlist-sha256 REVIEWED_POLICY_SHA256 \
  --tooling-sha256 REVIEWED_TOOLING_SHA256 \
  --upstream-commit REVIEWED_UPSTREAM_COMMIT \
  --upstream-tree REVIEWED_UPSTREAM_SNAPSHOT_TREE \
  --require-clean true \
  --product-tree TRUSTED_PRODUCT_TREE \
  --archive /absolute/path/to/delivery.tar.gz \
  --archive-sha256 TRUSTED_FINAL_ARCHIVE_SHA256
```

Verification executes the unchanged strict verifier from the trusted, pinned
upstream checkout, never code imported from an untrusted archive. It verifies the
outer and nested archives, exact source inventory/bytes/modes, exact origin bytes,
local commit object, copied documents/legal/installer files, DApp public inventory
and profile configuration. Archive/source-tree substitutions and recomputed
internal checksums cannot replace independent pins. Browser output inventory is
source-graph derived; compiler output byte reproducibility is not established by
that inventory check. The final artifact digest still binds compiled output bytes.

## Product commands and installation boundary

The curated source supports the unchanged DApp/auth/delivery build/verify commands,
plus `pack:v2`, `pack:v3`, `pack:v2:verify`, and `pack:v3:verify` for independent SDK
artifacts. Use `docs/DAPP-INSTALL.md`, `docs/AUTH-INSTALL.md` and the unchanged
`deploy/dapp/install.mjs` / `deploy/auth-xiongan/install.mjs` after separately
approved deployment configuration. Upgrade/rollback and origin/account-state
semantics are unchanged. Do not infer service-installation authority from a build.

The root `package.json` is byte-exact to its reviewed policy entry, so it still mentions repository-only
commands whose test/dev files are intentionally absent. The product does not
claim that `npm test`, `npm run verify`, EVM/repository QA, dev-preview commands,
control journeys or historical regression fixtures run in this curated checkout.
Those remain in the original repository. Do not add private configuration or old
archives to satisfy them. Any expanded QA-source distribution needs its own
explicit input review. The existing public component release is not this proposed
source-backed complete product kit.

## Rebuild from the verified product checkout or source archive

The supported rebuild commands must run in the exact verified product Git checkout
whose HEAD/tree match `PRODUCT-BUILD-REPORT.json`. Do not run packers directly in a
bare unpacked source directory: the unchanged `captureSource` functions require a
real Git root and commit object. From the generated `product/` checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/package/build-delivery.mjs
npm run pack:delivery:verify

# Optional, separately identified SDK artifacts:
npm run pack:v2
npm run pack:v2:verify
npm run pack:v3
npm run pack:v3:verify
```

For offline rebuilds, use an operator-approved populated npm cache and add
`--offline` to `npm ci` and `build-delivery.mjs`. The complete source is preserved,
including `PRODUCT-ORIGIN.json`; do not edit it, stage additional files or re-label
old archive pins after rebuilding. Compare the actual rebuilt artifact digest with
the intended trusted release digest; toolchain variations may change compiled or
compressed output bytes even when the source tree is identical.

When starting from a delivery kit rather than the product checkout:

1. Verify the complete kit and origin mapping first. Use the trusted strict
   `readDeliveryArchive` parser to extract the exact nested source archive into a
   new directory, writing only its verified regular-file entries with their recorded
   `0644`/`0755` modes. Do not use an unvalidated archive extraction command.
2. Obtain the authenticated `auth.source.commitObject` Base64 value from the nested
   `artifacts/auth-package-manifest.json` in that verified kit. Decode it to an
   external temporary file, outside the new source directory. Its Git object hash
   must equal the independently trusted local product commit in the build report.
   Confirm that it contains exactly the trusted product tree and has no parents.
3. In the new source directory, with Git hooks/global configuration disabled,
   initialize an empty SHA-1 repository (`git init --object-format=sha1
   --initial-branch=product-export --template=`). Add only the verified source files,
   then compare `git write-tree` to the trusted product tree. It must match exactly;
   never normalize or edit files to force a match.
4. Restore the actual authenticated commit object using `git hash-object -t commit
   -w --stdin < VERIFIED_COMMIT_FILE`. Check the returned object ID equals the trusted
   commit, then set `git update-ref refs/heads/product-export TRUSTED_PRODUCT_COMMIT`.
   Verify `HEAD`, `HEAD^{tree}`, clean tracked bytes and `git rev-list --count HEAD`
   (exactly one). No clone or upstream history is needed or permitted.
5. Run the supported commands above. Keep independently trusted identity pins
   separate from the archive/manifests. A manually invented commit with the same
   source tree is not the authenticated product commit and must not be substituted.

## Synthetic-only verification and limits

Run this command only from the reviewed full repository. These synthetic
tests are not included in the curated product source or extracted installation kit.

```sh
node --test tests/product-source.test.mjs
```

Tests create disposable synthetic Git repositories outside the source checkout;
no real Wallet source is exported, compiled or archived. Cases cover deterministic
selection, exact origins, review/pin gating, missing mandatory inputs, changed
modes/blobs, symlinks, private/historical exclusions, stale output, extra generated
files, origin substitution, nested inventory and checksum-reforgery attempts.
They also cover committed in-repository tooling without self-reference, clean-CI
versus explicit staged-local identity, hidden tracked-file changes, sanitized
publication, exact four-file checksums, GITHUB_OUTPUT refusal paths and the CI
upload contract. Optional strict-validator smoke is enabled with
`PRODUCT_STRICT_SMOKE_SOURCE` pointing at the reviewed source checkout.
Optional strict-validator smoke reads only the existing trusted validator modules
and uses generated harmless tar fixtures; it never runs the real packers.

A synthetic pass is not a real Wallet packaging result, repository regression run,
public CI result, deployment, genuine-wallet/device/public-chain acceptance or
independent security audit. Only a completed build report and separately trusted final pins establish that a
particular real product kit passed the local packaging checks.
