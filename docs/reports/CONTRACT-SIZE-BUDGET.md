# Contract size budget — the controller is at 97% of the deployable limit

Date: 2026-09-27. Measured at tree `e3ba6c6210fe369a9b46fc49ab6b6054f7f43e16`,
solc 0.8.26, viaIR, optimizer enabled, 200 runs.

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

## Recommendation

Take the payments extraction, and leave `ControlledWallet` embedded. That buys
roughly nine times the headroom while leaving the account trust anchor exactly
as an auditor will find it described.

If more room is needed later than that provides, the account factory is the
next candidate — but it should be decided together with the independent review,
not before it, because what it changes is the meaning of a registered account.

Until either is done, treat 689 bytes as the real budget for the controller.
