# W-20 — deployed same-token multi-wallet journey, on a public testnet

For the operator running this against a real chain with real wallets.

W-20 is the one scenario of W-01 to W-24 that has no local evidence, and
`AGENTS.md` says why: it cannot be satisfied locally by construction. Every
other W number already has local EVM evidence, so this plan is scoped to what
only a deployed, multi-wallet run can show.

The requirement, from the PRD:

> One deployed same-token multi-wallet journey demonstrates **views**,
> independent control acceptance, detachment and callback; a **funded variant**
> also demonstrates segregated payments/refunds.

## 1. What already exists — do not rebuild it

`npm run wallet:controls:testnet` already drives the whole protocol journey on
a public testnet. It runs `runCoreJourney` **twice**, unfunded and funded, plus
`runExtendedJourneys` and `runDetachObservations`, covering forward, prefix
detachment, tail return, close, and a set of refusals including
`owner-only-cannot-complete`, `active-account-cannot-withdraw`,
`unresolved-tail-cannot-allocate`, `request-without-return-cannot-refund`,
`duplicate-hop-revision`, `detached-leg-not-on-chain` and
`detached-head-cannot-return`.

That runner is the **state machine**, and this plan uses it rather than
replacing it. Two things it does not establish, and which are exactly what W-20
asks for:

- **views** — it drives contracts through ethers, so no wallet UI renders
  anything;
- **multi-wallet** — its five actors are five keys behind **one** RPC signer in
  **one** process. That is not several parties each accepting in their own
  wallet.

Phase C below is therefore the new work. Phases A and B set it up.

## 2. Actors

The journey needs five, and their roles are fixed by the scenario:

| Index | Role |
|---|---|
| 0 | **A** — opens the sequence, first holder |
| 1 | **B** — receives the first forward |
| 2 | **C** |
| 3 | **D** — final owner in the core journey |
| 4 | **Control operator** — register validator, `returnAuthority`, `evidenceAuthority` |

Each of 0 to 3 gets its own on-chain `ControlledWallet` through
`createAccount()`, and **each recipient signs its own `ForwardConsent`** with
its own key. That is the independent-acceptance property W-20 tests; it is not
demonstrated by one process holding four keys.

### How many 8415wallet instances

A tenant subdomain is a separate origin, and a separate origin is a separate
operation journal. To show the control works across installations rather than
across tabs:

- **Minimum:** two tenant instances and two distinct wallet applications on two
  distinct devices, with at least one forward accepted from each.
- **Preferred:** four tenant instances, one per party, each party on its own
  device and wallet application.

Record which party used which instance, wallet application and device. If two
parties share an instance, say so — a shared origin is a weaker result and must
not be reported as four independent wallets.

## 3. Phase A — freeze and deploy

The runner refuses to execute unless the source is frozen and the budget is
bounded. Set every variable; it refuses rather than defaulting.

| Variable | Value |
|---|---|
| `WALLET_TESTNET_EXECUTE` | `TEST_ONLY_NO_REAL_VALUE` |
| `WALLET_TESTNET_CHAIN_ID` | `11155111` (Sepolia) or `560048` (Hoodi) |
| `WALLET_TESTNET_SOURCE_COMMIT` | the 40-hex commit; must equal `HEAD`, and `git status --porcelain` must be empty |
| `WALLET_TESTNET_RPC_URL` | the authorized signer RPC. **Never log it** |
| `WALLET_TESTNET_PUBLIC_ACTORS` | exactly five addresses, comma separated, all present in that endpoint's `eth_accounts` |
| `WALLET_TESTNET_OUTPUT_DIRECTORY` | absolute; the directory must **not** exist, its parent must |
| `WALLET_TESTNET_MAX_FEE_PER_GAS_WEI` | at most `1000000000000` |
| `WALLET_TESTNET_TOTAL_BUDGET_WEI` | at most `1000000000000000000` |
| `WALLET_TESTNET_MAX_GAS_PER_TX` | `21000` to `15000000` |
| `WALLET_TESTNET_CONFIRMATIONS` | `1` to `64` |

Per-transaction value is capped at **1000 wei**; the signer refuses anything
larger with `TESTNET_VALUE_LIMIT_REFUSED`. This run moves responsibility, not
value.

Outputs, in the exclusive directory:

- `transactions.jsonl` — hash-chained, one record per step;
- `public-deployment.json` — already in the shape the control panel loads;
- `result.json` — the verdict. **If it is missing, the run did not finish**,
  whatever the transaction log shows.

