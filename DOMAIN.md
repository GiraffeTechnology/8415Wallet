# Xiongan Wallet — domain and TLS requirements for the SIN host

Companion to `SIN-STATIC-DEPLOYMENT-REQUIREMENTS.md`. That document assumes a
hostname exists and calls it `<host>`. This one specifies how `<host>` is
chosen, delegated and secured.

Host: Aliyun Singapore, `8.219.77.22`.

**This is a blocking prerequisite.** Deployment cannot begin, and cannot be
smoke-tested, until a hostname resolves to that address and carries a publicly
trusted certificate.

---

## 1. Why a hostname is required rather than preferred

Two independent reasons, either of which alone is decisive.

**The application refuses to start without a secure context.** Both browser
stores open with:

```js
if (!globalThis.indexedDB || !globalThis.isSecureContext) throw new Error('CONTROL_BROWSER_DURABILITY_REQUIRED');
```

A public IP over plain HTTP is not a secure context. The application is written
to fail closed here rather than fall back to `localStorage` or an in-memory
journal, so there is no configuration flag that relaxes it. `http://8.219.77.22/`
therefore cannot work, and this is not a warning a user can click past.

**Standard certificate issuance validates a domain.** ACME issuance from Let's
Encrypt and the common alternatives is domain-validated. IP-address certificates
exist only under limited, short-lived profiles with uneven client support, and
mobile wallet in-app browsers are the least predictable TLS clients in use. Do
not attempt to obtain a certificate for the bare IP.

A self-signed or privately-rooted certificate is not acceptable. Wallet in-app
browsers usually offer no trust-override interface, and conditioning an operator
to accept certificate warnings on a wallet origin is precisely the habit that
makes wallet phishing effective.

---

## 2. Decision required from the owner

Pick one and report which:

**(a) A subdomain of a domain the owner already controls.** Preferred when such
a domain exists. A subdomain is a distinct web origin, so browser storage —
which is what this application relies on — is fully isolated from the parent
domain. This application sets no cookies, so the usual subdomain cookie-leakage
concern does not apply to it.

**(b) A newly registered domain.** Required if no suitable domain exists.
See section 7 for naming constraints before registering anything.

Either way the result must satisfy section 3.

---

## 3. The wallet must occupy its own origin

**Requirement: `<host>` serves this application and nothing else.**

Wallet applications grant account access per origin, and IndexedDB is scoped
per origin. Any other content sharing `<host>` — a marketing page, a status
dashboard, an admin tool, a file drop, a staging copy — means that a cross-site
scripting flaw anywhere in that content executes inside the wallet's origin,
with its granted account access and its operation journal.

Concretely, all of the following are refused:

- serving the wallet under a path such as `https://example.com/wallet/` while
  other applications occupy other paths of the same host;
- adding a landing page, redirect service or analytics endpoint to `<host>`;
- pointing a second application at `<host>` later.

A staging copy, if one is wanted, takes a separate hostname, and must not be a
sibling path.

---

## 4. DNS records

| Type | Name | Value | Notes |
|---|---|---|---|
| `A` | `<host>` | `8.219.77.22` | required |
| `AAAA` | `<host>` | the host's IPv6 address | **only if** nginx listens on `[::]:443`; see 4.1 |
| `CAA` | `<host>` | `0 issue "letsencrypt.org"` | required; pin the issuing CA |
| `CAA` | `<host>` | `0 iodef "mailto:<security contact>"` | recommended |

No wildcard record, and no wildcard certificate. A wildcard spreads one key
across every present and future subdomain, which is the opposite of the origin
isolation section 3 requires.

Set the `A` record TTL to 300 seconds until acceptance is complete, then raise
it to 3600. A short TTL during bring-up makes a correction cheap; a short TTL
forever makes outages longer than they need to be.

### 4.1 IPv6 must be all-or-nothing

The acceptance target is an iPhone, and mobile carriers increasingly run
IPv6-only access networks with NAT64. Two configurations are correct:

- publish `AAAA` **and** have nginx `listen [::]:443 ssl;` — preferred; or
- publish no `AAAA` at all, and let NAT64 handle it.

The failure to avoid is publishing `AAAA` while nginx listens only on IPv4.
The phone then prefers IPv6, connects to a closed port, and the page appears
broken on cellular while working on Wi-Fi. This is easy to misdiagnose as an
application fault.

### 4.2 Registrar and DNS account hardening

Control of `<host>` is control of the wallet. A hijacked name lets an attacker
serve a visually identical page that prompts for transactions. Required:

- registrar transfer lock enabled;
- two-factor authentication on both the registrar account and the DNS hosting
  account, not SMS-based where an alternative exists;
