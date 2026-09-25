# V2 closeout — the standalone foundation

What V2 is: the standalone reading wallet (PRD §§1–8, Stages 0–5) and the legacy
single-trade `ProjectionEscrow` clearing pattern. V3 added linked mode beside it
without replacing it, so V2 can be closed on its own terms.

This record closes V2 against PRD §8's seven conditions. It is not a V3
statement, and it does not upgrade any V2 evidence into V3 evidence.

## PRD §8, item by item

Each row names a passing test rather than asserting the behaviour. Names are as
the runner prints them.

| § | Condition | Evidence |
| --- | --- | --- |
| 8.1 | position and confirmed holder as two separate facts, and whether they agree | `both are reported, and they differ`; `alignment is reported without merging the two facts` |
| 8.2 | the holder at an instant, or a clear statement that the projection does not cover it | `an instant before the first entry is not covered, and is not an error`; `not-covered before the first entry, distinct from provisional` |
| 8.3 | final or provisional, taken from `isFinalAsOf`, reason in protocol terms | `is read from isFinalAsOf, and the present is provisional`; `a confirming entry moves an instant from provisional to final` |
| 8.4 | contested by an open gap, as a signal separate from finality | `an instant after the gap opened is contested and provisional`; `a final instant can sit under an open gap` |
| 8.5 | which entry admitted the answer, with version, commitment and registry reference | `carries the entry that admitted the holder, and an opaque reference` |
| 8.6 | what register, under which profile, who may move the answer | `settlement authority`; `transferring the token does not confer the authority`; `omits the verification profile when there is no settlement interface`; `a changed registerId is rejected, not displayed` |
| 8.7 | what a pending registration means, that it is not a failure, that waiting is the action, where the remedy lies | `says outright that a pending registration is not a failure`; `never frames it as a failure, and always says the token is not blocked`; `a passed window points at the trade terms, and advises nothing` |

The four negative cases AGENTS.md requires are all in
`tests/forbiddenInferences.test.ts`: `ownerOf` diverging from the confirmed
holder, a cancelled gap leaving later instants non-final, gap closure not
conferring finality, and an instant before the first entry.

Beyond §8, the separations the standard depends on are held by their own cases:
`freshness is never finality`, `a stale head does not make a final instant
unsettled`, `stale is not pending`, `reads are snapshots`, and
`collisions the protocol does not prevent`.

## Test accounting

The numbers are separated so no V2 figure can be read as V3 coverage, and they
reconcile exactly against the full run.

| Suite | Cases |
| --- | --- |
| V2 wallet suites (`tests/*.test.ts`, excluding the control suites) | 366 |
| Vendored Kit suites (`tests/kit/**`) | 152 |
| V3 control suites (linked mode, controls, journal, consent) | 115 |
| **Full Node run** | **633** |
| Legacy single-trade escrow, on a real EVM (`test-evm/escrow.cjs`) | 14 |
| V3 control suites on a real EVM | 26 |
| **Full EVM run** | **40** |

The 14 legacy escrow cases are unchanged and still describe legacy single-trade
clearing. They are not relabelled as linked-mode acceptance, which AGENTS.md
forbids. The standalone reference client runs clean, so V3 did not take the
standalone path with it.

## Deployed evidence

One public-testnet run stands for V2: Sepolia, 2026-09-19, 14 transactions all
with `receipt.status = 1`, covering both the release and the refund path, with
the refund waiting on real elapsed chain time rather than a local time jump.
Reference contract `0xaeeb157f40ffdad51693275258a465763be66cd8`, escrow
`0x50299e4d454fc9ec788f735e004d1ec537767934`, from block 11739196. It is
recorded in `docs/STAGE-DELIVERY.md`.

That run is V2 evidence only. It predates every line of the control code and
does not validate it.

## The one thing V2 does not show

**Closed with a known gap, not closed clean.** The Sepolia run proved the
mechanism and not the premise. Its register had no independent existence: the
two validators were the buyer and the seller, and the admission followed the
trade by about a minute because someone ran the next command. So it showed a
projection being written, not a projection lagging behind a market — and that
lag is the reason ERC-8415 exists.

`AsynchronousRegistrar` models it in process, with its own clock and a serial
queue that backdates `effectiveAt`, and `tests/asyncRegistrar.test.ts` covers
the behaviour: `a register three minutes behind a chain that moves in thirty
seconds`, `falling behind compounds: a→b→c→d at 30s against 180s a hop`, and
`an in-flight change behind the position says more transfers follow`.

The same shape on a real chain is `docs/issues/001-asynchronous-registrar-on-chain.md`,
which is **still open and has never run**. It needs a signing key and a
registrar that is not a counterparty. Until it runs, the product's central claim
— that the on-chain market need not run at the speed of the off-chain register —
is asserted in code and tests and shown on no public chain.

## What this closeout means

Closed: PRD §8's seven conditions, with the named evidence above; the four
mandated negative inferences; the legacy single-trade clearing path, on a real
EVM and once on Sepolia.

Not closed by it, and not implied: issue 001; any V3 claim; a browser or mobile
journey; an independent security review. GitHub Actions has not run any of this
— every run in this repository since 2026-09-19 fails within seconds with no
runner assigned, including pushes to `main` — so the figures above are local
runs on Node 22, and are labelled as such wherever they appear.
