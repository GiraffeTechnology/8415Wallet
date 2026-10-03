# 8415wallet.com — domain and TLS requirements for the SIN host

Companion to `SIN-STATIC-DEPLOYMENT-REQUIREMENTS.md`.

| | |
|---|---|
| Domain | `8415wallet.com` |
| Registrar | Xinnet (xinnet.com) |
| Server | Aliyun Singapore, `8.219.77.22` |
| Model | one subdomain per tenant, granted by approval |
| First tenant | `xiongan.8415wallet.com` |

**This is a blocking prerequisite.** Deployment cannot begin, and cannot be
smoke-tested from a phone, until the name resolves and carries a publicly
trusted certificate.

## Observed state

Delegation and the tenant are live. Measured 2026-10-03 over DNS-over-HTTPS and
HTTPS from outside the host:

```
8415wallet.com          NS  ns11.xincache.com, ns12.xincache.com
8415wallet.com          A   8.219.77.22
xiongan.8415wallet.com  A   8.219.77.22
www.8415wallet.com          NXDOMAIN

https://xiongan.8415wallet.com/web/index.html   200
http://xiongan.8415wallet.com/web/index.html    308 -> https
```

The served tree was compared file by file against a local build of `main` at
`18499967348a`: **62 of 62 files byte-identical, 0 differing, 0 missing.**

A port policy change lands on top of this: **TCP 443 is reserved for SSH on
every server**, by owner instruction of 2026-10-03, which supersedes the
CTYun-only scoping in `AGENTS.md`. The live listener above is therefore on a
port it may no longer use, and both it and the port-80 redirect have to move to
an allocated web port. The deployment document's section 2.2 carries the
requirement and the consequences; the one that matters most here is that the
move **changes the web origin**, since an origin is scheme, host and port. Do
it before the site carries any genuine wallet use, not after.

Three items remain open; all are in section 11.

- `Strict-Transport-Security` is absent. Section 6 defers it until HTTPS works,
  and HTTPS now works, so it is due.
- The apex has an `A` record but presents a certificate that does not cover
  `8415wallet.com`, so `https://8415wallet.com/` fails to validate. See 2.1:
  either give the apex its own certificate and a plain page, or withdraw its
  `A` record. A certificate warning on the brand domain is worse than a name
  that does not resolve, because it teaches the one habit section 1 exists to
  prevent.

---

## 1. Why a hostname is required rather than preferred

Two independent reasons, either alone decisive.

**The application refuses to start without a secure context.** Both browser
stores open with:

```js
if (!globalThis.indexedDB || !globalThis.isSecureContext) throw new Error('CONTROL_BROWSER_DURABILITY_REQUIRED');
```

A public IP over plain HTTP is not a secure context. The application fails
closed rather than falling back to `localStorage` or an in-memory journal, so
no configuration flag relaxes it. `http://8.219.77.22/` cannot work, and this
is not a warning a user can click past.

**Standard certificate issuance validates a domain.** ACME issuance is
domain-validated; do not attempt a certificate for the bare IP. A self-signed
or privately-rooted certificate is also unacceptable: wallet in-app browsers
usually offer no trust-override interface, and conditioning anyone to accept
certificate warnings on a wallet origin is the habit that makes wallet
phishing work.

---

## 2. The tenant origin model

`8415wallet.com` is the platform domain. **Each tenant receives one subdomain,
which is that tenant's wallet origin.** The first and currently only tenant is
Xiongan:

```
xiongan.8415wallet.com   ->  the Xiongan Wallet (deploy this)
```

Subdomains are granted by approval, not self-service. Nothing in this
deployment registers subdomains automatically, and no user account system,
database or provisioning backend exists or is to be created for it.

### 2.1 The apex does not serve a wallet

`8415wallet.com` itself must not serve a wallet application. It may serve
nothing, or a small static page describing the project. If it serves a page:

- that page must not collect input, hold a wallet connection, or link to a
  tenant in a way that trains users to reach their wallet by clicking rather
  than by typing or using a bookmark;
- it is a separate origin from every tenant, which is why it is permitted at
  all.

