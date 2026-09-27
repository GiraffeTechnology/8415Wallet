# Contract size budget — what it was, and what was done

Date: 2026-09-27. solc 0.8.26, viaIR, optimizer enabled, 200 runs.

**Resolved for the payment adapter; the account remains embedded by design.**
The controller went from 689 bytes of headroom to 6,265. The finding below is
kept because the constraint is permanent and the reasoning is what a later
change needs.

## The finding

| Contract | Runtime bytes | Of EIP-170 limit | Headroom |
| --- | --- | --- | --- |
| **ResponsibilityController** | **23,887** | **97.2%** | **689** |
| RegisterProjectionReference | 9,949 | 40.5% | 14,627 |
| NativeResponsibilityPayments | 5,631 | 22.9% | 18,945 |
| ControlledWallet | 1,428 | 5.8% | 23,148 |

The EIP-170 limit is 24,576 bytes. The controller has 689 bytes left, so the
next feature of any size fails to deploy on a public chain — after passing
every test, because a development chain is normally configured without the
limit. Nothing was watching this.

`test-evm/deployment-budgets.cjs` now watches it: it fails when any contract
drops below 512 bytes of headroom, and points here.

## Where the bytes are

`createAccount` and `createNativePayments` use `new`, which embeds each
contract's **entire creation bytecode** in the controller's own code.

| Embedded | Creation bytes |
| --- | --- |
| NativeResponsibilityPayments | 5,818 |
| ControlledWallet | 1,674 |

Measured by ablation — replacing both `new` expressions with a stub and
recompiling:

| Variant | Runtime | Headroom | Saving |
| --- | --- | --- | --- |
| Current | 23,887 | 689 | — |
| Both factories removed | 16,298 | 8,278 | **7,589** |
| Payments factory only | 18,056 | 6,520 | **5,831** |

So 31.8% of the controller is two other contracts it may never be asked to
deploy.

Optimizer settings are not the lever. At 200 runs the controller is 23,887
bytes; at 50, 23,857; at 1, 23,845. Trading execution gas for 42 bytes buys
nothing.

## Why this was not simply fixed

The two cases are not alike, and the difference is a security property.

**`ControlledWallet` cannot be moved without changing a trust anchor.** Its
constructor requires `controller_ == msg.sender`, so only the controller can
create an account that names the controller. That is what makes
`registeredAccount[account]` mean something: the controller trusts the account
because it deployed it, and `forward` refuses any recipient that is not
registered. Moving the deployment to a factory makes the factory `msg.sender`,
which requires relaxing that check — turning "I deployed this" into "something
I was told to trust deployed this". That is an authority change on a contract
pending independent review, and it is not a change to make in passing.

**`NativeResponsibilityPayments` is different.** Its constructor takes the
controller address and only requires that it has code; it does not require the
caller to be the controller. Anyone can already deploy one naming any
controller. The controller's trust comes from `nativePayments` being set once,
by `createNativePayments`.

## The option worth taking, and what it costs

Extract only the payments factory: **5,831 bytes, headroom 689 → 6,520.**

The controller keeps an immutable factory address given at construction and
calls it, then adopts what comes back. For the adoption to be as safe as
today's `new`, the controller must verify what it adopted:

- the factory's own `codehash` is pinned as an immutable at construction, so
  the factory cannot be swapped and its only code path is
  `new NativeResponsibilityPayments(controller)`;
- the returned adapter answers `controller() == address(this)`;
- the existing one-shot guard stays, so adoption cannot be repeated.

With the factory's code pinned, a rogue adapter cannot be adopted, because the
only thing that can produce one is code fixed at the controller's construction.
`NativeResponsibilityPayments` itself is unchanged.

What it costs, and why it is not free:

- the controller's constructor gains an argument, which reaches the scenario
  kit, the public-testnet runner's artifact list, the SDK's deployment pins,
  the browser deployment manifest and every published artifact digest;
- one more contract to deploy and to include in any review;
- the published evidence document's section 1 digests change, so it must be
  reissued.

## What was done

The payments extraction was taken. `NativePaymentsFactory` holds no state, no
owner and no immutable, so its runtime code is identical at every address and
its hash is a constant recomputable from source. The controller now takes that
factory's address and the code hash it will accept, both immutable, and refuses
at construction if they disagree — so what a deployed controller can adopt is
fixed by its own construction, not by whoever calls `createNativePayments`
first.

| Measure | Before | After |
| --- | --- | --- |
| Controller runtime | 23,887 | **18,311** |
| Headroom | 689 | **6,265** |
| Of EIP-170 | 97.2% | **74.5%** |
| Controller deployment gas | 5,212,144 | **4,014,722** |

The factory costs 1,367,293 gas to deploy once, so total deployment gas rose by
about 170,000 — 3% — while the controller's own deployment fell 23%. That is
the trade, stated rather than buried: one more contract, for room to change the
one that matters.

`test-evm/deployment-budgets.cjs` covers the new rule as a negative case: a hash
that does not match the code at that address is refused, the empty hash is
refused, an address with no code is refused, adoption is one-shot, and what is
adopted answers for this controller.

`ControlledWallet` stays embedded, for the reason above. That is a deliberate
27% of the remaining budget, not an oversight.

## Recommendation

If more room is needed later than 6,265 bytes, the account factory is the next
candidate — but it should be decided together with the independent review, not
before it, because what it changes is the meaning of a registered account.

Until then, 6,265 bytes is the real budget for the controller, and the guard
fails before it is spent.
