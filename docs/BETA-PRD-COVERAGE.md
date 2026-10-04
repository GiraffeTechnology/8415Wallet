# 8415wallet DApp Beta PRD coverage

## Version and evidence contract

V2 means the retained wallet PRD v2.2 foundation in sections 1–8 of
`ERC-8415-Wallet-PRD.md`. V3 means that foundation plus the additive v3.0 linked
requirements in section 9. These are product/PRD scopes, not SDK package
versions. Each generated DApp manifest records the exact PRD file hash and
source tree; shared runtime code does not erase this distinction.

The matrices identify the actual DApp entry points and relevant executable
regressions. A listed test is a coverage reference, not a statement that it ran
for a particular artifact. Use the source-bound CI and delivered test report for
actual results. Local EVM execution is real contract execution on a local chain;
deterministic provider/DOM tests are synthetic. Neither is a genuine deployed
wallet, physical-device or W-20 result.

## V2 standalone foundation

| Requirement | DApp route | Implementation and regression reference |
| --- | --- | --- |
| Separate ERC-721 position / current holder / register identity / authority | Standalone → Read asset | `wallet/assetView.ts`, `assetView.test.ts`, `identity.test.ts` |
| Historical holder, entry, temporal finality, uncovered instant and contest | Standalone → Query historical instant | `wallet/temporalQuery.ts`, `temporalQuery.test.ts`, `forbiddenInferences.test.ts` |
| Append-only admitted history and ERC-721 ownership sequence | Admitted history / Ownership history | `history.test.ts`, `ownershipHistory.test.ts` |
| Open gap, admitted/cancelled/superseded distinction | Settlement log / Registration explanation | `settlementLog.ts`, `settlement.test.ts`, `gapView.test.ts` |
| Acquisition, lag, authority, deadlines, no legal-identity inference | Acquisition disclosure / Authority and bounds | `holderViews.test.ts`, `registration.ts`, `riskSurfaces.ts` |
| Raw temporal finality distinct from optional chain freshness | Finality / freshness | `freshness.test.ts`, `holderViews.test.ts`; absent feed is explicitly not configured |
| Bounded cross-token commitment/reference scan | Compare public commitments and references | `collision-boundaries.test.ts`, `browser-connection.test.ts`; no whole-register uniqueness claim |
| Begin, finalize and cancel settlement | Standalone protocol transaction review, explicit wallet confirmation and recovery | Existing `WalletSession.transactions`, `sdk/transactions.ts`, `Eip1193Signer`; DApp wrapper revalidates the reviewed request and preserves uncertain sends |
| Legacy single-trade clearing | Separate legacy-clearing panel | `ProjectionEscrow.sol`, `escrowRpcReader.ts`, `escrowView.test.ts`, `test-evm/escrow.cjs`; escrow terms never become linked authority |
| Independent use | Token-only manifest, controller/payment absent | No ArtFi, Oracle, linked control or payment adapter required for standalone protocol use |
| Existing-standards ETH/ERC-20/NFT companion | External wallet asset panel | `xiongan-assets.test.ts`, `xiongan-address-ui.test.ts`, `xiongan-erc20.test.ts`, `external-erc20.cjs`; separate EOA custody, not ERC register semantics |

The optional Kit and watchtower integrations retain their SDK/CLI configuration
surfaces. The DApp's direct-chain standalone path does not silently require
these services, manufacture feed freshness or infer a holder from token owner.

## V3 linked responsibilities: W-01 through W-24

All rows use the V3 profile. The V2 profile does not expose linked execution.
Payment observations remain separate from responsibility/projection facts.