Report the deployed `ResponsibilityController`, `RegisterProjectionReference`
and `NativeResponsibilityPayments` addresses with their `runtimeCodeHash`.

## 4. Phase B — configure the instances

Each tenant instance serves the same build and is pointed at the same
deployment. `public-deployment.json` from Phase A is exactly the file the
control panel takes, so no hand-editing is needed; confirm its `chainId`
matches the chain used.

The control panel is testnet-only in code and refuses a mainnet deployment with
`CONTROL_TESTNET_REQUIRED`. Do not attempt to widen that for this run.

Record, per instance: origin, build sha256 actually served, and the
`deployment.json` digest.

## 5. Phase C — the multi-wallet journey

This is the part that has no local evidence. Drive it **through the deployed
UIs**, with each party in its own wallet, in order.

1. **Views, before anything moves.** On each instance, with the token id from
   Phase A, exercise the ten reading entries: asset, temporal, history,
   registration, acquisition, risk, posture, settlements, ownership,
   collisions. Capture what each shows. Two things must be visible and
   distinct: the **tradeable position** and the **confirmed holder**; and
   **final/provisional** must not be collapsed with **contested**.
2. **A opens the sequence** and holds the token.
3. **Independent acceptance, B.** The control operator prepares B's consent
   document; B reviews it **in B's own wallet on B's own instance**, and signs.
   Capture the review screen before signing and the wallet's confirmation
   dialog.
4. **Forward A to B.** Capture the resulting view on **both** A's and B's
   instances.
5. **Repeat for C, then D**, each accepting in their own wallet.
6. **Detachment.** Complete the AB prefix and detach it. Then, on a live
   instance, read the detached leg: it must report that it **detached**, not
   return an empty record. Capture that screen — it is the behaviour W-23
   describes and the one most easily mistaken for a bug.
7. **Callback.** Exercise the authorized return across the unresolved tail
   (D to C to B), each hop confirmed in that party's own wallet. Confirm the
   return **stops at the detachment boundary** and does not cross AB back to A.
8. **Close** and read the views once more.

At every step, the party whose key signs must be the party whose wallet shows
the prompt. A step completed by a different party's key is not evidence of
independent acceptance; record it as a deviation rather than a pass.

## 6. Phase D — the funded variant

Repeat Phase C with payment attached, on a second token.

- Each recipient reserves its own leg from its own wallet.
- On completion, payment settles to **A once**; a payment failure must not
  revive AB.
- On return, each original payer is refunded **after** its required return,
  through separate payment records.
- Payment is never the authority for acceptance, completion or return. Capture
  a view showing responsibility resolved while payment is observed separately.

Record each payment and refund with its transaction hash and the leg it
belongs to.

## 7. Phase E — device journeys

The same run supplies the physical-device evidence that is also outstanding.

- At least one party on an **iPhone** and one on an **Android** handset, each
  in a wallet application's in-app browser.
- Capture the wallet confirmation dialog at least once per platform.
- Record wallet application and version, OS version, and whether the page was
  reached over cellular or Wi-Fi.
- If a wallet application restricts IndexedDB, the page refuses with
  `CONTROL_BROWSER_DURABILITY_REQUIRED` rather than degrading. That is a real
  compatibility result; record it per application rather than switching
  application silently.

## 8. Evidence to return

Per phase:

- the exclusive output directory from Phase A in full, including
  `transactions.jsonl` and `result.json`;
- deployed addresses with `runtimeCodeHash`, and the chain id;
- per instance: origin, served build sha256, `deployment.json` digest;
- per party: address, wallet application and version, device, instance used;
- per step: transaction hash, block number, receipt status;
- screenshots: the ten views at least once, one consent review before signing,
  one wallet confirmation dialog per platform, and the detached-leg read;
- total transaction count and total gas.

State explicitly, for each of the four W-20 clauses — views, independent
control acceptance, detachment, callback — whether it was demonstrated, and by
which artifacts.

## 9. What this run does not establish

- **Independent security review.** A green journey is not an audit, and this
  run does not reduce that requirement.
- **Anything about mainnet.** The control kernel refuses a non-testnet
  deployment, so nothing here speaks to mainnet behaviour.
- **The other open observations** beyond W-20 and device evidence are reported
  separately; do not merge the counts.

Report failures as failures. A step that needed an undocumented workaround is a
finding, not a pass, and a phase that was skipped is recorded as skipped rather
than omitted.
