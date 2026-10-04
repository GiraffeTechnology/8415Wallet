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

Obtain the exact approved HTTPS URL, including hostname, allocated web port and
entry path, for each target before deployment. Store it in the release/deployment
configuration and use it verbatim in links, redirects, acceptance records and
bookmarks. Do not construct a link from a bare hostname.

TCP **443 is reserved for SSH** on CTYun and SIN, and must not be bound by a web
server, reverse proxy, TLS listener or bridge. Do not stop or rebind SSH to make
room. No replacement web port is chosen here. Missing allocation blocks the
server deployment step, not the ability to build an unconfigured functional
Beta package.


Distinguish a public TLS endpoint from the upstream server listener. A separately
approved externally managed TLS front door can use a confirmed public HTTPS
port while its SIN/CTYun upstream retains a confirmed non-443 listener. Record
the two boundaries independently; an external public port does not authorize
binding that port on a reserved origin host. No external proxy or new endpoint
is selected by this handoff.

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
- Use a certificate-validation method compatible with the port reservation.
  HTTP-01 may use the existing approved port-80 challenge path. TLS-ALPN-01 on
  port 443 is incompatible with its SSH reservation. The current operations
  policy selects HTTP-01 over port 80; this handoff does not change that policy.
- A port-80 redirect must target the exact full configured HTTPS URL/port,
  preserving the requested path only within that approved origin. A redirect
  to a hostname without its allocated port reaches 443 and is incorrect here.
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
