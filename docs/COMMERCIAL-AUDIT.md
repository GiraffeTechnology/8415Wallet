# Commercial direction audit — PR #2

Against the Commercial Direction Briefing (P0). Audit only; no refactor was
performed, per §11.

Repository at `0190dc7`, branch `claude/agents-md-execution-46epwt`.

---

## A. Current state — what PR #2 actually delivers

Eleven commits, 19,654 additions across 139 files.

| Surface | State |
|---|---|
| Projection reads | 17 view models: asset view, temporal query, finality (4 display states), entry walk, gap awareness with the three closures distinguished, risk surfaces, watchtower freshness, dual-sequence timeline, registration, acquisition disclosure, cross-token collisions, audit export |
| Backend | Two adapters behind one port (`rpc`, `kit`), both held to `checkReaderConformance`; identity cross-checked between them |
| Write path | All three ERC-8415 settlement operations built and preflighted. No fourth operation |
| Signing | `Eip1193Signer`. The library holds no key material |
| Clearing | `ProjectionEscrow` + `EscrowReader` + `buildEscrowView` |
| CLI | `--rpc`/`--contract`/`--token`/`--account`/`--kit`, plus bundled scenarios |
| Verification | 492 tests / 95 suites, 14 contract tests on a real EVM against the ERC's own reference implementation, typecheck clean, no runtime dependencies |

**Nothing here has touched a real network.** Every result comes from an
in-memory contract model, a fake JSON-RPC node, or a local hardhat EVM. The
on-chain brief is written (`docs/ONCHAIN-TEST-PROMPT.md`) and not yet run.

---

## B. Product drift — and one place not to "fix"

Four locations still carry the reference-wallet definition:

| Location | Text |
|---|---|
| `docs/ERC-8415-Wallet-PRD.md:15` | "8415Wallet is a reference wallet for ERC-8415 ecosystem applications." |
| `README.md:3` | "A reference wallet and client for ERC-8415…" |
| `docs/ERC-8415-Wallet-PRD.md:375` | "The wallet reports; it does not advise and it does not act." |
| `AGENTS.md:113` | "The wallet reports that the window has passed; it does not advise, and it does not act." |

**The last two are half right, and a bulk edit would destroy something the
briefing wants kept.** Two claims are welded together in one sentence:

- *does not act* — obsolete. The wallet builds transactions, signs through a
  provider, and clears trades. This is the drift.
- *does not advise* — still correct, and §11.9 depends on it. It is the
  discipline that stops the wallet scoring a gap, recommending a trade, or
  collapsing the three orthogonal signals into a verdict. Clearing does not
  change it: the escrow executes agreed terms, it does not judge them.

The corrective edit is to separate the two claims, not to delete the sentence.

**Corrected 2026-09-18.** All four locations were edited, separating the two
claims rather than deleting the sentence. The PRD and README now state the
commercial MVP alongside the reference role; the PRD §4.7 passage and
AGENTS.md now say the wallet does not *advise*, and state explicitly that
executing a term the parties agreed beforehand is not advising and not the
wallet choosing a remedy. What stays forbidden is unchanged: choosing the
remedy, scoring the situation, recommending a course of action.

Still accurate and to be preserved:

- `docs/ERC-8415-Wallet-PRD.md:22` "The wallet is not an ownership viewer" —
  the two-sequence thesis, unchanged;
- `docs/ERC-8415-Wallet-PRD.md:152` "The wallet MUST NOT redefine ERC-8415
  semantics" — §11.7;
- `docs/ERC-8415-Wallet-PRD.md:491` "no write path into the projection beyond
  transactions the user signs" — §11.9.

---

## C. Dealer MVP gap

### C1 — The fungibility boundary is the finding that governs the rest

ERC-8415 is `requires: 165, 721`, titled *Asynchronous Register Projection for
NFTs*. Its interfaces "identify a token by `tokenId` alone", and its guarantee
is that every past instant resolves to **exactly one confirmed holder**.

Tokenised stocks and funds are commonly represented as *fungible balances*.
ERC-8415 does not project onto a balance, and §11.7 forbids changing it to.

This is not fatal, and it is not a workaround — it is the scope:

> **ERC-8415 fits holding-level tokenisation, not balance-level tokenisation.**

A transfer agent's register is a list of **holdings**, each with one registered
holder. One token = one registered holding maps onto ERC-8415 exactly, and
`holderAsOf(tokenId, instant)` is then literally "who was the registered holder
of this holding at that instant". A fund unit position, a share lot, a
registered certificate — all are holdings.

**The dealer MVP must be framed at holding level.** If it is framed at balance
level it cannot be built on ERC-8415 without changing the standard. This should
be settled as a product statement before further implementation, because it
determines what the demo can honestly claim.

