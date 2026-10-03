# Xiongan Wallet — SIN static deployment requirements

Target host: Aliyun Singapore, `8.219.77.22` (public).
Operator: the SIN server owner. This document is the requirement set, not a
deployment that has happened.

Status of the thing being deployed: development candidate. It has local and
synthetic-browser evidence only. It has **not** had an independent security
review, and it has never executed a transaction from a genuine wallet. Nothing
below changes that, and a successful deployment must not be reported as
acceptance.

---

## 1. Artifact

The deployable site is published on the branch `deploy/xiongan-sin` of
`GiraffeTechnology/8415Wallet`. That branch carries only the served tree, so a
shallow clone of it **is** the document root:

```
git clone --depth 1 --branch deploy/xiongan-sin \
    https://github.com/GiraffeTechnology/8415Wallet.git /srv/xiongan
```

| | |
|---|---|
| Branch | `deploy/xiongan-sin` |
| Commit | see the branch head; rebuilt whenever `main` changes the browser bundle |
| Served files | 62 (1 html, 1 css, 5 mjs, 55 js), plus `SHA256SUMS`, `DEPLOY.md` and `DOMAIN.md` |
| Unpacked size | 532 KB |
| Built from | `18499967348a` (tree `ea180768fa69dfefdc36c22cf53ef2fa1e97e00b`) |
| Build command | `npm run wallet:browser:build` on Node 22 |

This branch tracks `main`. When `main` changes anything that compiles into
the browser bundle, the branch is rebuilt and the deployed tree must be
refreshed with it; a `git pull` in the document root is the whole update.

The repository is private, so the clone needs a credential with read access to
it. Do not make the repository public to simplify this.

Layout, which must be preserved exactly:

```
<docroot>/
  web/index.html          <- the page
  web/*.mjs  web/wallet.css
  dist/browser/**/*.js    <- 55 compiled modules
  SHA256SUMS
  DEPLOY.md               <- this document; serve it or delete it, either is fine
```

`web/app.mjs` imports `../dist/browser/browser.js` by relative path. The
`web/` and `dist/` directories must stay siblings. Do not flatten, rename or
rewrite any path.

`.git/` must not be served. The nginx dotfile rule in section 3.3 covers this,
but confirm it: an exposed `.git` directory on a public host leaks the whole
branch history.

Verify after unpacking, from the document root:

```
sha256sum -c SHA256SUMS
```

All 62 lines must report `OK`. Do not deploy a tree that does not.

---

## 2. HTTPS is a hard functional requirement, not a hardening step

`web/external-store.mjs` and `web/public-store.mjs` both open with:

```js
if (!globalThis.indexedDB || !globalThis.isSecureContext) throw new Error('CONTROL_BROWSER_DURABILITY_REQUIRED');
```

A public IP served over plain HTTP is **not** a secure context, so
`isSecureContext` is `false` and the wallet refuses to start its operation
journal. The application is designed to fail closed here rather than downgrade
to `localStorage` or an in-memory journal, so there is no fallback to enable.

Consequence: **`http://8.219.77.22/` cannot work.** This is not a browser
warning to click through; it is an application-level refusal.

### 2.1 A DNS name is required