| ID | Actual DApp route and required observation | Primary local regression source |
| --- | --- | --- |
| W-01 | Review/sign consent, reserve exact optional payment, seller forwards; read token at recipient and payment separately | `control-sdk.cjs`, `control-reservations.cjs`, `responsibility-controls.cjs` |
| W-02 | Repeat reviewed forward through B/C/D; each review includes active inherited terms; each funded record is separate | `responsibility-controls.cjs`, `control-sdk.cjs` |
| W-03 | Read chain/projection while registration lags; no invented rejection or protocol transfer lock | `responsibility-controls.cjs`, `holderViews.test.ts` |
| W-04 | Bind admitted occurrence, Complete prefix, Read chain; settle optional payment separately | `responsibility-controls.cjs`, `control-sdk.cjs` |
| W-05 | Holder at C can complete AB and BC in prefix order without rewinding | `responsibility-controls.cjs` |
| W-06 | Fresh revision required after tail extension; completion preserves the new unresolved tail | `responsibility-controls.cjs`, `responsibilityControl.test.ts` |
| W-07 | Invoke accepted return then one reverse hop at a time D/C/B/A; allocate/refund original payment routes | `responsibility-controls.cjs`, `control-payments-adversarial.cjs` |
| W-08 | After AB detaches, a BC return stops at B; read detached prefix and live boundary | `responsibility-controls.cjs`, `chain-rolls-forward.cjs` |
| W-09 | A descendant cannot complete/refund principal needed by a live inherited obligation | `responsibility-controls.cjs`, `control-payments-adversarial.cjs` |
| W-10 | Return request differs from executed return; payment cannot refund before required return | `responsibility-controls.cjs`, `control-payments-adversarial.cjs` |
| W-11 | Recovery and execution state stays resumable after a failed hop/payment; payment due is separate | `controls-workflow.test.ts`, `control-payments-adversarial.cjs` |
| W-12 | Repeat click, stale action, reload and replay preserve one outcome; no automatic resend | `controls-workflow.test.ts`, `browser-connection.test.ts`, synthetic browser recovery |
| W-13 | Prepare review/sign refuses unsupported recipient, invalid domain/expiry and forged acceptance | `responsibility-controls.cjs`, `control-sdk.cjs` |
| W-14 | Controlled account alternate transfers cannot discard active obligations | `responsibility-controls.cjs`, `ControlledWallet.sol` enforcement |
| W-15 | Occurrence and leg IDs remain distinct even when an address repeats; read absolute indices | `responsibility-controls.cjs`, `responsibilityControl.test.ts` |
| W-16 | RPC errors, malformed/unsupported/unavailable evidence are surfaced as failures, never success | `controls-workflow.test.ts`, `control-detached-history.test.ts`, browser failure regressions |
| W-17 | Complete versus return uses expected revision and one authorized terminal outcome | `responsibility-controls.cjs`, `responsibilityControl.test.ts` |
| W-18 | Late admission remains visible but cannot rewrite completed return/refund | `responsibility-controls.cjs` |
| W-19 | Both owner and admitted-holder occurrence are required; commercial completion does not relabel raw ERC provisional status | `responsibility-controls.cjs`, `control-sdk.cjs` |
| W-20 | Manual deployed same-token multi-wallet journey using these views, reviews, forwarding, detachment, return and funded variant | **Deployment acceptance to collect.** `public-testnet.cjs` and `browser-journey.cjs` are tooling, not completed W-20 evidence |
| W-21 | Same controls operate with payment null; funded variant adds payment without changing authority | `responsibility-controls.cjs`, `control-sdk.cjs` |
| W-22 | Rolling unresolved window supports continued forwarding beyond lifetime occurrence 128; 129th unresolved is refused and detaching one frees a slot | `chain-rolls-forward.cjs`, `control-reservations.cjs`, `responsibilityControl.test.ts` |
| W-23 | Verify/read detached history; detached IDs cannot complete/return again; payment remains readable/settleable after pruning | `chain-rolls-forward.cjs`, `detached-history.cjs`, `payment-observation.cjs` |
| W-24 | Read chain with detached prefix/live tail anchored at boundary; display detached count and absolute occurrences; no ID reuse | `chain-rolls-forward.cjs`, `detached-history.cjs`, `control-sdk.cjs` |

Contract regression paths above are under `test-evm/`; TypeScript regressions
are under `tests/`. A read-only archive verification never authorizes a
transaction or claims protocol temporal finality. The browser file-size budget
for archive review is distinct from the protocol's unresolved-window bound.

## Functional corrections in this Beta

- Hand-entered withdrawal addresses are checksum-validated before normalization.
- Replacing consent input invalidates the review and any in-memory acceptance;
  failed preparation removes old displayed terms. A delayed result cannot restore
  a review invalidated by a new selection or connection.
- A direct numeric EIP-1193 code 4001 is a known rejection; clearing its exact
  send claim requires durable success. Ambiguous errors stay uncertain.
- Repeating an action never automatically resends. Fresh owner review is
  required after cancellation, and unknown outcomes require reconciliation.
- Product, tenant, PRD scope and package identity are explicitly separated.

## Manual acceptance record

For each executed row record profile, source commit/tree, archive/runtime
hashes, full origin, chain ID, exact deployment pins, wallet/browser/device
versions, accounts, displayed terms, transaction hashes and canonical receipts.
Record actual elapsed registrar time; local time jumps are not real testnet
waiting. No signing, transaction, deployment or real-device result is implied
by this package or matrix.

Independent security review is uncompleted. That limits assurance and general
release claims; it does not prevent this functional-testing Beta from being
packaged and handed to the deployment/test operator.
