# V3 agent path — public testnet test requirements

For the operator driving the deployed build with real wallets and testnet
assets.

This closes the first item the beta exists to collect: **public-chain execution
with a genuine wallet**, exercised through the agent path rather than by hand.

## 1. What this run is for, and what it is not for

The parser's logic is already proved locally. `tests/xiongan-agent.test.ts` and
the rest of the 814-case suite cover schema shapes, field validation, ERC-55
checksums, immutability and the absence of execution capability. **Do not spend
a funded run re-proving them.**

Test what only a live chain and a real wallet can show:

- expiry measured against **real chain time**, not a fixture clock;
- the review surviving, or correctly failing, across **real latency** between
  review and execute;
- a **genuine wallet confirmation dialog** being the only thing that signs;
- real contract revisions, real receipts, real reorg exposure;
- the owner changing account or chain **in the wallet** mid-flow.

## 2. Prerequisites

| Item | Requirement |
|---|---|
| Build | The deployed origin, or `web/index.html` from `8415wallet-dapp-3.0.0-beta.tar.gz`. Record the artifact sha256 actually served. |
| Chain | Sepolia `11155111` or Hoodi `560048`. Anything else is refused with `AGENT_TESTNET_REQUIRED`. |
| Deployment | A controller and token deployed on that chain, plus the `deployment.json` the control panel loads. Record both addresses and both `runtimeCodeHash` values. |
| Accounts | At least two funded testnet accounts in a real wallet application. Account A is the owner; account B is used for the actor-mismatch and destination cases. |
| Browser | A real browser with a real wallet extension, and at least one wallet application in-app browser on a phone. |

`runtimeCodeHash` is `keccak256` over the raw bytes `eth_getCode` returns, not
over the hex string. A wrong value fails at connect, after the user has already
been asked to connect a wallet.

## 3. The request format

An agent produces a JSON document and hands it to the owner out of band. The
wallet accepts it through a **file input only**: there is no ambient message
listener, no HTTP write endpoint and no agent credential.

```json
{
  "schema": "xiongan-agent-request/1",
  "requestId": "run1-create-01",
  "agent": "Codex Test Agent",
  "chainId": "11155111",
  "actor": "0xOwnerAccountA",
  "controller": "0xControllerAddress",
  "expiresAt": "<chain timestamp + 600>",
  "operation": { "kind": "create-account" }
}
```

Every key is required, no extra key is allowed, and all integers are decimal
strings. `expiresAt` must be greater than current chain time and no more than
**900 seconds** beyond it. Take the base from
`eth_getBlockByNumber('latest')`, not from the local clock.

The five supported operations, with their exact key sets:

| kind | keys |
|---|---|
| `create-account` | `kind` |
| `deposit` | `kind`, `tokenId` |
| `standalone-withdraw` | `kind`, `tokenId`, `destination` |
| `complete` | `kind`, `sequenceId`, `legId`, `expectedRevision` |
| `return-hop` | `kind`, `sequenceId`, `legId`, `expectedRevision` |

For `complete`, the request's `legId` is the through-leg. `sequenceId` and
`legId` are 32-byte hex and must be non-zero.

## 4. Positive journeys

Run each end to end: agent writes the file, owner reviews, owner acknowledges,
owner confirms in the wallet. For each, record the request file, the review
JSON the page displayed, the transaction hash, and the receipt status.

1. **create-account** — the owner's control account is created.
2. **deposit** — a token the owner holds is deposited. Record `tokenId`.
3. **standalone-withdraw** — the same token withdrawn to an explicit
   `destination`. Use account B so the destination is provably honoured and not
   silently replaced by the actor.
4. **complete** — against a real sequence with a real `expectedRevision`.
5. **return-hop** — against a real sequence, likewise.

For 4 and 5, state how the sequence was set up, since a `complete` on a
sequence that was never forwarded proves nothing.

## 5. Owner-in-the-loop properties

These are the point of the run. Each must be demonstrated on the deployed
build, with evidence.

1. **Review signs nothing.** Clicking review must produce no wallet prompt and
   no transaction. Confirm from the wallet's own activity log, not only from
   the page.
2. **The claimed agent name is not identity.** Submit a request whose `agent`
   is a name the owner trusts, for example the wallet's own name. It must be
   accepted as *text* and displayed as claimed, and must confer nothing.
   Record what the page showed.