Letting the apex resolve to a plain page is preferred over leaving it
unresolvable, so that the brand name does not produce a DNS error.

### 2.2 One tenant, one origin, nothing shared

Each tenant subdomain serves this application and nothing else. Wallet
applications grant account access per origin, and IndexedDB is scoped per
origin, so anything else sharing a tenant's origin — a status page, an admin
tool, a file drop, a staging copy — puts a cross-site scripting flaw inside
that tenant's granted account access and operation journal.

A staging copy takes its own subdomain, never a sibling path.

---

## 3. The origin choice is irreversible once anyone uses it

**Decide before first use, not after.**

Each tenant's operation journal lives in IndexedDB under that tenant's origin,
keyed per chain and account:

```
xiongan-asset-v1:<chainId>:<account>
8415-operation-v1:<chainId>:<controller>:<account>
```

Moving a tenant to a different hostname later **strands every journal written
under the old one**. An operation left in `outcome-unknown` — sent to the
network, outcome not yet established — becomes invisible to the application at
the new origin, and the application's whole recovery path depends on finding
that record.

Consequences:

- deploy the Xiongan wallet at `xiongan.8415wallet.com` from the start. Do not
  stand it up on the apex or on a temporary name "for now";
- do not later rename a tenant's subdomain;
- there is no `www` variant of a tenant subdomain. `www.xiongan.8415wallet.com`
  must not resolve, because a user reaching it would silently get a second,
  empty journal.

---

## 4. DNS records

| Type | Name | Value | Notes |
|---|---|---|---|
| `A` | `xiongan.8415wallet.com` | `8.219.77.22` | required — the wallet |
| `A` | `8415wallet.com` | `8.219.77.22` | optional; apex page only, never a wallet |
| `A` | `www.8415wallet.com` | `8.219.77.22` | optional; 301 to apex if the apex page exists |
| `AAAA` | the same names | the host's IPv6 address | **only if** nginx listens on `[::]:443`; see 4.1 |
| `CAA` | `8415wallet.com` | `0 issue "letsencrypt.org"` | required; inherited by all tenants |
| `CAA` | `8415wallet.com` | `0 iodef "mailto:<security contact>"` | recommended |

**No wildcard record.** A wildcard would make every unregistered name resolve
to this host, which defeats the approval model and hands an attacker a working
`secure.8415wallet.com` the moment they can get a certificate for it. Each
tenant gets an explicit `A` record.

Set `A` record TTLs to 300 seconds until acceptance is complete, then raise to
3600.

### 4.1 IPv6 must be all-or-nothing

The acceptance target is an iPhone, and mobile carriers increasingly run
IPv6-only access networks with NAT64. Two configurations are correct: publish
`AAAA` **and** have nginx `listen [::]:443 ssl;`, or publish no `AAAA` at all.

Publishing `AAAA` while nginx listens only on IPv4 makes the phone prefer IPv6,
connect to a closed port, and the page appears broken on cellular while working
on Wi-Fi — easily misdiagnosed as an application fault.

---

## 5. Xinnet-specific items to confirm first

These are registrar-side and can silently block everything downstream.

### 5.1 Real-name verification

Registrars operating in China must complete real-name verification of the
registrant. Until it is, the registrar applies a hold that **removes the
domain's delegation**, which looks exactly like the NXDOMAIN observed above.
The window is typically a few days from registration.

Confirm it is submitted and approved, and report the status. Do not debug DNS
propagation before this is confirmed — an unverified domain will not resolve
however the records are set.

### 5.2 CAA record support

Section 4 requires CAA records. Confirm the Xinnet DNS console can create
records of type `CAA`; some registrar-bundled DNS panels cannot.

If it cannot: keep the registration at Xinnet and **move DNS hosting** to a
provider that supports CAA, by setting that provider's nameservers at Xinnet.
Do not drop the CAA requirement.

### 5.3 DNSSEC

Confirm whether Xinnet allows publishing DS records for `.com`. Enable DNSSEC
if the registrar and DNS host both support it; if not, record it as a known gap
rather than silently skipping it.

