# Reusable same-origin authentication installation

This is the server component of the V2/V3 DApp kit. It includes its nine pinned
production dependencies and needs no `npm install` on the deployment host. Use
an installed, root-owned Node 22.18+ or Node 24 executable, Linux/systemd with
LoadCredential support, and the existing TLS nginx wallet vhost. OpenSSL 3 is
needed only for an independently configured hardware CA integration. This is a
functional-testing Beta, not security-audit or physical-device acceptance.

## 1. Verify and prepare (deployment operator)

Obtain the archive SHA-256 and exact source tree from the approved delivery
channel. Check that external digest before unpacking; a checksum included inside
an untrusted archive does not establish its publisher. The delivered manifest
and `scripts/package/verify-auth.mjs --manifest MANIFEST` also validate the full
archive before extracting it into a temporary directory. After verified extraction,
run `node scripts/package/verify-auth.mjs --directory PACKAGE_DIRECTORY`.

Inspect existing services/listeners and the actual TLS site first. Keep the
wallet's current scheme, host and port: moving an origin strands browser journals.
Do not change SSH, TLS certificates, bridges, firewalls or unrelated services.
Resolve symlinks in the Node executable and nginx site paths before using them.

Prepare a private JSON file containing the independently confirmed public account
bindings: an array of objects with `username` and `wallets`; each wallet has
`account` (public address) and `chainId` (decimal string). It must contain no
password, key, OTP seed or CA claim. Keep actual deployment bindings out of Git.
Run as root from the verified package:

```
node deploy/auth-xiongan/install.mjs prepare \
  --package PACKAGE_DIRECTORY --node ABSOLUTE_NODE_EXECUTABLE \
  --origin EXISTING_HTTPS_ORIGIN --tenant TENANT \
  --bindings PRIVATE_BINDINGS_JSON --reserved-ports HOST_RESERVED_PORT_LIST_OR_none
```

The historical script directory name does not select a tenant. The command
accepts any validated tenant and creates `/opt/8415wallet-auth-TENANT`,
`/etc/8415wallet-auth-TENANT` and `/var/lib/8415wallet-auth-TENANT`. It verifies and
copies an immutable release, installs an inactive hardened systemd unit, writes
public configuration root:root 0600 under 0700 directories, and configures a
Unix socket below a root-owned per-tenant runtime directory. No backend TCP
listener is opened. The supplied host reservations remain configuration data;
the existing public UI listener is unchanged. The socket is connectable by the
existing nginx worker, while its parent directory prevents non-root users from
replacing it. Socket permissions grant no account authentication or data access. It never generates
credentials, starts/enables the service, edits nginx or changes the public UI.
An existing installation/configuration/state is refused; use `check` to inspect
it. Do not delete locks or credential files to bypass a refusal.

## 2. First credential initialization (user personally)

The user must personally run the following in a trusted terminal, with terminal
recording disabled. No assistant or deployment worker may type, capture, generate
or submit real credentials on the user's behalf:

```
cd /opt/8415wallet-auth-TENANT/current
node server/operator-activate.mjs --activate --tenant TENANT
```

The tool verifies the public configuration and protected paths, asks for explicit
confirmation, and creates an independent random store key locally without showing
it. It can optionally provision a hidden, twice-entered password for an existing
account. No secret is accepted as an argument or environment variable, and no
private wallet key, seed phrase or hardware PIN is requested. Existing keys,
credential state or unfinished activation locks are refused. It does not start
a service. Do not put secret backups in the delivery archive, Git, Drive or chat;
use the user's independently approved secret-storage process.

## 3. Enable the existing same-origin route (deployment operator)

```
node deploy/auth-xiongan/install.mjs check --tenant TENANT
node deploy/auth-xiongan/install.mjs enable-proxy --tenant TENANT \
  --nginx-site EXACT_EXISTING_TLS_SITE_FILE
```