Standard ACME issuance (Let's Encrypt and the common alternatives) validates a
domain, not a bare IP. IP-address certificates exist only under limited,
short-lived profiles with uneven client support, and mobile wallet in-app
browsers are the least predictable clients there.

`8415wallet.com` is the platform domain, registered at Xinnet, and each tenant
receives one subdomain that is that tenant's wallet origin. The tenant to
deploy now is **`xiongan.8415wallet.com`**. The apex serves no wallet.

Where this document writes `<host>`, read `xiongan.8415wallet.com`.

Deploy at that hostname from the start. The operation journal lives in
IndexedDB under the serving origin, so standing the wallet up on the apex or a
temporary name and moving it later strands every journal written in the
meantime, including any operation left in `outcome-unknown`. See
`SIN-DOMAIN-REQUIREMENTS.md` section 3.

How that hostname is chosen, delegated, hardened and renewed is specified in
`SIN-DOMAIN-REQUIREMENTS.md`, which is a blocking prerequisite for everything
below.

A self-signed certificate is not acceptable. Mobile wallet in-app browsers
generally offer no trust-override UI, and training an operator to accept
certificate warnings on a wallet origin is the exact habit that makes phishing
work.

---

## 3. Serving rules

### 3.1 MIME types

`.mjs` is **not** present in the default nginx `mime.types` on most builds. If
it is served as `application/octet-stream`, the browser refuses the module and
the page loads to a blank shell. This is the most likely single cause of a
failed first deployment.

Required:

| Extension | Content-Type |
|---|---|
| `.mjs` | `text/javascript` (must be added; see 3.3) |
| `.js` | `text/javascript` or `application/javascript` (already in `mime.types`; do not redefine) |
| `.css` | `text/css` |
| `.html` | `text/html; charset=utf-8` |

### 3.2 Response headers

The page already ships a strict CSP in a `<meta>` tag:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none';
form-action 'none'
```

A `<meta>` CSP **cannot** carry `frame-ancestors`. The server must supply it as
a real header, otherwise the wallet UI can be framed by a third-party page.
Required response headers on every response:

```
Content-Security-Policy: frame-ancestors 'none'
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=()
```

Add `Strict-Transport-Security` only once HTTPS is confirmed working; it is
hard to walk back.

Do not add a second full `Content-Security-Policy` header. Two CSPs are
intersected, and a server policy written without knowledge of the page's own
will silently break module loading. Send only `frame-ancestors` from the
server and leave the rest to the page.

### 3.3 Reference nginx server block

```nginx
# In http{}, AFTER `include mime.types;`. Add mjs only --- redefining an
# extension that mime.types already carries (such as js) makes nginx fail to
# start with `duplicate extension`.
types { text/javascript mjs; }

# The Xiongan tenant origin. Serves the application and nothing else.
server {
    listen 443 ssl;
    listen [::]:443 ssl;   # omit only if no AAAA record is published; see the
                           # domain requirements document
    http2 on;
    server_name xiongan.8415wallet.com;

    ssl_certificate     /etc/letsencrypt/live/xiongan.8415wallet.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xiongan.8415wallet.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /srv/xiongan;
    index web/index.html;
    autoindex off;

    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Cross-Origin-Opener-Policy same-origin always;
    add_header Permissions-Policy "geolocation=(), camera=(), microphone=(), payment=()" always;

    location = / { return 302 /web/index.html; }

    location ~* /\.    { return 404; }        # no dotfiles, including .git
    # Blocks source and metadata. Note for later: when the per-tenant
    # deployment configuration ships (domain document, section 8) its exact
    # path needs an explicit allow ABOVE this rule, or this would 404 it.
    location ~* \.(ts|json|map|md)$ { return 404; }

    gzip on;
    gzip_types text/javascript text/css text/html;
}

server {
    listen 80;
    listen [::]:80;
    server_name xiongan.8415wallet.com;

    # The ACME challenge must be reachable on port 80, ahead of the redirect.
    # A bare `return 301` here passes the first issuance (certbot opens its own
    # listener) and then fails every unattended renewal about 90 days later.
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }

    location / { return 301 https://xiongan.8415wallet.com$request_uri; }
}

# Refuse any name that is not an approved tenant, so an unconfigured or
# attacker-chosen hostname pointed at this address gets nothing rather than a
# copy of the wallet under a name nobody approved.
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    ssl_certificate     /etc/letsencrypt/live/xiongan.8415wallet.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xiongan.8415wallet.com/privkey.pem;

    return 444;
}
```

`add_header` does not inherit into a `location` block that declares its own.
If any `location` gains an `add_header`, the security headers above must be
repeated inside it.

---

## 4. What the server must not do

- **No RPC proxy, and no server-side chain access.** The bundle issues zero
  outbound requests of its own (verified: the synthetic browser run recorded
  `externalRequests: []` at both viewports). All chain traffic goes through the
  provider injected by the user's wallet application. Introducing a server-side
  RPC endpoint would insert a party able to observe and rewrite transaction
  parameters, and would break the `connect-src 'self'` policy.
- **No key material, signer, or custody component on the host.** The server is
  a dumb static file host. It never holds a private key, a mnemonic or a
  session token.
- **No analytics, tag manager, CDN rewrite, font host or injected script.** The
  CSP forbids them and they must not be worked around.
- **No modification of any shipped file**, including "harmless" minification,
  HTML rewriting or CSP relaxation. Any change invalidates `SHA256SUMS` and the
  build's correspondence to the reviewed commit.
- **No directory listing and no exposure of anything outside the document
  root.** The source repository is private; only the 61 files above are to be
  served.

---

## 5. Risk disclosure for whoever operates this host

The deployed page contains a live transaction path:
`ExternalAssetSession.submit()` calls `eth_sendTransaction` through the user's
wallet.

- Its chain table `ASSET_CHAINS` includes Ethereum mainnet (`1`) and Base
  (`8453`) alongside the testnets.
- There is **no amount ceiling and no test-only sentinel** in this path.
- The operative restriction is whichever chain the user's wallet is connected
  to at the time.

For first real-device use, set the wallet to Sepolia (`11155111`) before
opening the page.

The page's own banner states that it is an unaudited testnet development
candidate. That banner must not be removed or edited during deployment.

---

## 6. Access pattern — this is not a Safari page

Both entry points obtain their provider the same way:

```js
provider = globalThis.ethereum;
```

Injected providers only. There is no WalletConnect, no QR pairing and no deep
link in this build.

- **iOS Safari:** `window.ethereum` is undefined. The page renders, and the
  connect action fails with `ASSET_WALLET_PROVIDER_REQUIRED` (asset panel) or
  `CONTROL_GENUINE_WALLET_PROVIDER_REQUIRED` (control panel). This is correct
  behaviour, not a deployment fault.
- **Supported:** the in-app browser of a wallet application (MetaMask, Rainbow,
  Trust, imToken, OKX and similar), which injects a provider into the top-level
  page.

Acceptance must therefore be performed from a wallet application's in-app
browser, not from Safari.

---

## 7. Acceptance evidence to report back

Report each item with its raw output. Do not summarise a check as passed
without the output that shows it.

**Integrity**

1. `git -C /srv/xiongan rev-parse HEAD` equals the commit in section 1.
2. `sha256sum -c SHA256SUMS` from the document root: 62 x `OK`, 0 failures.
2a. `curl -sSI https://xiongan.8415wallet.com/.git/config` returns 404.