Consequence for the existing contract: `ProjectionEscrow`'s "one token, whole
thing, one buyer" model is **correct** for holding-level trading. It is not an
NFT/collectibles assumption that needs removing. What it cannot do is partial
fills of a fungible balance — which is out of scope under the framing above.

### C2 — Transfer restrictions: the likeliest thing to kill a dealer demo

`ProjectionEscrow` calls raw `transferFrom` (line 166) and `safeTransferFrom`
(207, 229, 242) against `IERC721Minimal`. It assumes transfers always succeed.

Real security tokens do not. ERC-1400 / ERC-3643 style tokens enforce
eligibility at transfer time — jurisdiction, accreditation, lockup, whitelist —
and a transfer to an ineligible address reverts.

Two consequences, neither currently modelled or tested:

1. **The escrow contract itself must be an eligible holder**, or `open` reverts
   and no trade can start;
2. **The buyer must be eligible at release time**, not merely at trade time. If
   eligibility lapses during clearing, `release` reverts and the trade is stuck
   until the deadline sends it to `refund`.

(2) is arguably correct behaviour, but it is currently accidental rather than
designed, and the views say nothing about it.

### C3 — The money leg is ETH

`fund` is `payable` and compares `msg.value` (174, 179); `_pay` uses
`call{value:}` (348). Dealers settle in stablecoin. This is the one contract
change the MVP actually requires.

### C4 — The dealer does not create the trade

§12.1 has the dealer/venue creating the trade. `open` pulls the asset from
`msg.sender` (166), so the **seller** must open. A venue can build and present
the transaction for the seller to sign — which is what this wallet already does
for settlement transactions — so this is a demo-flow question, not a contract
gap. Worth deciding explicitly rather than discovering during the demo.

### C5 — Not a gap

The registration condition (§12.7) is already expressed as agreed terms: the
latest entry names the buyer, its version is newer than the count at funding,
and its effective time is inside an agreed bound. No change needed.

---

## D. Kit boundary

**Measured, not estimated: the commercial product has zero coupling to the
vendored Kit.**

No file outside `src/kit` imports from `src/kit`. The wallet's Kit adapter
(`src/adapters/kit/`) speaks HTTP to a Kit *deployment* and imports only from
`src/sdk`. The vendored tree is referenced exclusively by `tests/kit/*`.

| Vendored | Required by the commercial product? |
|---|---|
| `contracts/*.sol` (`IRegisterProjection`, `IProjectionSettlement`, `IERC165`) | **Yes.** These are the ERC's frozen interfaces, not Kit-proprietary. `ProjectionEscrow` imports them |
| `tests/kit/contracts.test.ts` | **Yes, as verification.** It derives selectors from the compiled Solidity ABI and compares them against this repository's own Keccak. That cross-check is the reason a signature drift fails the build |
| `src/kit/{engine,api,console,sdk}` | No. Used only by `tests/kit/*` |
| `docs/kit/`, `docker/`, `conformance/` | No |

So the strategic rule in §10 is already satisfied in substance. What is missing
is **enforcement**: the boundary holds today by accident of how the code was
written, and nothing prevents a future import from crossing it.

**Minimum corrective architecture — do not refactor.** Add a test that fails if
any file outside `src/kit` imports `src/kit`, and state the rule in AGENTS.md.
That converts an accident into an invariant for a few lines. Physically
separating the repositories later is then a directory move and a CI job, not an
architecture change.

---

## E. Minimal next stage

Smallest stage that demonstrates *token trade → clearing → delayed
authoritative registration → release/refund*:

1. **Settle the holding-level framing (C1) as a written product statement.**
   No code. It governs everything after it.
2. **Stablecoin money leg.** `fund` takes an ERC-20 `transferFrom`; `_pay`
   becomes `safeTransfer`. Keep ETH or drop it — one decision, one contract.
3. **Correct the four drift locations (B)**, separating *does not act* from
   *does not advise*.
4. **Add the Kit boundary guard test (D).**
5. **Run the on-chain brief** (`docs/ONCHAIN-TEST-PROMPT.md`) on Sepolia,
   extended with an eligibility-restricted token to exercise C2.
6. **A dealer demo script** walking §12's nine steps end to end and printing,
   at each step, the three states side by side — token, register, money — so
   the value proposition is visible rather than asserted.

Explicitly **not** in this stage, per §11.6: lending, marketplace, custody,
exchange, partial fills, fungible balances, and Institutional Oracle
integration.

### Note on §12

With the stablecoin leg and the holding-level framing, §12's scenario is
demonstrable with what already exists. The mechanism is built and tested; what
is missing is the money leg, the securities-token realism, and a real network.
