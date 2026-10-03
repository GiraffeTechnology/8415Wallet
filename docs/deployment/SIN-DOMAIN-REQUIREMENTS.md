# 8415wallet.com — domain and TLS requirements for the SIN host

Companion to `SIN-STATIC-DEPLOYMENT-REQUIREMENTS.md`. That document assumes a
hostname exists and calls it `<host>`. This one resolves `<host>` and specifies
how it is delegated, secured and renewed.

| | |
|---|---|
| Domain | `8415wallet.com` |
| Registrar | Xinnet (xinnet.com) |
| Server | Aliyun Singapore, `8.219.77.22` |
| Purpose | this wallet application and nothing else |

**This is a blocking prerequisite.** Deployment cannot begin, and cannot be
smoke-tested from a phone, until the name resolves to that address and carries
a publicly trusted certificate.

## Observed state at time of writing

Queried over DNS-over-HTTPS on 2026-10-03:

```
8415wallet.com  NS    -> NXDOMAIN (Status 3)
8415wallet.com  A     -> NXDOMAIN (Status 3)
8415wallet.com  SOA   -> NXDOMAIN (Status 3)
```

The authority section came from `a.gtld-servers.net`, meaning the `.com` zone
currently carries **no delegation** for this name. Nothing resolves yet. This
is expected shortly after registration, but see section 3 — it is also what a
registrar hold looks like, so confirm which it is rather than waiting.

---

## 1. Why a hostname is required rather than preferred

Two independent reasons, either alone decisive.

**The application refuses to start without a secure context.** Both browser
stores open with:

```js
if (!globalThis.indexedDB || !globalThis.isSecureContext) throw new Error('CONTROL_BROWSER_DURABILITY_REQUIRED');
```

A public IP over plain HTTP is not a secure context. The application fails
closed here rather than falling back to `localStorage` or an in-memory journal,
so no configuration flag relaxes it. `http://8.219.77.22/` cannot work, and
this is not a warning a user can click past.

**Standard certificate issuance validates a domain.** ACME issuance is
domain-validated. Do not attempt to obtain a certificate for the bare IP.

A self-signed or privately-rooted certificate is not acceptable. Wallet in-app
browsers usually offer no trust-override interface, and conditioning an
operator to accept certificate warnings on a wallet origin is precisely the
habit that makes wallet phishing effective.

---

## 2. Canonical origin: decide apex versus www, and serve exactly one

`8415wallet.com` and `www.8415wallet.com` are **two different web origins**.

This matters more here than on an ordinary site. The wallet's operation journal
lives in IndexedDB, which is scoped per origin. A user who reaches the apex on
one visit and `www` on another gets **two separate journals**, and an operation
left in `outcome-unknown` on one is invisible from the other. That is a
correctness problem, not a cosmetic one.

Required configuration:

- **`8415wallet.com` (apex) serves the application.** This is the canonical
  origin and the one to put in front of users.
- **`www.8415wallet.com` resolves and redirects** to the apex with a 301, over
  HTTPS, and serves no content of its own.

`www` must resolve rather than be omitted: a user who types it should land on
the wallet, not on a DNS error they cannot interpret. Because the redirect has
to work for `https://www....` too, the certificate must cover both names
(section 6).

If the operator prefers `www` as canonical, that is acceptable — but then the
apex redirects to it, and the choice must be made once and never reversed.
Reversing it strands every journal written under the old origin.

---

## 3. Xinnet-specific items to confirm before anything else

These are registrar-side and can silently block everything downstream.

### 3.1 Real-name verification

Registrars operating in China are required to complete real-name verification
of the registrant. Until it is completed, the registrar applies a hold that
**removes the domain's delegation**, which looks exactly like the NXDOMAIN
observed above. The window is typically a few days from registration.

Confirm the verification is submitted and approved, and report the status. Do
not spend time debugging DNS propagation before this is confirmed — an
unverified domain will not resolve no matter how the records are set.

### 3.2 CAA record support

Section 5 requires CAA records. Confirm the Xinnet DNS console can create
records of type `CAA`. Some registrar-bundled DNS panels cannot.