The command verifies the immutable runtime/configuration, starts only the new
unit, verifies protected socket ownership and matching `/auth/capabilities`, inserts one include in
exactly one existing matching TLS server, validates nginx, reloads nginx and
enables the auth unit on reboot. It refuses ambiguous vhosts, existing auth routes (including inspected absolute-path includes), changed files and absent credentials. Include inspection supports bounded absolute paths and basename wildcards; variables, relative paths, cycles, insecure ownership or unsupported forms require operator review. Ordinary failure restores the original site
and disables/stops only this auth unit. An interrupted or failed rollback retains the operation lock and requires operator review. Never work around a refusal by replacing
the whole site. Existing public resources and TLS listeners are preserved.

Check the public `/auth/capabilities` URL using `X-Wallet-Tenant: TENANT`, normal
TLS verification and the exact origin. Expect HTTP 200 JSON with schema
`8415wallet-auth/1` and matching origin/tenant. This reports protocol support,
not that an account already has a password, TOTP or CA binding. The user then
signs only a login challenge or uses their password, starts TOTP setup, scans the
locally rendered QR in Google Authenticator/FreeOTP, confirms a code and privately
saves the eight recovery codes. No blockchain transaction is needed. Password,
TOTP, registered-wallet and CA support are separate from actual device acceptance.

## Rollback and updates

```
node deploy/auth-xiongan/install.mjs rollback --tenant TENANT
```

Rollback restores only the exact saved nginx site when it still matches the
installer's after-hash, reloads nginx, and disables/stops the tenant auth unit.
It preserves public DApp files, origin, binding configuration, key and encrypted
state. If anyone changed the site afterward, automatic rollback refuses and
requires a targeted operator review. Never restore old credential ciphertext:
that can revive consumed TOTP/recovery values. The prepare command refuses
overwriting active installations. For a trusted reviewed next package, use
`upgrade --package NEXT_PACKAGE_DIRECTORY --tenant TENANT`; it verifies the
complete new release and equal credential-store format, briefly stops only this
unit, switches its immutable code and checks capabilities after restart. On
failure it returns to the prior code without restoring credential data.
`rollback-code --tenant TENANT` selects the prior compatible code release.
Neither command changes bindings, passwords, key, state, origin, proxy or Node
executable. All active sessions expire when the service restarts. Do not use an
upgrade to smuggle a new state format or new permission requirement. DApp UI version rollback
is independent of credential-store rollback.

The older `operator-init.mjs` and fixed `service-entry.mjs` remain legacy source
for compatibility; the reusable installer uses tenant-scoped `runtime-entry.mjs`
and the complete first-initialization tool above. No preparation or package test
is production activation, genuine-wallet, CA-device or independent-audit evidence.

## Review scope and evidence

The reusable installer uses a protected Unix socket to prevent an unprivileged
local process from occupying a freed loopback port during service restart and
imitating a public capabilities response. It checks executable ownership and
ancestors before execution, pins the verified Node binary and complete package
manifest across copying/upgrades, and checks nginx ancestry before writes.
These changes concern deployment transport/provisioning only; they preserve
authentication/session semantics and do not change ERC-8415 or transaction logic.
They are internal engineering review findings, not an independent security audit.

Reproduce the complete exact-source matrix from a clean isolated checkout with
`NODE22=/verified/node22 NODE24=/verified/node24 bash scripts/ci/run-matrix.sh --confirm-isolated-ci`.
Each leg runs every repository workflow shell stage and records command status,
exit code, source commit/tree and logs. Any failed or environment-blocked stage
makes the matrix nonzero. Both Chromium and Unix-domain socket support are
required for full acceptance; a TCP-only fixture does not substitute for the
installed Unix-socket journey. No production credentials or service are used by
these tests.

## Registration and recovery mail: explicit reviewed SMTP enablement

New packages include the registration/recovery server modules and six-language UI.
Mail defaults to `disabled`: existing account login remains available, while
email-dependent registration and recovery fail closed. The installer does not
provision a mailbox, read SMTP credentials, apply network permissions or send mail.
The configured product sender is `noreply@8415wallet.com` through
`mail.8415wallet.com`; arbitrary host/sender/TLS overrides are refused.

