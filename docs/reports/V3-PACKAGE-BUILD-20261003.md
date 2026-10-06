# Historical V3 package-build record — provenance correction

The previous revision of this document mixed an older build report with later
Beta labels. Its claimed source `18499967348a0f8bcc5a1a42b5bd4b9e6e1ac38e`, tree
`ea180768fa69dfefdc36c22cf53ef2fa1e97e00b`, package filename and hash must not be
used to identify the current Beta. The verified main source at the later
reconciliation checkpoint was `18499967348a6db572e699bc37700d98376755dc`.

The old report recorded 812 Node cases, 59 EVM cases, nine SDK installation
checks and a synthetic-provider browser journey. These are historical reported
results, not fresh verification of the current tree. The prior revisions remain
in Git history; no old count, hash or deployment claim is transferred to a new
artifact by renaming it.

Current DApp builds generate `RELEASE.json`, file checksums and external
artifact manifests from the exact source, recording the V2/V3 PRD scope
separately from SDK version numbers. Use [the Beta delivery instructions](../BETA-DAPP-DELIVERY.md)
and the manifest shipped with the actual archive.

No current online status is claimed by this historical document, and a URL
recorded here is not a deployment instruction. Take the serving address from the
deployment configuration.
