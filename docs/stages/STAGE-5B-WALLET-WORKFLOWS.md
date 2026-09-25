# Stage 5B — additive wallet workflows

Historical source freeze was UNTESTED. After all stages completed, unified local
validation and review repairs ran; see the dated V3 validation report. This draft
remains unmerged, and genuine UI/public-testnet acceptance is still required.

## Implemented source

- Exact recipient consent review, committed text/native-payment terms and all
  active upstream conditions. Review handles are session-local, single-use;
  revision, expiry, recipient nonce/account and inherited scope are re-read.
- Account, control and separate payment operations with an explicit send hook.
  A public transaction template is committed before the wallet prompt. A lost
  hash can be reconciled from wallet activity against the exact chain, code,
  sender, destination, value, calldata hash and receipt event without re-sending.
- Revision-CAS journal, strict-durability IndexedDB and optional Node public file
  store. Neither stores consent signatures, calldata, endpoints or keys.
- Genuine EIP-1193 browser integration; no synthetic provider injection. A
  standalone manifest may omit controller/payment entirely. Original wallet
  projection/history/authority/temporal/freshness views remain available.
- Browser linked controls, all fixed actions, native per-leg funding/allocation/
  payout, explicit consent acknowledgement and terminal-receipt acknowledgement.
- Independent owner/holder, temporal finality, contest and freshness presentation
  even where entry-to-occurrence evidence is absent. Combined payment reads bind
  the responsibility snapshot's canonical block.
- Eighteen workflow/receipt/recovery and three browser transaction-event fixture
  cases passed. Fixtures do not establish genuine browser or power-loss recovery.

## Build/use contract

After all development: `npm run wallet:browser:build` emits the browser entry.
Serve only `web/` and `dist/browser/` from a controlled local HTTPS/localhost
origin. Never serve a repository, environment file or custody directory.
The page accepts a public JSON deployment manifest with exact fields:
`schema=8415-controls-testnet/1`, decimal `chainId`, `token`, `controller`,
`payment`. Pins contain only `address` and `runtimeCodeHash`; controller and
payment may be null. Current reference UI permits Hoodi/Sepolia only.
No deployment is inferred from a manifest, no account is unlocked by the app.

Consent input contains exactly `consent` and `documents`. Big integers are
decimal strings. Every active inherited leg needs its ID, exact terms and exact
return-condition text. Text commits as UTF-8 Keccak-256; native-payment-v1 terms
commit the precise amount and adapter/domain. Signatures never appear in files,
DOM output, console or the public journal. They are held in page memory only.

## Explicit remaining gates and limitations

- Local source compilation and unified regression passed; UI and testnet remain open.
- UI styling currently uses a clearly identified neutral fallback. Supplied
  Giraffe VI/font assets must be located and integrated before visual acceptance;
  this is not a claim of approved branding or completed desktop/mobile evidence.
- A wallet prompt can outlive a timeout. Unknown submissions remain blocked;
  the user supplies the public transaction hash from wallet activity, not a key.
  If no transaction exists, do not invent non-execution from a missing receipt.
- A different confirmed transaction at the same actor/chain/nonce can explicitly
  resolve uncertainty at a configured confirmation depth; it never means the
  original operation succeeded. No automatic resend follows.
- Node file journals require directory fsync. Unsupported Windows/filesystem
  hosts refuse before sends. Browser journals require strict IndexedDB durability
  and refuse legacy localStorage records instead of silently discarding them.
- CAS protects cooperating app instances, not a compromised browser origin or
  malicious OS user. File-store parent permissions remain an operator boundary;
  public journals cannot authorize transfers. A stale lock fails closed.
- Page reload discards consent signatures. Recipient approval must be repeated
  against a new review if the seller did not receive the in-memory acceptance.
- Native funding is a separate transaction after forwarding, not atomic DvP.
- Audit the real enforcement contracts and proxy/profile trust assumptions
  independently before any release. Partial documentation is not acceptance.