### 5.4 Account hardening

Control of this domain is control of every tenant wallet on it. A hijacked name
lets an attacker serve a visually identical page that prompts users for
transactions, under a certificate they obtained themselves. Required:

- registrar transfer lock enabled;
- two-factor authentication on the Xinnet account, and on the DNS hosting
  account if DNS moves;
- auto-renew enabled, with the registrant contact actively monitored — an
  expired wallet domain becomes available for anyone to re-register;
- the registrant contact must be an address the organization controls long
  term, not a personal or temporary mailbox.

### 5.5 Where DNS should be hosted

Recommendation: keep registration at Xinnet, host DNS with a global anycast
provider such as AliDNS. The server is in Singapore and the audience is
international, while a China-based registrar's bundled nameservers add
resolution latency and an availability dependency this deployment otherwise has
no exposure to. Registration stays where it is either way.

---

## 6. Certificates

At this scale the simple approach is also the correct one.

- **One certificate per tenant**, covering exactly that tenant's hostname.
- **No wildcard certificate.** A wildcard would put one private key behind
  every present and future tenant, and it is unnecessary — see the rate limit
  below.
- The apex page, if it exists, takes its own certificate covering
  `8415wallet.com` and `www.8415wallet.com`.
- TLS 1.2 and 1.3 only.
- HTTP-01 is sufficient; no DNS plugin is required.

```
certbot --nginx -d xiongan.8415wallet.com
```

**Rate limit headroom.** Let's Encrypt issues up to 50 certificates per
registered domain every 7 days, counted across all of `8415wallet.com`. With
approval-granted tenants this is not a binding constraint; it would only become
one under open self-service registration, which this model does not do.

If HTTP-01 is used, the port-80 server block must serve
`/.well-known/acme-challenge/` ahead of the HTTPS redirect. The deployment
document's nginx sample does this. A port-80 block that is only
`return 301 https://...` passes first issuance — certbot stands up its own
temporary listener — then fails every unattended renewal roughly 90 days later,
usually silently. Prove it rather than assume it:

```
certbot renew --dry-run
```

Report that output. An untested renewal path is not a configured renewal path.

Add `Strict-Transport-Security` only after HTTPS works end to end; it is
deliberately hard to walk back. HSTS preloading is out of scope for this
deployment — it is effectively one-way and would commit every future tenant
subdomain.

---

## 7. Reserved subdomain names

Even under approval, the names below must never be granted, because each one
produces a plausible-looking phishing origin under the official domain. A user
taught to check for `8415wallet.com` in the address bar cannot distinguish
`secure.8415wallet.com` from the real thing — and that address-bar check is the
only anti-phishing control the application itself can rely on.

Refuse, at minimum:

```
www  secure  security  app  apps  wallet  official  verify  verification
login  signin  sign-in  connect  auth  account  accounts  claim  airdrop
support  help  helpdesk  service  admin  api  mail  email  smtp  ns1  ns2
recover  recovery  restore  seed  mnemonic  backup  update  upgrade  migrate
```

Also refuse any name that is a near-miss of an existing tenant — a tenant named
`xiongan` makes `xiongan-wallet`, `xiongan1` and `xi0ngan` phishing candidates,
so they belong to that tenant or to nobody.

Record each granted subdomain, who approved it, and which organization operates
it. A tenant list that exists only as DNS records is not a record of approval.

---

## 8. Per-tenant deployment configuration

Each tenant subdomain serves the same application build. The only per-tenant
difference is which ERC-8415 deployment the control panel is configured
against.

### 8.1 Read this before placing the file

**The application cannot load this file yet.** `web/app.mjs` obtains the
deployment only from a file-picker element:

```js
el('deployment').addEventListener('change', ...)   // web/app.mjs
```

There is no `fetch` anywhere in the shipped tree. A `deployment.json` placed on
the server today is therefore **inert**: the control panel still requires the
operator to choose the file by hand, exactly as before.

Consequences for this deployment:

- placing the file is **not required** for acceptance, and its absence is not a
  defect;
