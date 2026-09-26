# Stage 5J — the public path, rehearsed, and a genuine browser journey

Date: 2026-09-26. Test and delivery tooling only; no contract, ABI, wallet
authority or business change. Two gates that were previously unreachable from
this repository are now reachable, and one of them is now met.

## What was blocking a public-testnet run

`scripts/controls/public-testnet.cjs` refuses raw signatures on purpose
(`TESTNET_RAW_SIGNATURE_REFUSED`) and expects an RPC endpoint that *custodies*
its five actors: it calls `eth_accounts` and then signs through the endpoint.
No public endpoint custodies anything, so the runner had nothing to run
against, and the journeys it drives had never executed.

`scripts/controls/testnet-signer.cjs` supplies exactly that and nothing more:

- a loopback JSON-RPC endpoint on `127.0.0.1` behind a random request path;
- five throwaway keys created by `init`, held in a `0600` keystore, and read by
  no other process — the runner still sees only an RPC and never a key;
- test chain ids only (11155111, 560048), and a value ceiling of 1000 wei;
- `eth_accounts`, `eth_sendTransaction` and `eth_signTypedData_v4` served
  locally; a bounded read allowlist forwarded upstream; everything else refused.
  `eth_sendRawTransaction` is never relayed for a caller, only used internally
  to broadcast what this process itself signed;
- typed signing bound to the one control domain, so the endpoint cannot be
  induced to sign a permit, a message or another application's payload.

`init` also prints what each role must be funded, from gas actually measured
for the whole journey set rather than a guess.

## What the rehearsal established, and what it did not

A rehearsal runs the identical runner against a loopback chain answering with a
test chain id (`hardhat.rehearsal.config.cjs`). It is explicit, it is loopback
by construction, and it is **not a public-chain run**.

Result at commit `bf72fcc`, chain id 11155111, one deployment set:

| Measure | Value |
| --- | --- |
| Evidence events | 243 |
| Transactions | 105 |
| Total gas | 30,464,890 |
| Largest single transaction | 5,212,144 (`deploy:ResponsibilityController`) |
| Journeys with assertions completed | 7 |
| SDK observations recorded | 6 |
| Read-only reverts asserted | 16 |
| Verdict | `CORE_JOURNEYS_EXECUTED_NOT_FULL_V3_ACCEPTANCE` |

This proves the public path executes end to end. It does not prove anything
about a public network: no reorg, no independent block producer, no real fee
market and no third-party node were involved. **W-20 is untouched**, and the
public-testnet gate stays open until the same command runs against Sepolia or
Hoodi with funded accounts.

One rehearsal artifact is worth naming. A development chain answers a reverted
`eth_call` with `-32603`, while a public node answers with EIP-1474 code `3`,
which is what `Eip1193ReadTransport` classifies a revert from — correctly, and
deliberately, without reading message substrings. A rehearsal therefore
normalises that one code toward the public shape; otherwise it would exercise
a code no public node sends.

## Genuine browser journey

`scripts/controls/browser-journey.cjs` drives the served reference UI in a real
Chromium (141.0.7390.37) at two profiles: a desktop window at 1440×900 and an
emulated phone at 390×844 with touch. An **emulated viewport is not a physical
handset**, and the journal records `physicalDevice: false`.

The page is given an injected EIP-1193 provider, which is the same contract a
wallet extension offers; the page keeps no network path to the chain. The
journal proves that boundary held rather than asserting it: every request the
page made is recorded, and the count leaving the origin was zero.

Fourteen recorded steps per profile, each screenshotted:

- the public deployment manifest is loaded and the wallet connected;
- nine reader views render real content — asset, temporal, admitted history,
  registration, acquisition, authority and bounds, finality/freshness,
  settlement log, ownership history;
- an instant before the first entry is queried as an explicit negative. The
  page must *explain* it — "the projection does not cover this instant" — and a
  bare refusal code fails the journey. This is the degradation rule under test
  in the product, not in a unit;
- the linked view renders the live chain, and a public detached-history export
  built from the chain's own `LegDetached` logs is verified in the page against
  the canonical on-chain commitment, which must appear in the rendered output.

Two defects were found and fixed here, both in the new harness and neither in
the product: the signer relayed an upstream failure without its revert bytes,
and the page binding flattened a provider error so its EIP-1474 code was lost.
A third was a weak wait that let a step return before the page settled, so the
next click was silently dropped while the page was busy.

## Local results at this stage

699 Node cases across 108 suites, 53 EVM cases, typecheck, browser emit and the
seven V2 install checks pass. The V2 package is unchanged by this stage: its
compiled payload hashes identically, and `playwright-core` is a development
dependency that the shipped tarball still does not carry — it reports zero
runtime dependencies.

## What remains

- **Public-testnet execution.** Fund the five addresses `init` prints, point
  `WALLET_TESTNET_UPSTREAM_RPC_URL` at a public endpoint, and run the same
  command. Nothing else changes.
- **W-20**, one deployed same-token multi-wallet journey.
- **Independent security review** of the exact tree, now including this signer.
  A loopback endpoint holding keys is a new surface and has not been reviewed.
- **A physical handset.** Emulation is not a device.