If it cannot: keep the registration at Xinnet and **move DNS hosting** to a
provider that supports CAA, by setting that provider's nameservers at Xinnet.
Do not drop the CAA requirement.

### 3.3 DNSSEC

Confirm whether Xinnet allows publishing DS records for `.com`. Enable DNSSEC
if both the registrar and the DNS host support it. If not supported, record
that as a known gap rather than silently skipping it.

### 3.4 Account hardening

Control of this domain is control of the wallet. A hijacked name lets an
attacker serve a visually identical page that prompts users for transactions,
with a valid certificate they obtained themselves. Required:

- registrar transfer lock enabled;
- two-factor authentication on the Xinnet account, and on the DNS hosting
  account if DNS moves elsewhere;
- auto-renew enabled, and the registrant contact address actively monitored —
  an expired wallet domain becomes available for anyone to re-register;
- the registrant contact must be an address the organization controls long
  term, not a personal or temporary mailbox.

### 3.5 Where DNS should be hosted

Recommendation, for the operator to accept or reject: keep registration at
Xinnet, host DNS at a provider with authoritative servers close to the
audience and to the Singapore origin — AliDNS (which also enables the DNS-01
option in section 6) or an equivalent global anycast provider.

Reasoning: the server is in Singapore and the audience is international, while
a China-based registrar's bundled nameservers add resolution latency and an
availability dependency on network conditions this deployment otherwise has no
exposure to. This is a reliability judgement, not a security one; registration
stays where it is either way.

---

## 4. The wallet must occupy its own origin

**Requirement: `8415wallet.com` serves this application and nothing else.**

Wallet applications grant account access per origin, and IndexedDB is scoped
per origin. Any other content sharing the origin — a marketing page, a status
dashboard, an admin tool, a file drop, a staging copy — means a cross-site
scripting flaw in that content executes inside the wallet's origin, with its
granted account access and its operation journal.

Refused, specifically:

- serving the wallet under a path while other applications occupy other paths
  of the same host;
- adding a landing page, analytics endpoint or redirect service to the apex;
- pointing a second application at this origin later.

A staging copy takes a separate hostname such as `staging.8415wallet.com`, and
is never a sibling path. A marketing site, if one is wanted, takes a different
domain or a subdomain — never the origin that serves the wallet.

---

## 5. DNS records

| Type | Name | Value | Notes |
|---|---|---|---|
| `A` | `8415wallet.com` | `8.219.77.22` | required |
| `A` | `www.8415wallet.com` | `8.219.77.22` | required; redirect only (section 2) |
| `AAAA` | both names | the host's IPv6 address | **only if** nginx listens on `[::]:443`; see 5.1 |
| `CAA` | `8415wallet.com` | `0 issue "letsencrypt.org"` | required; pin the issuing CA |
| `CAA` | `8415wallet.com` | `0 iodef "mailto:<security contact>"` | recommended |

CAA at the apex is inherited by subdomains, so one pair covers `www` as well.

No wildcard record and no wildcard certificate. A wildcard spreads one key
across every present and future subdomain, which is the opposite of the origin
isolation section 4 requires.

Set the `A` record TTL to 300 seconds until acceptance is complete, then raise
it to 3600. A short TTL during bring-up makes a correction cheap; a short TTL
forever makes outages longer than they need to be.

### 5.1 IPv6 must be all-or-nothing

The acceptance target is an iPhone, and mobile carriers increasingly run
IPv6-only access networks with NAT64. Two configurations are correct:

- publish `AAAA` **and** have nginx `listen [::]:443 ssl;` — preferred; or
- publish no `AAAA` at all, and let NAT64 handle it.

The failure to avoid is publishing `AAAA` while nginx listens only on IPv4.
The phone then prefers IPv6, connects to a closed port, and the page appears
broken on cellular while working on Wi-Fi — easily misdiagnosed as an
application fault.

---

## 6. Certificate issuance and renewal

Requirements:

- publicly trusted CA matching the `CAA` record;
- one certificate with both names as SANs: `8415wallet.com` and
  `www.8415wallet.com`; no wildcard;
