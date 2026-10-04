# 8415wallet static Beta deployment requirements

This is a manual operator handoff. Building or reviewing it performs no server
change, public-chain transaction or deployment. The artifacts are the versioned
V2/V3 **DApps**, separate from SDK tarballs. Use
[BETA-DAPP-DELIVERY.md](../BETA-DAPP-DELIVERY.md) for build and profile commands.

## 1. Select an immutable artifact

For each target, record the exact release profile, PRD scope, tenant (if any),
source commit/tree, archive SHA-256 and confirmed full deployment URL. Verify
CI for that exact source commit. Verify the archive checksum before extraction
and every entry in `SHA256SUMS` after extraction. Use the new artifact's measured
inventory; the older 62-file count is not a permanent requirement.

Deploy the archive into a new immutable release directory. Serve only its
static runtime and public configuration, never a source checkout, `.git`, test
fixture, raw evidence directory, SDK package or credential. Do not minify,
inject scripts, rewrite HTML/CSP or otherwise change shipped bytes during
installation. Build target-specific configuration through the documented
packaging path so its bytes and identity appear in the manifest.

## 2. Confirm the origin and port

The deployment URL includes HTTPS, hostname, the explicitly allocated web port
and `/web/index.html` (or an explicitly configured equivalent entry path).
Use the complete URL in every link and smoke test. Do not guess a replacement
port or substitute a bare hostname.

TCP 443 is reserved for SSH on CTYun and SIN. Do not bind HTTP/HTTPS, a reverse
proxy, TLS listener or bridge there; do not alter SSH to free it. If the approved
web allocation is missing, stop the server step and obtain that value. The
package remains a valid unconfigured Beta deliverable.

Scheme, host and port define the browser origin. A change strands browser
journals at the prior origin. Preserve an origin with unresolved operations;
never treat an empty journal at a new origin as evidence that nothing was sent.

## 3. Serve securely

Use the host's existing approved service allocation and a publicly trusted
certificate for the exact hostname. Keep its IPv4/IPv6 configuration consistent
with published DNS. Certificate warnings must not be bypassed.

Required content types:

| Extension | Type |
| --- | --- |
| `.mjs`, `.js` | `text/javascript` or `application/javascript` |
| `.css` | `text/css` |
| `.html` | `text/html; charset=utf-8` |
| public release configuration | `application/json` |

The public release configuration needed by the DApp must be explicitly allowed;
a blanket JSON refusal would break it. Deny source files, dotfiles, source maps,
private deployment input, release reports and other non-runtime files. Send
`Cache-Control: no-store` for public configuration and HTML during acceptance;
never mix modules from different release directories.

The page's CSP restricts runtime resources to its own origin. Preserve it.
Add at least these HTTP response headers to all runtime responses:

```text
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```

Evaluate HSTS under the established operations policy after HTTPS works. HSTS
changes neither the port reservation nor the requirement for complete URLs.
If an approved HTTP redirect exists, it must explicitly target the configured
HTTPS port. Preserve any existing authorized ACME challenge path. No new
firewall, DNS, SSH, certificate-account or persistent-access change is implied.

## 4. Configuration and custody

The product is 8415wallet; 8415wallet.com is the UI platform domain; Xiongan is a
V2 tenant. Keep platform/profile/tenant identity distinct. The DApp release
profile controls visible features; contract deployment pins select the exact
chain and runtime code to verify before use. Missing controller/payment
configuration must not disable independent standalone functionality.

A normal DApp control configuration accepts supported testnets only. The
external ETH/NFT companion also supports Ethereum/Base mainnet, and direct SDK
integrators must enforce their own network policy. Neither capability grants
permission for mainnet testing. Use only separately authorized testnet assets.

The server holds no key, seed, signer or custody component. There is no server
RPC proxy or transaction relay. Browser calls use the owner's injected wallet
provider. Do not add analytics, remote script/font hosts or a CSP workaround.

## 5. Hosting verification

Set `DAPP_URL` to the confirmed full entry URL and derive the same origin for
checks. Do not substitute a guessed port. Record raw response status/headers,
served file SHA-256 values, certificate subject/issuer/expiry, configuration,
source and profile. Verify:

1. The entry, modules and public release configuration load with correct MIME.
2. Runtime bytes match the approved artifact; no mixed or missing module exists.
3. `.git/config`, source, secrets and unrelated content are unavailable.
4. The page is a secure context and IndexedDB uses required durable storage.
5. The displayed product/profile/tenant matches the package manifest.
6. V2 standalone and V3 linked feature gates match their documented profiles.
7. No unauthorized external runtime request or console exception occurs.

Hosting checks are not genuine-wallet acceptance. A successful connection only
shows provider/account/chain discovery; it is not a signed or confirmed action.

## 6. Wallet and device test handoff

Use a desktop browser with a genuine injected wallet and a physical phone's
wallet in-app browser. A browser without an injected provider may render but
cannot connect; do not call that a provider integration pass. Node/DOM tests,
synthetic providers and emulated viewports stay separate evidence categories.

Follow the exact manual scenarios in the Beta handoff: three standalone
settlement operations and legacy clearing; all linked W-01–W-24 rows at their
specified level; funded/unfunded flows; cancellation, repeat-click, account/
network change and reload recovery. W-20 requires the actual deployed same-token
multi-wallet journey. Record testnet receipts and wallet confirmations only
when those actions are separately authorized and genuinely executed.

## 7. Rollback

Keep the prior immutable release and its exact public configuration. Before
switching, record the current artifact/configuration hashes and unresolved
journal compatibility. Roll back by restoring the prior approved static release
at the **same origin** under the existing service allocation. Verify its hashes,
module graph, headers and configuration again.

Do not clear IndexedDB, change host/scheme/port or downgrade an unresolved
journal to force rollback. If the previous version cannot understand an active
journal schema, preserve the current compatible recovery surface until those
operations are reconciled; a static rollback is not permission to discard
client-side state. Contract deployments and public-chain transactions are not
reversed by serving older HTML.