To prepare SMTP support, add `--mail-transport smtp --smtp-port APPROVED_PORT
--smtp-addresses APPROVED_IPS` to `prepare`. `APPROVED_IPS` is a comma-separated
operator-reviewed list of exact mail endpoint IPv4/IPv6 addresses, not a subnet,
DNS name or URL. No production IP/port is assigned in this kit. TLS remains
implicit TLS >=1.2 with normal certificate/hostname validation and fixed SNI;
the installed sender resolves only those pins, with no arbitrary DNS fallback.
Port 443 is refused for this sender. The application uses only the selected port;
systemd IP filtering is address-level, so the operator must consider that scope
when approving the drop-in.

Preparation writes `smtp-override.review.conf` under the private tenant config
directory, outside any systemd drop-in directory. The active base unit remains
AF_UNIX-only with IPAddressDeny=any. The review file preserves that deny rule,
allows only the selected /32 or /128 endpoints, and adds AF_INET/AF_INET6 plus
fixed LoadCredential references to the tenant's `smtp-username` and
`smtp-password` files. It contains no credential value.

The authorized operator must separately approve the precise network and
credential-access expansion before applying the reviewed file as the tenant
unit's mail drop-in. The user handles real credential entry through the approved
secure process. Credential files must be root:root, regular single-link files,
mode 0600 below the private root-owned tenant config directory. Username is
1–256 UTF-8 bytes; password is 1–1024 bytes, with no NUL/CR/LF. Do not supply
credentials as command arguments, shell history, repository files or chat text.
Do not add ambient WALLET_AUTH_SMTP_* environment variables to the installed
unit: runtime-entry refuses them and reads only protected systemd credentials.
Missing, partial or invalid selected credentials refuse startup without logging
values. The deployment operator validates the generated drop-in, reloads the
unit definition and starts it only after the required approval. This guide and
review file are not permission for the assistant to perform those actions.

Endpoint changes do not require code edits. Stop the tenant unit, then use the
current verified installer's nonsecret configuration command:

```
node deploy/auth-xiongan/install.mjs configure-mail --tenant TENANT \
  --mail-transport smtp --smtp-port APPROVED_PORT --smtp-addresses APPROVED_IPS
```

It verifies the stopped unit, immutable package and receipt; updates public
mail config plus its receipt; and emits a fresh inert review file. It does not
apply a drop-in, reload systemd, start the unit, read credentials or change the
browser origin. A separate mail-transition lock prevents runtime-entry starting
through a partial update; an uncertain repair retains both locks for inspection.
The operator reviews only the changed destinations/port and applies the updated
mail drop-in under the approved security process. Pins that no longer reach the
approved endpoint fail closed until this update. Do not weaken TLS or open broad
DNS/network access as a fallback. Disabling uses the same command with
`--mail-transport disabled`; the generated disabled review restores AF_UNIX-only
access and removes SMTP credential references when the operator applies it.

## Authentication state semantics and safe code rollback

Credential ciphertext still uses envelope/store format 1. New packages separately
record `authStateSemantics: 8415wallet-auth-state/2` for registration, enabled login
methods and reserved recovery factors. Absence of that marker denotes legacy
semantics 1. The installer permits the reviewed forward 1→2 transition and
same-generation code rollback, but refuses 2→1 even if ciphertext can decrypt.
Old code could discard newer fields or bypass recovery requirements; compatible
encryption alone does not make such a rollback safe.

Before a forward upgrade, follow the user's approved offline backup and recovery
process. A backup is for coordinated disaster recovery, never automatic reversal
of consumed OTP/recovery counters. Once a generation-2 candidate start is attempted,
an uncertain failure does not restart legacy code: it stops the candidate when
possible and retains the new release and operation lock with an explicit recovery
error. The operator must inspect and fix/advance generation-2 code, preserving
current credentials and counters. Never delete state, rekey, restore stale
ciphertext or remove retained locks merely to pass an installer check.
