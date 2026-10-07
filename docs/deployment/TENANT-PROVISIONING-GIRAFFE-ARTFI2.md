# Provision two tenants: giraffe and artfi2

For the operator configuring them on the host. This is configuration, not an
application change: no code edit is required to add either tenant.

| | |
|---|---|
| Tenants | `giraffe`, `artfi2` |
| Origins | `https://giraffe.8415wallet.com`, `https://artfi2.8415wallet.com` |
| Profile | **v3** for both — see section 2 |
| Purpose | the two independent wallets the W-20 journey needs |

Both names satisfy the installer's tenant pattern `^[a-z][a-z0-9-]{0,47}$`, and
neither is on the reserved-subdomain list in `SIN-DOMAIN-REQUIREMENTS.md`.

## 1. No code change is needed

The directory is named `deploy/auth-xiongan/`, which reads as tenant-specific
and is not. `paths(prefix, tenant)` derives every path from the tenant:

```
/opt/8415wallet-auth-<tenant>
/etc/8415wallet-auth-<tenant>
/var/lib/8415wallet-auth-<tenant>
/etc/systemd/system/8415wallet-auth-<tenant>.service
/run/8415wallet-auth-<tenant>
```

Every command takes `--tenant`, defaulting to `xiongan` only when omitted. So
`--tenant giraffe` and `--tenant artfi2` produce two fully separate installs,
services and state directories. Do not copy or fork the directory per tenant.

## 2. Profile must be v3, not v2

`web/release-profile.mjs` defines the two profiles, and the difference decides
whether these tenants can do anything W-20 asks for:

| | v2 | v3 |
|---|---|---|
| `linkedResponsibilities` | `false` | `true` |

On a v2 release the page hides the linked tab and refuses every control action
outside `create-account`, `account`, `deposit` and `standalone-withdraw` with
`CONTROL_RELEASE_PROFILE_REFUSED`. Consent review, acceptance, forward and
return are all refused.

**A v2 tenant cannot run the W-20 journey.** Both of these are `--profile v3`.

## 3. DNS and certificate, per tenant

From `SIN-DOMAIN-REQUIREMENTS.md`, unchanged and repeated here only as the
per-tenant checklist:

- an explicit `A` record per tenant. **No wildcard record** — a wildcard
  resolves every unapproved name to this host and defeats the approval model;
- **one certificate per tenant**, covering exactly that hostname. No wildcard
  certificate;
- no `www` variant of a tenant subdomain. A user reaching one would silently
  open a second, empty operation journal;
- `CAA` at the apex is inherited and needs no per-tenant record.

**The serving address is part of stored state.** A web origin is scheme, host
and port, so each tenant's operation journal belongs to its own origin. Settle
each origin before it carries genuine wallet use; a later move is data loss,
not reconfiguration.

## 4. DApp configuration and install

Per tenant, with `deploy/dapp/install.mjs`. Every argument is explicit; the
installer refuses rather than defaulting.

```
node deploy/dapp/install.mjs config \
  --tenant giraffe \
  --label '<display label>' \
  --profile v3 \
  --environment <environment id> \
  --url https://giraffe.8415wallet.com/web/index.html \
  --reserved-ports <comma list|none> \
  --output /absolute/path/giraffe-release.json
```

Then `plan`, then `install`:

```
node deploy/dapp/install.mjs install \
  --tenant giraffe --profile v3 \
  --target <target root> --tree <expected tree> \
  --archive <artifact> --sha256 <artifact sha256> \
  --config /absolute/path/giraffe-release.json
```

Notes:

- `--reserved-ports` takes the host's reserved ports, or the literal `none`.
  Which ports a host reserves is that environment's configuration; the
  installer enforces whatever is listed and has no rule of its own;
- `--output` must be absolute, and the file must not already exist;
- `IDENTITY.json` binds the install to tenant and profile. A later `upgrade`
  with a different pair is refused with `IDENTITY_MISMATCH`;
- repeat the whole block for `artfi2`.

## 5. Where the wallet addresses go

Not in the release config. `8415wallet-release/1` carries product, platform,
profile, tenant and deployment, and has **no address field**. The addresses are
auth bindings, supplied to `prepare` as a JSON file.

```
node deploy/auth-xiongan/install.mjs prepare \
  --package <package dir> \
  --node <absolute node path> \
  --origin https://giraffe.8415wallet.com \
  --tenant giraffe \
  --bindings /absolute/path/giraffe-bindings.json \
  --reserved-ports none
```

`giraffe-bindings.json` is an array, and each entry may carry **only**
`username` and `wallets` — any other key is refused with
`AUTH_PUBLIC_BINDINGS_ONLY`:

```json
[
  {
    "username": "<operator-chosen username>",
    "wallets": [{ "account": "0x<GIRAFFE_WALLET_ADDRESS>", "chainId": "11155111" }]
  }
]
```

- `chainId` is `11155111` for Sepolia. Use `560048` only if the journey runs on
  Hoodi instead; it must match the chain the deployment is pinned to;
- `artfi2-bindings.json` is the same shape with the second address;
- a binding is a **public** address record. It is not a credential, confers no
  operator or tenant-management authority, and does not authenticate anyone.
  Registration still requires its own verified email ownership and an exact
  origin/tenant/account/chain/purpose-bound control proof.

### The two addresses are a required input

This document deliberately leaves `0x<GIRAFFE_WALLET_ADDRESS>` and the artfi2
equivalent as placeholders. Supply both from the wallets that actually hold the
testnet funds; do not substitute an address from a fixture, a previous run or a
test vector.

## 6. Activation is a separate human step

From the installer's own help:

> `prepare` installs an **inactive runtime only**. Human runs
> `server/operator-activate.mjs` in a **trusted terminal**. No command accepts
> secrets.

So `prepare` finishing is not a running service. Activation is performed by a
person at a trusted terminal, per tenant, and no secret is passed through any
command line. Then:

```
node deploy/auth-xiongan/install.mjs enable-proxy --nginx-site <exact existing TLS site> --tenant giraffe
node deploy/auth-xiongan/install.mjs check --tenant giraffe
```

`enable-proxy` takes an **exact existing** TLS site; it does not create one.

## 7. Report back

Per tenant:

1. tenant id, origin, and the profile actually configured;
2. `dig +short A <origin host>`;
3. certificate subject, issuer and `notAfter`;
4. the release config's sha256, as `config` printed it;
5. `install.mjs check --tenant <tenant>` output;
6. the bindings file content, verbatim — it is public, so quote it rather than
   describing it;
7. confirmation that activation was performed by a person at a trusted
   terminal, and that no secret appeared in any command line or log;
8. the served build sha256 at each origin.

Also report once: that neither origin serves anything but the wallet, and that
no wildcard DNS record or wildcard certificate was created for either.