- placing it is harmless and may be done now so the format is settled;
- making it load is an application change, owned by whoever develops the wallet,
  not by the deploying operator. Do not work around its absence by editing any
  shipped file — see the deployment document's section 4.

The rest of this section is the specification that change will target, so that
a file written now stays valid.

### 8.2 Exact schema

The application already validates this shape strictly; the spec below is read
off that validation rather than invented.

```json
{
  "schema": "8415-controls-testnet/1",
  "chainId": 11155111,
  "token":      { "address": "0x...", "runtimeCodeHash": "0x..." },
  "controller": { "address": "0x...", "runtimeCodeHash": "0x..." },
  "payment":    null
}
```

Rules, each enforced in code today:

| Rule | Failure |
|---|---|
| Exactly these five keys, no more, no fewer: `chainId`, `controller`, `payment`, `schema`, `token` | `CONTROL_DEPLOYMENT_SCHEMA_REFUSED` |
| `schema` is exactly `8415-controls-testnet/1` | `CONTROL_DEPLOYMENT_SCHEMA_REFUSED` |
| `chainId` is `11155111` (Sepolia) or `560048` (Hoodi) | `CONTROL_TESTNET_REQUIRED` |
| `token` is always an object; `controller` and `payment` may be `null` | `CONTROL_DEPLOYMENT_PIN_REFUSED` |
| if `controller` is `null`, `payment` must also be `null` | `CONTROL_DEPLOYMENT_SCHEMA_REFUSED` |
| each object has exactly `address` and `runtimeCodeHash`, nothing else | `CONTROL_DEPLOYMENT_PIN_REFUSED` |
| `address` is 20 bytes hex, `runtimeCodeHash` is 32 bytes hex | `CONTROL_DEPLOYMENT_PIN_REFUSED` |
| the whole file is at most 8192 bytes | `CONTROL_PUBLIC_DOCUMENT_REFUSED` |

**The control panel is testnet-only.** A mainnet `chainId` is refused outright.
This matches the page banner and is not something the configuration can widen.
It does not affect the external-asset panel, which is separate.

### 8.3 Producing runtimeCodeHash

The pin is checked against the chain at connect time:

```js
hashControlBytes(await eth_getCode(address, 'latest')) === runtimeCodeHash   // CONTROL_RUNTIME_PIN_MISMATCH
```

So `runtimeCodeHash` is the keccak-256 of the deployed runtime bytecode as
returned by `eth_getCode`, hashed over the raw bytes, not over the hex string.
Compute it against the same chain named in `chainId`, for example:

```
cast keccak $(cast code <address> --rpc-url <endpoint>)
```

Produce it from the live chain, never by hand and never copied from another
deployment. A wrong hash does not fail quietly at load time — it fails at
connect, after the user has already been asked to connect a wallet.

### 8.4 Where the file lives

Keep it **outside the git clone**, and serve it into place. The document root
is a clone of `deploy/xiongan-sin` and must stay updatable with `git pull`; a
tenant-specific file committed into it or dropped in untracked invites a
conflict or a `git clean` that silently removes the tenant's configuration.

```
/srv/tenant/xiongan/deployment.json        <- tenant configuration, managed separately
/srv/xiongan/                              <- the clone, never edited
```

Served at `/web/deployment.json` on the tenant origin, which is the path a
relative load from `web/app.mjs` resolves to:

```nginx
# Must appear ABOVE the blanket .json refusal in the deployment document's
# sample, which would otherwise 404 it. The blanket refusal stays, so this is
# the only reachable .json on the origin.
location = /web/deployment.json {
    alias /srv/tenant/xiongan/deployment.json;
    add_header Cache-Control "no-store" always;
}
```

`no-store` matters: a stale cached configuration would point a tenant at an
address that is no longer current, and the mismatch would surface as a connect
failure rather than as an obviously out-of-date file.

Do **not** add this file to `SHA256SUMS`. That manifest covers the published
tree and is verified with `sha256sum -c` before serving; a tenant file in it
would make the integrity check fail on every other tenant.

### 8.5 What to report for this file

