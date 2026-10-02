# On-chain test brief — 8415Wallet on Sepolia

You are running the first real-network test of this repository. Everything in
it has so far been verified against an in-memory contract model, a fake
JSON-RPC node, and a local hardhat EVM. **No byte of it has ever touched a real
network.** Your job is to find out what breaks.

Repository: `GiraffeTechnology/8415Wallet`, branch `main`.
Local sandbox baseline, for comparison: `npm run verify` → 492 tests / 95
suites pass, 14 contract tests pass, typecheck clean.

---

## Ground rules

1. **The library must never hold a private key.** `src/` may not gain a
   raw-key signer. Your signing key lives in a script under `scripts/`, uses
   `ethers` (already a devDependency), and satisfies the existing
   `TransactionSigner` type from `src/sdk/transactions.ts`. A test in
   `tests/signer.test.ts` asserts the shipped signer never asks a provider for
   `eth_sign`, `personal_sign` or `eth_signTransaction`; keep that true.
2. **Do not edit `src/` to make a test pass without saying so.** If a read path
   is wrong, report it as a finding with the evidence, and put any proposed fix
   in a separate section of your report as a diff. Results and fixes must be
   distinguishable.
3. **Report what happened, not whether it went well.** A failure with an exact
   error is worth more than a pass. Do not retry a failure until it passes and
   report only the pass.
4. Never commit a private key, mnemonic, RPC URL with an embedded API key, or
   `.env` file.

---

## Setup

- Network: **Sepolia** (`chainId` 11155111).
- Node: 22.18+ (the repo runs TypeScript from source; no build step).
- `npm ci`, then `npx hardhat compile`.
- Add a Sepolia network to `hardhat.config.cjs` reading the RPC URL and key
  from environment variables.
- You need **three funded accounts**: `REGISTRAR`, `SELLER`, `BUYER`. Report
  each address and its starting balance.

## Deployment