**Transport**

3. `curl -sSI https://xiongan.8415wallet.com/web/index.html` — status, and the full header
   block showing every header in section 3.2.
4. `curl -sSI https://xiongan.8415wallet.com/web/app.mjs | grep -i content-type` — must be
   `text/javascript`.
5. `curl -sSI https://xiongan.8415wallet.com/dist/browser/browser.js | grep -i content-type` —
   must be `text/javascript`.
6. `curl -sSI http://xiongan.8415wallet.com/` — must be a 301 to `https://`.
7. Certificate chain: issuer, subject, and notAfter.

**Application, from a desktop browser first**

8. Load `https://xiongan.8415wallet.com/web/index.html`. Report the browser console contents.
   A clean load has no errors. A `CONTROL_BROWSER_DURABILITY_REQUIRED` here
   means the secure-context requirement in section 2 is not satisfied.
9. Confirm the page makes no request to any origin other than `xiongan.8415wallet.com`
   (DevTools network tab, or equivalent).

**Application, from the iPhone — this is the part that matters**

10. Open `https://xiongan.8415wallet.com/web/index.html` in a wallet application's in-app
    browser, with the wallet set to Sepolia.
11. Screenshot the loaded page at device width.
12. Press "Connect by external wallet" and report the result. On success the
    identity line reads `Sepolia · EOA 0x...`. On failure report the exact error
    string.
13. Report whether `CONTROL_BROWSER_DURABILITY_REQUIRED` appears at any point.
    Some in-app browsers restrict IndexedDB; the application refuses rather
    than downgrading, so this is a real compatibility outcome and needs to be
    recorded per wallet application tested.
14. Name the wallet application and version used.

**Not to be claimed**

A completed deployment is a hosting result. It is not an independent security
review, and it is not acceptance of the transaction path. Item 12 succeeding
means a provider connected and a balance was read; it does not mean a
transaction was signed, sent or confirmed. Report any signed transaction
separately, with its chain id, hash and the wallet that produced it.

---

## 8. Rollback

Keep the previous document root. Rollback is replacing the directory and
reloading nginx; there is no database, no migration and no server-side state
to unwind. Client-side state lives in the user's own browser under the
IndexedDB names `xiongan-public-assets-v1` and `8415-public-operation-v2`, and
is not affected by a server rollback.
