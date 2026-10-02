# Issue 001 — An asynchronous registrar, on chain

**For:** Codex (has signing keys and can deploy)
**Repository:** `GiraffeTechnology/8415Wallet`, branch `main`
**Status:** open
**Depends on:** the Sepolia deployment of 2026-09-19 (below), and
`src/adapters/memory/registrar.ts`, which is merged and tested.

---

## Why

The first Sepolia run proved the mechanism and did not prove the *premise*.

Its register had no independent existence: the two validators were the buyer
and the seller, and the admission followed the trade by about a minute because
someone ran the next command. So the run demonstrated a projection being
written, not a projection lagging behind a market.

That lag is the entire reason ERC-8415 exists. Until it is on a real chain with
real elapsed time, the product's central claim — *the on-chain market does not
need to run at the speed of the off-chain register* — has been asserted and not
shown.

`AsynchronousRegistrar` (`src/adapters/memory/registrar.ts`) now models it
in-process: a register with its own clock and a **serial** queue, which
backdates `effectiveAt` to when the transfer happened rather than to when it
got round to recording it. `tests/asyncRegistrar.test.ts` covers the
behaviour. **This issue is to run the same shape on chain.**

I cannot do it: this session holds no key and can send no transaction. I can
and did read the live deployment, which is how the three defects fixed in
`cf36f4e` and `200f7dc` were found.

---

## The scenario

The numbers are the ones that make the point, and they are the user's:

```
transfers        every 30 seconds
registration     180 seconds per hop, SERIAL
```

Serial matters more than the latency. Each hop starts when the previous one
finishes, so a token traded faster than the register works does not stay three
minutes behind — it falls further behind with every trade:

```
t=0     A -> B      recorded at t=180
t=30    B -> C      recorded at t=360     (starts when the first finishes)
t=60    C -> D      recorded at t=540
```

By t=60 the token is three owners ahead of its own record, and the backlog is
still growing. This is what a wallet has to render without calling any of it a
failure.

## What exists to build on

| | |
|---|---|
| ERC-8415 reference | `0xaeeb157f40ffdad51693275258a465763be66cd8` |
| `ProjectionEscrow` | `0x50299e4d454fc9ec788f735e004d1ec537767934` |
| chain | Sepolia, 11155111 |
| deployment block | 11739196 (`--from-block`) |

Reuse them or redeploy — but **the registrar must not be a counterparty this
time.** Use a separate account, or a separate validator set, so that the
register is something the traders do not control. That separation is the thing
the last run did not test.

Proof construction is in `test-evm/escrow.cjs` (`proof()` and `admit()`).

---

## Tasks

### R1 — A registrar process with its own clock

A script that watches `Transfer` logs on the projection contract and, for each
one, waits its registration latency and then admits an entry through
`beginSettlement` + `finalizeSettlement`.

Three properties are the point, and each is a pass/fail:

- **Serial.** One hop at a time. A second transfer arriving while the first is
  being recorded must queue, not overtake.
- **Backdated.** The entry's `effectiveAt` is the **block timestamp of the
  transfer**, not of the admission. Record both and show they differ by roughly
  the latency.
- **Real elapsed time.** No `evm_setNextBlockTimestamp`. The previous run
  already held this line for the refund path; hold it here.

The reference contract enforces `MAX_EFFECTIVE_AHEAD` and requires strictly
increasing `effectiveAt`, so serial processing is also the only order that
works.

### R2 — Three hops, 30 s apart

Drive `A → B → C → D` at 30-second intervals against a 180-second registrar.
Record, for each hop: transfer tx and block timestamp, admission tx and block
timestamp, the entry's `version` and `effectiveAt`, and `ownerOf` versus
`currentEntry().holder` at the moment of each.

### R3 — Sample the divergence while it is open

At **t=45 s** (after two transfers, before any admission), record from the live
chain:

```
ownerOf(tokenId)
currentEntry(tokenId).holder
holderAsOf(tokenId, <t=0>)
isFinalAsOf(tokenId, <t=0>)
openGapOf(tokenId)
entryCount(tokenId)
```

Expected: the position is C, the confirmed holder is still A, and `entryCount`
has not moved. **Report what you actually get.**

### R4 — Finality arrives in arrears

After hop 2 is recorded, `isFinalAsOf(t=0)` must become **true** — the instant
of the first transfer is final only once a *later* entry closes the interval it
sits in. Before hop 2, it must be **false**.

Record both, at both moments. This is the property the clearing contract's
release condition rests on, and the one worth most.

### R5 — The wallet, mid-lag

Run the client against the live contract at t=45 s and paste the **complete**
output:

```
npm run wallet -- --rpc <url> --contract <addr> --chain-id 11155111 \
  --token <id> --from-block <deployment block>
```

Check, and say plainly if any is wrong:

- the tradeable position and the confirmed holder appear as **two separate
  facts**, never merged into one "owner";
- `ALIGNMENT` reads **diverged**;
- the registration view says waiting is the action and that the token is **not
  blocked** — it should deny failure outright rather than avoid the word;
- nothing anywhere reads as *pending / confirmed / rejected*, which are not
  protocol states.

### R6 — A trade whose registration misses the deadline

Open a clearing trade with an `admissionDeadline` **shorter than the registrar's
backlog** — with three hops queued, a 4-minute deadline will miss. Let the
deadline pass with the registrar still working, then `refund`.

Then the reverse: a deadline comfortably longer than the backlog, and `release`
once the hop lands.

This is the dealer scenario end to end: the register's own speed, not anyone's
decision, determines which way the trade resolves.

### R7 — Release by a third party

Not done last time — release was called by the seller. Call `release` from a
**fourth account that is neither buyer nor seller nor registrar** and confirm it
succeeds. The condition is public; neither party should be able to hold a trade
up by declining to call.

---

## Rules

1. **The library never holds a private key.** `src/` may not gain a raw-key
   signer. Yours goes in `scripts/`, uses `ethers`, and satisfies the existing
   `TransactionSigner` type.
2. **Do not edit `src/` to make something pass without saying so.** Findings and
   proposed fixes go in separate sections, as diffs.
3. **Report what happened, not whether it went well.** An exact failure is worth
   more than a pass. Do not retry until green and report only the green.
4. Never commit a key, a mnemonic, an RPC URL with an embedded API key, or a
   `.env`.
5. Test-only. No real value, no mainnet.

## What to report

1. **Environment** — chain, provider, client version, the four addresses and
   their roles, commit tested.
2. **Timeline table** — one row per event (transfer or admission) with wall
   clock, block, block timestamp, tx hash, and the resulting
   `ownerOf` / `currentEntry().holder` / `entryCount`.
3. **R3 and R4 readings**, verbatim.
4. **R5 output**, complete.
5. **R6 and R7 outcomes** with tx hashes and balance changes.
6. **Findings** — anything that did not behave as this repository claims: what
   you called, what you expected, what you got, whether it fails loudly or
   silently, ranked by whether a user would notice.
7. **Gas** per operation and total spent.

## Predictions

State whether each held. They are written down first so they can be refuted
rather than rationalised afterwards.

1. **`isFinalAsOf` at the newest entry's own `effectiveAt` is false, always** —
   confirmed once already on this deployment, and it should hold at every hop.
2. **The backlog grows.** Hop 3's admission lands ~540 s after t=0, not
   ~180 s. If it lands earlier, the registrar is running in parallel and R1's
   serial requirement was not met.
3. **The wallet renders the lag without calling it a failure**, because the
   copy denies failure explicitly. If any view reads as an error state, that is
   a defect worth more than the rest of this issue.
