# Legacy single-trade clearing in the Beta DApp

The V2 and V3 DApps expose the existing `ProjectionEscrow` separately from
linked responsibility controls. This preserves the standalone clearing journey.
The surface supports read, exact ERC-721 token approval, open, fund, release,
refund and abandon. Every write is a distinct owner-reviewed wallet request.
There is no arbitrary-calldata input or automatic transaction retry.

## Deployment configuration

The deployment operator supplies a verified public JSON file with exactly these
fields. Runtime code hashes must be the Keccak-256 of the deployed runtime bytes,
not creation bytecode. Addresses and immutable identifiers must be independently
checked against the deployment record; loading a file does not make its source
trustworthy.

```json
{
  "schema": "8415-legacy-clearing/1",
  "chainId": "11155111",
  "escrow": { "address": "<ProjectionEscrow address>", "runtimeCodeHash": "<bytes32 runtime hash>" },
  "projection": { "address": "<ERC-8415 ERC-721 address>", "runtimeCodeHash": "<bytes32 runtime hash>" },
  "registerId": "<bytes32 register identifier>",
  "verificationProfile": "<bytes32 verification profile>"
}
```

This is a template; replace placeholders with verified values. Use `null` for
`verificationProfile` only if the projection does not advertise settlement
support. The DApp discovers ERC-165, ERC-721 and projection conformance, probes the
invalid interface, and checks settlement discovery and pinned identities.
Sepolia (`11155111`), Hoodi (`560048`) and the local EVM (`31337`) are supported.
Mainnet is refused. The shared release configuration and configured origin/path
must be valid before any clearing operation can begin.

## Owner journey

1. Load the verified clearing deployment file and connect the genuine wallet.
   Chain, selected account and both deployed runtime hashes are checked.
2. As seller, enter a unique nonzero local ID, token ID, buyer, exact price in
   integer wei, admission deadline and maximum accepted effective time in Unix
   seconds. Review the single-token approval if needed, acknowledge its exact
   scope, and explicitly ask the wallet to send it. No approval-for-all is made.
3. Verify the approval receipt and acknowledge it. Then review and send `open`
   separately. The derived key namespaces the local ID by seller address.
4. Share the public trade key through the parties' own agreed channel. As buyer,
   read the trade, review the exact price and terms, and send `fund` explicitly.
   The contract takes its entry-count baseline when payment is funded.
5. Anyone may review `release` once the contract's admitted-record condition
   holds, or `refund` strictly after the deadline while it does not hold. The
   contract re-reads that condition atomically. A late qualifying admission
   prevents refund. These choices execute the existing agreed terms; the wallet
   does not select a remedy or alter registration history.
6. Before payment, only the seller may review and send `abandon`.

A read or review sends no transaction. Any edited input, changed account, changed
chain, disconnect or dismissed review invalidates the displayed authorization.
The real wallet still owns signing, fee choice and submission.

## Semantics

The escrow's application state is separate from ERC gap state. `ownerOf` and
the register-confirmed holder are separate fields. Release accepts an admitted
but provisional record; it does not establish temporal finality, legal identity
or linked responsibility completion. A gap closure or cancellation alone is
neither release nor refund authorization. The observation may return zero when
an underlying read is unavailable; the wallet discloses this and never replaces
the confirmed holder with the token owner. Contract reads are snapshots. The
recommended dependent-action shape is the atomic read used by this escrow.

## Recovery and durability

A strict-durability IndexedDB compare-and-swap reserves the public unsigned
intent before the provider send boundary. The journal is scoped by chain and
actor across escrow configurations; changing a deployment file cannot hide a
saved uncertain operation. Runtime pins, exact calldata, value, sender, nonce,
receipt block, canonical block hash and the relevant event are checked before a
successful receipt is accepted. Two confirmations are the default display
threshold, not economic or register finality.

A direct numeric EIP-1193 `4001` rejection can return to idle only after the exact
reservation is durably cleared. String/nested codes, timeouts, malformed replies
and failed persistence remain locked. A user must locate the matching transaction
hash in wallet activity to recover an uncertain send. A wallet cancellation or
different replacement can clear the old intent only after explicit proof that a
canonical transaction from the same actor consumed the saved nonce. This reports
`superseded-not-successful`; it never calls the original action successful and
never resends it. Same-intent speed-ups use matching-hash recovery instead.
Do not clear browser storage to bypass unresolved state.

## Local validation

- `node --test tests/legacy-clearing-session.test.ts tests/legacy-clearing-ui.test.ts`
  exercises six reviewed actions, ABI restrictions, pins, bounded approval,
  changed review/nonce, direct cancellation, ambiguous outcomes, strict CAS,
  canonical receipt/event bindings, reorgs, replacement recovery, release-profile
  refusal, changed connections, edited/dismissed reviews and duplicate clicks.
- `hardhat test test-evm/legacy-clearing-sdk.cjs` exercises the actual SDK against
  the reference projection and escrow contracts, including signed admission,
  release, refund, abandon and a same-nonce wallet cancellation.
- `npm run typecheck` covers the additive browser session and tests.

These are local development checks. Genuine-wallet desktop and physical-mobile
journeys, public-testnet execution and independent security review remain
separate acceptance work. No live deployment or public transaction is implied.