Contracts are at `contracts/reference/RegisterProjectionReference.sol` (the
ERC's own reference implementation, vendored) and
`contracts/escrow/ProjectionEscrow.sol`.

`RegisterProjectionReference` constructor:

| arg | type | constraint |
|---|---|---|
| `remoteRegisterId_` | `bytes32` | nonzero |
| `registrar_` | `address` | nonzero |
| `validators_` | `address[]` | **sorted strictly ascending**, all nonzero |
| `threshold_` | `uint8` | `1 <= threshold <= validators.length` |

Use 3 validator keys with `threshold = 2`. `ProjectionEscrow` takes no
constructor arguments.

Then `mint(SELLER, tokenId, recordCommitment, registryReference, effectiveAt)`
— callable only by the deployer — and
`grantSettlementAuthority(tokenId, REGISTRAR)`.

Constraints that will bite: `MAX_EFFECTIVE_AHEAD = 30 days` and
`MAX_SETTLEMENT_PERIOD = 30 days`, both measured from `block.timestamp`.
`effectiveAt` must be **strictly increasing** across a token's entries.

A working proof builder already exists in `test-evm/escrow.cjs` (`proof()` and
`admit()`). Lift it. It binds to `DOMAIN_SEPARATOR()`, which is derived from
the chain id and the deployed address, so it will produce Sepolia-valid proofs
once pointed at the live deployment.

---

## Test matrix

Run every item even if an earlier one fails. Record the listed parameters for
each.

### A — Deployment
- **A1** Deploy the projection. Record address, tx hash, block, gas used.
- **A2** Deploy the escrow. Same.
- **A3** Mint and grant authority. Record `tokenId`, the `effectiveAt` used,
  tx hashes, and the `RegisterInitialized` event fields as emitted.

### B — Read path (the parts that could be silently wrong)
- **B1** `supportsInterface` for `0x6309e170` and `0xf4a7d71b`. Both must be
  true. Also call it with a garbage id and confirm false.
- **B2** **Struct return layout.** Call `currentEntry(tokenId)` through
  `RpcErc8415Reader` and report **all seven fields**
  (`recordCommitment`, `previousCommitment`, `registryReference`, `holder`,
  `version`, `effectiveAt`, `supersededAt`). Compare field by field against the
  values you minted. A shifted field here would be invisible to every existing
  test, because the fake node was written from the same understanding as the
  decoder.
- **B3** **Revert shape against custom errors.** Call `entryAsOf(tokenId, t)`
  and `holderAsOf(tokenId, t)` for a `t` **before the first entry**. Both must
  surface as `ContractRevertError`, not as a transport error. **Paste the raw
  JSON-RPC error object** the node returned (code, message, data). The
  reference contract uses 17 custom errors and zero `require` strings.
- **B4** `isFinalAsOf(tokenId, t)` for the same `t` must return `false` and
  must **not** revert.
- **B5** `entryCount`, `registerId`, `verificationProfile`, `settlementPeriod`,
  `isSettlementAuthority(tokenId, REGISTRAR)` and for a non-authority. Report
  each value.
- **B6** **`eth_getLogs` over an unbounded range.** `src/adapters/rpc/rpcReader.ts`
  hardcodes `fromBlock: 'earliest', toBlock: 'latest'`. **I expect this to fail
  on most Sepolia providers**, which cap the block range or the result count.
  Report the exact error, the provider you used, and the actual limit it
  enforces. If it succeeds, say which provider allowed it.
- **B7** **Log topic slots.** After a real settlement exists (do this again
  after D4), read the settlement history through the wallet and compare it
  against the raw logs in the transaction receipts. **This is the one that
  fails silently**: a wrong topic slot returns an empty history rather than an
  error. Report both the decoded history and the raw receipt logs.

### C — The reference client against a live deployment
- **C1** `npm run wallet -- --rpc <url> --contract <addr> --chain-id 11155111
  --token <id>`. Paste the **complete** output.
- **C2** Same with `--account <SELLER>` and no `--token`, exercising discovery.
  Paste the output, including whatever it says about its own limits.
- **C3** Point `--rpc` at a dead endpoint. It must report a transport failure,
  **not** "the contract does not advertise `0x6309e170`". Paste the output.

### D — Clearing, end to end
- **D1** `SELLER` approves the escrow, then `open(localId, projection, tokenId,
  BUYER, price, admissionDeadline, maxEffectiveAt)`. Record the `tradeKey` from
  the `TradeOpened` event, the value returned by `keyFor(SELLER, localId)`, and
  the value the SDK's `tradeKey(SELLER, localId)` computes off chain. **All
  three must be identical.**
- **D2** `BUYER` calls `fund(tradeKey)` with the exact price. Record
  `entryCountAtFunding` from the event.
- **D3** `observe(tradeKey)` before any admission. Record all seven returned
  values. Expect `confirmed = false`, `positionHolder = escrow address`,
  `confirmedHolder = SELLER`.
- **D4** `REGISTRAR` calls `beginSettlement` naming `BUYER` as
  `expectedHolder`, then `finalizeSettlement` with a real proof. Record both tx
  hashes, gas, and the admitted entry's `version` and `effectiveAt`.
- **D5** **The headline property.** Call
  `isFinalAsOf(tokenId, admittedEntry.effectiveAt)` immediately after D4. **It
  must return `false`** — an instant is final only once a *later* entry exists,
  so the admitting entry's own effective time is never final when it lands.
  Record the value.
- **D6** Anyone (use a fourth account, not a party) calls `release(tradeKey)`.
  Record the tx hash, gas, `ownerOf(tokenId)` after, and the ETH balance change
  for `SELLER` and `BUYER`.
- **D7** A **second** trade on a second token: fund it, let
  `admissionDeadline` pass with nothing admitted, then `refund(tradeKey)`.
  Record the tx hash, `ownerOf` after, and both balance changes. Note the real
  wall-clock wait you had to do.
- **D8** Try `refund` on the D1–D6 trade after its deadline. It must revert
  `AlreadyConfirmed`. Record the error.

### E — The signer
- **E1** Build a `beginSettlement` request with `buildBeginSettlement` from
  `src/sdk/transactions.ts`, hand it to your raw-key signer, send it, and wait
  for the receipt. Record the request's `to`, `data`, `value`, `chainId`, the
  resulting tx hash, and the receipt status.
- **E2** Take a valid request, overwrite its `chainId` to `1n`, and pass it to
  an `Eip1193Signer` wrapping a Sepolia provider. It must throw
  `ChainMismatchError` and **must not send anything**. Confirm no transaction
  appeared.
- **E3** Report what gas your script had to supply that the library did not —
  the signer deliberately adds no estimate and rewrites no field.

### F — Convert the two existing testnet wallets
Convert the two testnet wallets we already have so they read ERC-8415.

**First, tell me what they actually are**, because it changes the work:
- if they are **two deployed wallet applications / front-ends**, report their
  repository or URL, stack, and how they currently read ERC-721; then add
  ERC-8415 reading to each via this repository's `WalletSession` — at minimum
  the asset view (position and confirmed holder, never merged), the finality
  state, and any open gap;
- if they are **two EOAs**, report their addresses and set them up as
  participants: one holding the token and confirmed by the register, one as a
  counterparty, and show `npm run wallet -- --account <addr>` resolving each.

Either way, report a before/after of what each wallet displays for the same
token, and confirm the position and the confirmed holder are shown as two
separate facts and never collapsed into one "owner".

---

## What to report back

Return one Markdown document with these sections. Include the parameters
literally — I will diff them against the sandbox run.

### 1. Environment
```
chainId, rpc provider name, node client+version (web3_clientVersion),
REGISTRAR / SELLER / BUYER / THIRD addresses, starting balances,
commit sha tested, node version
```

### 2. Deployed addresses
```
projection:  address, deploy tx, block, gas
escrow:      address, deploy tx, block, gas
registerId, verificationProfile, settlementPeriod
validators[3] (addresses), threshold
tokenId, initial effectiveAt, initial recordCommitment
```

### 3. Result table
One row per test id (A1…F), each with: `pass | fail | not run`, the recorded
parameters, and for failures the exact error text.

### 4. Findings
For each thing that did not behave as the repository claims: what you called,
what you expected, what you got, the raw error, and whether it fails loudly or
silently. **Rank by whether a user would notice.**

### 5. Proposed fixes
Diffs, separate from the results. Do not apply them to `src/` in the same
commit as your test scripts.

### 6. Gas and cost
Gas used per operation (deploy projection, deploy escrow, mint,
beginSettlement, finalizeSettlement, open, fund, release, refund) and total
Sepolia ETH spent.

### 7. Artifacts
The scripts you wrote, under `scripts/`, plus the full raw output of C1, C2 and
C3.

---

## Known predictions

State explicitly whether each held:

1. **B6 will fail.** `fromBlock: 'earliest'` is unbounded and most providers
   reject it. If so, the fix is a windowed scan with a configurable range, and
   the wallet must say when a window was truncated rather than returning a
   short history silently.
2. **B7 is the dangerous one.** A wrong log topic slot returns an empty
   settlement history and no error at all.
3. **D5 must be `false`.** If it returns `true`, either the reference
   implementation or my reading of the finality rule is wrong, and the clearing
   contract's release condition needs rethinking. This one matters more than
   the rest combined.
