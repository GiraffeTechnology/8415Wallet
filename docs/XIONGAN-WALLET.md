# Xiongan Wallet development candidate

User-facing name: **Xiongan Wallet**. Built on 8415Wallet, with
two distinct custody boundaries. Status: **NOT_INDEPENDENTLY_AUDITED**.
This source is not release acceptance and is not a recommendation to fund it.

## Supported boundaries

| Surface | Networks | Assets and actions | Custody / decision |
| --- | --- | --- | --- |
| External-account companion | Ethereum (1), Base (8453), Sepolia (11155111), Base Sepolia (84532) | ETH balance/receive address; ETH transfer to EOA recipients; ERC-721 and ERC-1155 safe transfers by explicit contract/token ID | Existing external EOA; owner reviews and personally confirms signing/submission in the genuine wallet |
| Existing ERC-8415 controls | Sepolia and Hoodi only | Original standalone/linked responsibilities, optional payments and recovery | Existing pinned controlled-account implementation; original gates unchanged |
| Agent request inbox | Same chain/account as the selected surface | Bounded public JSON requests, immutable exact-operation review, one owner-approved wallet prompt | No keys, signatures, allowances, autonomous broadcasting or standing/session permission |

ETH must never be sent to an 8415 controlled-account contract as a general
wallet deposit. The ordinary-asset receive address is exclusively the verified
external EOA on the displayed chain. Account/chain/disconnect events immediately
invalidate it and any review, even when the account later switches back.

Limitations are explicit: no ERC-20, swap, bridge, NFT marketplace, automatic NFT
indexing, smart-account/EIP-7702 signer, native ETH contract-recipient transfer,
ENS resolution, token approvals or delegated session key. NFTs require a supplied
contract and ID; their actual interfaces/ownership/balance are checked. Standard
NFT custody is separate from ERC-8415 confirmed-holder and legal-title semantics.

## Local setup

Use Node 22.18+ and the repository lockfile:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run wallet:browser:build
npm run wallet:browser:serve
```

The server listens only on loopback (default `http://127.0.0.1:8415`). It serves
static public assets and has no signer, RPC proxy, credential, upload or agent
write endpoint. Connect a genuine wallet manually on one supported chain. The
external EOA panel does not require an ERC-8415 deployment manifest. The original
controls panel still requires its exact pinned public testnet manifest.

Select the real wallet and network yourself; initialize/import any wallet key
only in that wallet's secure interface. Never enter a mnemonic/private key in
this app, a request JSON file, chat, an environment variable or the repository.
Do not erase browser storage while a journal has an unresolved outcome.

## Agent requests and personal authorization

The agent may construct a public JSON file and help inspect it. Loading a file or
pressing Review never signs or sends. A claimed agent name is a display claim,
not authentication. The owner checks the exact chain, account, recipient, amount,
asset, nonce, expiry and request digest, checks the acknowledgement, and presses
Continue in my wallet. The genuine wallet retains the final signing/submission
decision and shows gas costs. General future authorization is not a concrete
transfer authorization; every operation requires this new review.

External-account request schema (replace every placeholder; integers are decimal
strings, expiresAt is Unix seconds no more than 15 minutes from current chain time):

```json
{
  "schema": "xiongan-asset-request/1",
  "requestId": "xiongan-unique-request-id",
  "agent": "Xiongan",
  "chainId": "8453",
  "actor": "REPLACE_WITH_CONNECTED_EOA",
  "expiresAt": "REPLACE_WITH_SHORT_EXPIRY",
  "action": {
    "kind": "native-transfer",
    "recipient": "REPLACE_WITH_EXACT_EOA_RECIPIENT",
    "valueWei": "REPLACE_WITH_EXACT_INTEGER_WEI"
  }
}
```

Other exact action shapes:

- ERC-721: `kind`, `recipient`, `contract`, `tokenId`, with kind `erc721-transfer`.
- ERC-1155: the same plus positive integer-string `amount`, with kind `erc1155-transfer`.

Unknown fields, arbitrary calldata, raw signatures, approvals, unsupported chains,
wrong accounts, unsupported interfaces and expired requests are refused. The
ordinary asset request is not a general programmable execution endpoint.

The original controlled-account request schema is `xiongan-agent-request/1`.
It adds the exact `controller` address and uses `operation`, with one of
`create-account`, `deposit` (tokenId), `standalone-withdraw` (tokenId,
destination), `complete` or `return-hop` (sequenceId, legId, expectedRevision).
It binds the token runtime pin from the already loaded deployment. Linked
forwarding still uses the original separate informed-consent workflow, never a
signature imported by an agent.

## Execution, receipt and recovery

Preparation checks chain/account identity, EOA custody, current nonce, short expiry,
asset ownership, NFT interfaces/runtime code, canonical read block and gas
simulation. Submission repeats preparation and requires the entire immutable
review to match, not just its displayed digest. A shared page lock prevents both
UI surfaces from prompting concurrently. Each account/chain journal uses strict
IndexedDB durability and compare-and-swap before a single wallet send.

Manual and agent-JSON address inputs validate ERC-55 mixed-case checksums before
normalization, including ETH/NFT recipients, NFT contracts and agent withdrawal
destinations. Invalid checksums are refused without a wallet send. All-lowercase
and all-uppercase address bodies remain accepted without checksum protection;
format and zero-address rejection remain in place. RPC addresses remain
byte-oriented and do not gain a checksum-casing requirement. A valid checksum
does not verify who controls the address or make a transfer safe.

A provably unsent failure before the send boundary may clear only that reserved
intent. Once the provider send is invoked, rejection, timeout, malformed response
or persistence failure remains uncertain; no automatic retry or clearing occurs.

- Submitted: reconcile the exact canonical transaction/receipt and expected NFT
  transfer event, including block/transaction metadata. A hash alone is not success.
- Unknown outcome: check the original wallet activity. Recover only an exact
  matching mined hash, including a same-intent speed-up. An absent hash or unchanged
  nonce does not prove cancellation.
- Different transaction consumed the nonce: explicitly prove its canonical receipt,
  actor/nonce and sufficient confirmations, then acknowledge it as
  `superseded-not-successful`. It never reports the original operation successful.
- Reorg: preserve the journal. Terminal verification checks canonicality again
  after later reads; a prior confirmation is not trusted across reloads.

Two confirmations are an operational display threshold, not Ethereum economic
finality, Base L1 finality, ERC-8415 temporal finality or legal title. A user may
also change nonce state in another wallet/tab; those changes must be reconciled,
not assumed to authorize a replacement. No app can prevent the owner using a
separate wallet interface.

## Acceptance still required

- Exact-version independent external security review, covering the new EOA layer
  as well as existing controls and dependency/tooling boundaries.
- Genuine wallet UI sends, cancellation/speed-up, restart/reorg recovery and
  account/chain transitions on the intended networks, with user-owned signing.
- Physical mobile/hardware-device journeys. Responsive markup or simulated DOM
  events do not establish device acceptance.
- Final chosen deployment origin, HTTPS configuration and delivery package.

The repository's historical 126 Sepolia receipts belong to their named older
candidate and do not validate this new layer. AI-assisted source review, Node/EVM
regressions and a synthetic provider must not be called an independent audit or
real-asset acceptance. No mainnet or testnet transaction was submitted while
implementing this candidate. Nothing here grants standing signing authority.
