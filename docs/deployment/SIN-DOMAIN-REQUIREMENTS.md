# 8415wallet platform and tenant domains

## Product identity

The product is **8415wallet**. **8415wallet.com** is its UI platform domain.
**Xiongan is a V2 tenant**; its tenant hostname is `xiongan.8415wallet.com`.
The product version, tenant and hosting origin are separate configuration facts.
A V3 package is not a renamed Xiongan V2 package: its release profile and PRD
scope must identify the additional linked features.

The earlier rule that the apex could never serve the wallet is superseded by
this platform definition. This document does not deploy the platform, allocate
a port, add DNS records or grant another tenant access. Platform and tenant UI
can share reviewed code while keeping their configured origins and journals
separate.

## Required deployment input

Choose the HTTPS URL for each target before deployment: hostname, a web port
that is free on the host and not reserved, and the entry path. Store it in the
release/deployment configuration and use it verbatim in links, redirects,
acceptance records and bookmarks. Do not construct a link from a bare hostname.
No port allowlist from the product owner is required.

Reserved ports are host configuration (`deployment.reservedPorts`). On CTYun
hosts TCP 443 is reserved for SSH and must not be bound by a web server, reverse
proxy, TLS listener or bridge; do not stop or rebind SSH. This CTYun rule does
not apply to SIN unless the SIN host is explicitly configured that way.

Distinguish a public TLS endpoint from the upstream server listener. A separate
TLS front door can publish a different public port than its upstream listener.
Record the two boundaries independently, and keep each off its own host's
reserved ports. No external proxy or new endpoint is selected by this handoff.

The web origin is the complete scheme, hostname and port. Changing any one
creates a different IndexedDB security boundary. A new hostname, alternate
port, temporary hostname or `www` alias does not inherit outstanding journals.
Resolve the final origin before real wallet use. If an origin already has
unresolved transactions, preserve it for reconciliation and plan the change
explicitly; never erase storage or infer that an empty new journal means no
outstanding transaction exists.

## DNS and certificates

- Use an approved explicit DNS record for each platform or tenant hostname.
  No wildcard tenant allocation or self-service provisioning is implied.
- Publish IPv6 only when the service listens correctly on the confirmed IPv6
  web endpoint. A broken AAAA record can strand mobile clients.
- Serve a publicly trusted certificate valid for the actual hostname; never
  bypass a browser certificate warning.
- Use a certificate-validation method compatible with the host's reserved
  ports. Where 443 is reserved (CTYun hosts), use HTTP-01 over port 80;
  TLS-ALPN-01 validates on 443.
- A port-80 redirect must target the exact full configured HTTPS URL and port,
  preserving the requested path only within that origin. A redirect to a
  hostname without its port reaches the scheme default port instead.
- Do not change SSH, firewalls, registrar accounts, DNSSEC, credentials,
  persistent permissions or network configuration as part of merely preparing
  this package. Those operations retain their separate authorization needs.

## Isolation and service policy

Serve only the reviewed static DApp and its public release configuration on a
wallet origin. Do not share that origin with an admin console, upload endpoint,
analytics, unrelated site or signer. Staging uses an explicitly separate origin.
The host has no private key, wallet seed, custody service or RPC proxy.

The browser's public configuration must contain no credential, private RPC
endpoint, raw signature or secret. Any contract address/runtime hash in a
public deployment file identifies the exact authorized testnet deployment.
These are pins to verify, never proof of an audit or authority to transact.

Serve JavaScript modules with a JavaScript MIME type. Supply `frame-ancestors
'none'` in an HTTP CSP header in addition to the page's existing CSP. See
[SIN static deployment requirements](SIN-STATIC-DEPLOYMENT-REQUIREMENTS.md) and
[the versioned Beta handoff](../BETA-DAPP-DELIVERY.md).

## Historical observations

An earlier 2026-10-03 report described DNS delegation through
`ns11.xincache.com` / `ns12.xincache.com`, an apex and tenant A record, and a
62-file tenant bundle served on the then-default HTTPS port. Those observations
belong to that historical source and configuration. They do not establish
current online status, the correctness of a reserved-port deployment, or
acceptance of the new V2/V3 artifacts. Recheck the actual configured endpoint
and record its current certificate, response headers and served hashes.