- TLS 1.2 and 1.3 only;
- unattended renewal configured **and proven**, not merely installed.

```
certbot --nginx -d 8415wallet.com -d www.8415wallet.com
```

If HTTP-01 is used, the port-80 server block must serve
`/.well-known/acme-challenge/` ahead of the HTTPS redirect. The deployment
document's nginx sample does this. A port-80 block that is only
`return 301 https://...` passes first issuance — certbot stands up its own
temporary listener — and then fails every unattended renewal roughly 90 days
later, usually silently. Prove it instead of assuming it:

```
certbot renew --dry-run
```

Report that command's output. An untested renewal path is not a configured
renewal path.

If DNS is hosted at AliDNS, the DNS-01 challenge is available via the certbot
plugin `certbot-dns-aliyun`, using a RAM user restricted to DNS access on this
zone only. DNS-01 removes the dependency on port 80 for renewals. Either
challenge type is acceptable; report which was used.

Add `Strict-Transport-Security` only after HTTPS is confirmed working end to
end. It is deliberately hard to walk back.

**HSTS preloading is not part of this deployment.** It is attractive for a
wallet origin because it removes the first-visit downgrade window, but
submission to the browser preload list is effectively one-way and commits
every current and future subdomain to HTTPS. Revisit it once the deployment
is stable, as a separate decision.

---

## 7. Aliyun host items

**No ICP filing is required.** The host is in Aliyun's Singapore region; ICP
filing (ICP beian) applies to mainland China regions. Do not let a filing
requirement be assumed into the timeline. Note for later: this changes if the
domain is ever pointed at a mainland server.

**Security group.** Inbound TCP 80 and 443 open to `0.0.0.0/0`, and `::/0` if
IPv6 is published. Port 80 is needed for the ACME HTTP-01 challenge and the
redirect to HTTPS; it is not optional even though no content is served on it.

---

## 8. Lookalike domains

`8415wallet.com` is a wallet origin, so it will attract lookalikes whose only
purpose is to collect transaction approvals from users who mistype or follow a
link. This is not a launch blocker and needs no engineering, but two cheap
measures are worth the operator's decision now rather than after an incident:

- defensively register the few most plausible variants if the cost is
  acceptable;
- monitor newly registered domains resembling this one, so a phishing clone is
  found by the operator rather than by a user.

Users will verify this name by eye in a wallet browser's address bar, which is
the only anti-phishing control the application itself can rely on.

---

## 9. Interim access before the name resolves

There are wildcard DNS services resolving an encoded IP, such as
`8.219.77.22.nip.io`. **Not acceptable here**, beyond at most a throwaway check
that nginx serves bytes: issuance through such a service shares one registered
domain's rate limits, and more importantly its operator controls name
resolution for the wallet's origin — a hijack vector pointed at the thing being
protected.

For a pre-DNS functional check, use SSH port-forwarding to `localhost`, which
**is** a secure context and therefore satisfies section 1:

```
ssh -L 8443:127.0.0.1:443 <user>@8.219.77.22
```

then open `https://localhost:8443/web/index.html` on the forwarding machine.
This validates serving, MIME types and headers. It does not validate the
certificate chain, and cannot be done from the iPhone, so it substitutes for no
item of the acceptance evidence.

---

## 10. Report back

**Unblocks deployment (needed first):**

1. Real-name verification status at Xinnet (section 3.1).
2. Whether DNS stays at Xinnet or moves, and to where (3.2, 3.5).
3. Which origin is canonical, apex or `www` (section 2).
4. `dig +short NS 8415wallet.com`
5. `dig +short A 8415wallet.com` and `dig +short A www.8415wallet.com`
6. `dig +short AAAA 8415wallet.com`, if published.
7. `dig +short CAA 8415wallet.com`

**May follow with the deployment report:**

8. Whether DNSSEC, transfer lock and account 2FA are enabled (3.3, 3.4).
9. Certificate issuer, subject, SANs and `notAfter`.
10. Which ACME challenge type was used.
11. `certbot renew --dry-run` output.
12. Aliyun security group rules covering 80 and 443.
13. Confirmation that the origin serves this application only (section 4).
