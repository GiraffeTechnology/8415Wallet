# 8415wallet V3 candidate package

Status: **NOT_INDEPENDENTLY_AUDITED** · testnet use only · not a release.

This tarball ships the surface the V2 package deliberately leaves out: the
responsibility control kernel, its adapters and readers, the linked chain
views, and the browser entry. It is published as a candidate so the work can
be installed, integrated against and reviewed — not because it has passed the
gates a release needs.

## What you get

| Export | Contents |
| --- | --- |
| `8415wallet` | the standalone reading client and the linked chain views |
| `8415wallet/controls` | responsibility controls: consent review, client, readers, payments, detached history |
| `8415wallet/controls/node-store` | the Node operation journal store |
| `8415wallet/browser` | the browser entry the reference UI is built on |
| `8415wallet` (bin) | the command-line reference client |

Node 22.18 or newer. No runtime dependencies.

## What this package is not

- **Not audited.** No independent security review has been performed on the
  kernel, the adapters, the verifiers, the deployed contracts, recovery or the
  optional payment integration. Local suites are preparation, never an audit.
- **Not proven on a public chain.** The public journey runner has executed end
  to end only against a loopback rehearsal chain. W-20 — one deployed
  same-token multi-wallet journey — is not met.
- **Not a mandate to hold value.** Use test networks. The kernel is an
  uncommitted proposal generator; AGENTS.md forbids wiring it to signing or
  execution before authenticated atomic adapters, alternate-path protection
  and an independent audit are complete, and this package does not change that.

## What has been established

Locally, at the commit this package was built from: the full TypeScript suite,
the EVM suite against the real reference projection, a typecheck, a browser
emit, and a browser journey driving the served UI in a real Chromium at a
desktop and an emulated phone viewport. The exact figures live in
`docs/V3-REVIEW-AND-VALIDATION.md` and
`docs/stages/STAGE-5J-PUBLIC-PATH-AND-UI.md`, which travel in this tarball.

`AGENTS.md` ships here too, because the boundaries it states — what the wallet
may infer, what it must never collapse into one badge, and where remedy lives —
are part of what you are integrating against.