- DNSSEC enabled if the registrar and DNS provider both support it;
- registration auto-renew enabled, and the registrant contact address monitored
  — an expired wallet domain is available for anyone to re-register.

---

## 5. Aliyun-specific items

**No ICP filing is required.** The host is in Aliyun's Singapore region. ICP
filing (ICP beian) applies to servers in mainland China regions. Do not let a filing
requirement be assumed into the timeline; if anyone raises it, the answer is
that the region is overseas.

**Security group.** Inbound TCP 80 and 443 must be open to `0.0.0.0/0` (and
`::/0` if IPv6 is published). Port 80 is needed for the ACME HTTP-01 challenge
and for the redirect to HTTPS; it is not optional even though no content is
served over it.

**If DNS is hosted at Aliyun (AliDNS)**, the DNS-01 challenge is available via
the certbot plugin `certbot-dns-aliyun`, using a RAM user restricted to
`AliyunDNSFullAccess` on that zone only. DNS-01 avoids depending on port 80 for
renewals. Either challenge type is acceptable; report which was used.

---

## 6. Certificate issuance and renewal

Requirements:

- publicly trusted CA, matching the `CAA` record;
- certificate covers `<host>` exactly; no wildcard;
- TLS 1.2 and 1.3 only;
- unattended renewal configured **and proven**, not merely installed.

If HTTP-01 is used, the port-80 server block must serve
`/.well-known/acme-challenge/` ahead of the HTTPS redirect. The deployment
document's nginx sample does this. A port-80 block that is only
`return 301 https://...` passes first issuance — certbot stands up its own
temporary listener — and then fails every unattended renewal roughly 90 days
later, usually silently. Confirm renewal works rather than assuming it:

```
certbot renew --dry-run
```

Report that command's output. An untested renewal path is not a configured
renewal path.

Add `Strict-Transport-Security` only after HTTPS is confirmed working end to
end. It is deliberately hard to walk back.

---

## 7. Naming constraints, if a new domain is registered

The application's user-facing name is "Xiongan Wallet".

**Do not register a name that implies official affiliation.** Xiongan is a real
administrative area in China. A domain that reads as the official wallet of a
government body — or of any organization that has not authorized it — is both a
legal exposure and structurally indistinguishable from a phishing domain. Avoid
constructions suggesting government, municipal or state backing.

Practical guidance:

- prefer a subdomain of a domain the operating organization already owns, which
  makes provenance obvious and sidesteps the question entirely;
- if registering fresh, keep it short, unambiguous and readable aloud, because
  users will verify it by eye in a wallet browser's address bar;
- avoid homoglyph-prone spellings and hyphenated near-misses of an existing
  brand; these are the shapes attackers register against you later;
- avoid a TLD with weak registrar verification or a history of abuse-driven
  blocklisting, which can cause wallet applications and mobile browsers to warn
  on the domain through no fault of its content.

Proposed shape, for the owner to confirm or replace:

```
wallet.<domain the organization already owns>
```

The owner, not this document and not the deploying operator, decides the final
name. Report it back before issuance so it can be recorded against the
deployment.

---

## 8. Interim access without a domain

There are wildcard DNS services that resolve an encoded IP, such as
`8.219.77.22.nip.io`, and certificates can sometimes be obtained for them.

**Not acceptable for this deployment**, beyond at most a throwaway check that
nginx serves bytes. Two reasons: issuance through such a service shares one
registered domain's rate limits with every other user and is therefore
unreliable, and more importantly the operator of that service controls name
resolution for the wallet's origin. That is a hijack vector pointed directly at
the thing being protected.

If a pre-domain smoke test is wanted, do it over SSH port-forwarding to
`localhost`, which **is** a secure context and therefore satisfies section 1
for a functional check:

```
ssh -L 8443:127.0.0.1:443 <user>@8.219.77.22
```

then open `https://localhost:8443/web/index.html` on the forwarding machine.
This validates serving, MIME types and headers. It does not validate the
certificate chain, and it cannot be done from the iPhone, so it does not
substitute for any item of the acceptance evidence.

---

## 9. Report back

1. Which option from section 2 was taken, and the chosen `<host>`.
2. `dig +short A <host>` and, if published, `dig +short AAAA <host>`.
3. `dig +short CAA <host>`.
4. Confirmation that `<host>` serves this application only (section 3).
5. Whether DNSSEC, registrar transfer lock and account 2FA are enabled.
6. Certificate issuer, subject, and `notAfter`.
7. Which ACME challenge type was used.
8. `certbot renew --dry-run` output.
9. Aliyun security group rules covering 80 and 443.

Items 1 to 3 are enough to unblock the deployment document's section 2; the
rest may follow with the deployment report.