3. **Acknowledgement is required.** Execute without ticking the acknowledgement
   must fail with `AGENT_OWNER_REVIEW_REQUIRED`.
4. **The review is consumed.** Click execute twice in rapid succession. Exactly
   one transaction may reach the chain. Report both the page's response and the
   transaction count.
5. **Account change invalidates.** Review a request, then switch the active
   account in the wallet, then execute. It must refuse rather than execute
   against a different owner.
6. **Chain change invalidates.** The same, switching network instead.
7. **Expiry across latency.** Mint a request with a short remaining window,
   review it, wait for the window to pass against chain time, then execute. It
   must refuse. Report which code appeared.
8. **The wallet is the only signer.** For every executed journey, the
   transaction must originate from the owner's confirmation dialog. No flow may
   produce a signature without one.

## 6. Refusal matrix

Exercise each on the deployed build and record the exact code shown. These are
covered by unit tests as logic; what is being confirmed here is that the
deployed artifact surfaces them to a user rather than failing open or failing
silently.

| Case | Expected |
|---|---|
| `chainId` `"1"` | `AGENT_TESTNET_REQUIRED` |
| `chainId` a testnet other than the connected one | `AGENT_REQUEST_CHAIN_MISMATCH` |
| `actor` set to account B while A is connected | `AGENT_REQUEST_ACTOR_MISMATCH` |
| `controller` set to another address | `AGENT_REQUEST_DEPLOYMENT_MISMATCH` |
| `expiresAt` in the past | `AGENT_REQUEST_EXPIRY_REFUSED` |
| `expiresAt` more than 900 s ahead | `AGENT_REQUEST_EXPIRY_REFUSED` |
| an extra key anywhere in the document | `AGENT_REQUEST_SCHEMA_REFUSED` |
| `schema` any other string | `AGENT_REQUEST_SCHEMA_REFUSED` |
| `operation.kind` unsupported, e.g. `approve` | `AGENT_REQUEST_OPERATION_REFUSED` |
| an operation carrying an extra field | `AGENT_REQUEST_SCHEMA_REFUSED` |
| `destination` with a wrong ERC-55 checksum | `AGENT_REQUEST_ADDRESS_REFUSED` |
| `sequenceId` all zeroes | `AGENT_REQUEST_HASH_REFUSED` |
| a file larger than 8192 bytes | `AGENT_REQUEST_SIZE_REFUSED` |
| malformed JSON | `AGENT_REQUEST_JSON_REFUSED` |
| a request carrying `signature`, `privateKey` or calldata fields | `AGENT_REQUEST_SCHEMA_REFUSED` |

No case in this table may result in a wallet prompt.

## 7. Unknown outcome and recovery

The journal distinguishes an operation that was **sent with an unknown
outcome** from one that never left. Only a real network produces that state
honestly.

1. Execute a journey, then interrupt before the receipt is observed: close the
   tab, or drop the network.
2. Reopen the page on the **same origin** and reconnect the same account.
3. The page must report the operation as outstanding and must not offer a
   silent retry. Record what it displayed.
4. Let the original transaction confirm, then reconcile. Record the final
   state.
5. Separately, confirm that a replacement with the same nonce that **cancels**
   the original is never reported as the original having succeeded.

Record the origin used. Journals are stored per origin, so a reopen on a
different host, scheme or port is a different test and will show nothing.

## 8. Evidence to return

For each journey and each refusal:

- the request JSON, verbatim;
- the review JSON the page displayed, verbatim;
- transaction hash, chain id, block number and receipt status, where one
  exists, and an explicit statement where none does;
- which wallet application and version, and which browser;
- a screenshot of the wallet confirmation dialog for at least one journey on
  desktop and one on a phone.

Also report once:

- the artifact sha256 actually served, and the origin;
- controller and token addresses with their `runtimeCodeHash`;
- the two account addresses used;
- total transaction count and total gas.

## 9. What this run does not establish

Completing everything above closes public-chain execution through the agent
path, and contributes device evidence. It does **not** establish:

- **independent security review**. A passing test run is not an audit, and no
  number of green journeys substitutes for one;
- **W-20**, the deployed same-token multi-wallet journey, unless that scenario
  is run explicitly;
- anything about **mainnet**. The control kernel refuses a non-testnet
  deployment in code, so this run says nothing about the asset-transfer path on
  Ethereum mainnet or Base.

Report failures as failures. A journey that needed an undocumented workaround
to pass is a finding, not a pass.