If the file is placed now:

1. the file's content, verbatim;
2. for each pinned address, the `eth_getCode` result's keccak-256, and the
   command used, showing it was computed from the live chain;
3. `curl -sS https://xiongan.8415wallet.com/web/deployment.json` output and its
   `Content-Type` and `Cache-Control` headers;
4. confirmation that some other `.json` path on the origin still returns 404.

## 9. Aliyun host items

**No ICP filing is required.** The host is in Aliyun's Singapore region; ICP
filing (ICP beian) applies to mainland China regions. Do not let a filing
requirement be assumed into the timeline. This changes if the domain is ever
pointed at a mainland server.

**Security group.** Inbound TCP 80 and 443 open to `0.0.0.0/0`, and `::/0` if
IPv6 is published. Port 80 is needed for the ACME challenge and the HTTPS
redirect; it is not optional even though no content is served on it.

---

## 10. Interim access before the name resolves

Wildcard DNS services resolving an encoded IP, such as `8.219.77.22.nip.io`,
are **not acceptable** beyond at most a throwaway check that nginx serves
bytes: issuance through them shares one registered domain's rate limits, and
their operator controls name resolution for a wallet origin.

For a pre-DNS functional check use SSH port-forwarding to `localhost`, which
**is** a secure context and so satisfies section 1:

```
ssh -L 8443:127.0.0.1:443 <user>@8.219.77.22
```

then open `https://localhost:8443/web/index.html` on the forwarding machine.
This validates serving, MIME types and headers. It does not validate the
certificate chain and cannot be done from the iPhone, so it substitutes for no
acceptance item.

---

## 11. Report back

**Open now, in priority order.**

1. **Move the web listener off TCP 443**, and retarget the port-80 redirect to
   the allocated port. Report which port the allocation names; do not guess
   one. This is first because it changes the web origin, and doing it after the
   first genuine wallet use strands stored state rather than merely moving a
   listener. See the deployment document's section 2.2.
2. **Add `Strict-Transport-Security`.** Absent on the live origin. HTTPS is
   working, which was the condition section 6 set for adding it.
3. **Resolve the apex.** It resolves to the host but serves a certificate that
   does not name it, so `https://8415wallet.com/` is a validation failure on
   the brand domain. Give it its own certificate and a plain page, or withdraw
   its `A` record. Report which.
4. `dig +short CAA 8415wallet.com` — report the records, or that none exist.
   Section 4 requires them and they were not part of bringing the site up.
5. Real-name verification status at Xinnet (5.1). Delegation resolves, which
   suggests it passed; confirm rather than infer, because the hold can be
   applied later.
6. Whether DNS stays at Xinnet. It is currently on `ns11/ns12.xincache.com`;
   5.5 recommends moving it, which is a judgement for the owner, not a defect.
7. `dig +short AAAA xiongan.8415wallet.com`. None is published, which is a
   valid choice under 4.1 provided nginx is not listening on `[::]:443`.
   Confirm the two agree.

**Also report:**

7. DNSSEC, transfer lock and account 2FA status (5.3, 5.4).
8. Certificate issuer, subject, SANs and `notAfter` for the tenant. This could
   not be checked from outside: the checking environment re-terminates TLS, so
   it can confirm that validation succeeds but cannot see the real chain.
9. Which ACME challenge type was used.
10. `certbot renew --dry-run` output. Still outstanding and still the item most
    likely to fail silently, roughly 90 days after first issuance.
11. Aliyun security group rules covering 80 and 443.
12. Confirmation that `xiongan.8415wallet.com` serves this application only.
13. Confirmation that no wildcard DNS record and no wildcard certificate exist.

**Verified already, no action needed.** Recorded so they are not re-tested:
`.mjs` and `.js` both serve as `text/javascript`; `frame-ancestors 'none'`,
`X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`
and `Permissions-Policy` are present; `/.git/config`, `SHA256SUMS`, `DEPLOY.md`
and `web/deployment.json` all return 404; port 80 redirects to HTTPS; and the
served tree matches `main`'s build exactly.
