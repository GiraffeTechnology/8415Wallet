# 8415wallet standards compatibility

## Product requirement

8415wallet is a general-purpose wallet compatible with existing wallet and
asset standards, with native ERC-8415 support. Its asynchronous projection and
linked-responsibility features are additive. The product is not restricted to
ERC-8415 tokens or specialized-only assets.

Compatibility with existing standards is the product intent. Implementation
claims must still name the exact standard, operation, chain, provider and token
behavior actually exercised. This functional Beta does not claim exhaustive
validation of every existing standard, extension or nonstandard implementation.

## Implemented Beta surfaces and evidence boundaries

| Standard / surface | Implemented scope | Validation boundary |
| --- | --- | --- |
| Native ETH | Balance, verified EOA receive address, exact reviewed EOA transfer | Deterministic provider/journal tests; genuine wallet and chain acceptance recorded per deployed artifact |
| ERC-20 | Explicit token-address balance and owner-reviewed transfer in integer base units; optional metadata is separate from authority | New transfer/session and local-EVM cases; no default unlimited allowance or arbitrary approval flow |
| ERC-721 | Explicit contract/token ID, interface and ownership checks, exact safe transfer | Deterministic provider tests; legacy clearing includes separately reviewed approval of one token to one pinned escrow |
| ERC-1155 | Explicit contract/token ID/amount, interface/balance checks, exact safe transfer | Deterministic provider and recovery cases; no batch discovery claim |
| ERC-165 | Positive and invalid-interface probes where the asset protocol defines them | ERC-721/ERC-1155/native ERC-8415 paths; ERC-20 is not required to advertise ERC-165 |
| ERC-55 | Mixed-case address checksum validation before normalization | Positive/negative SDK and actual-handler regressions; all-lower/all-upper addresses remain format-checked without checksum protection |
| EIP-1193 | Injected provider connection, account/chain changes, explicit wallet requests and numeric 4001 rejection | Deterministic provider tests; no private key, seed import or autonomous signer |
| EIP-712 / ERC-1271 control acceptance | Exact-domain typed linked consent and supported controlled-account signature checks | Native V3 control tests/local EVM; not a claim of arbitrary smart-account compatibility |
| ERC-8415 | Projection/settlement discovery, separate owner/holder/finality/gap observations, begin/finalize/cancel settlement | V2/V3 PRD mapping and SDK/local-EVM regressions; W-20 and genuine deployed wallet/device observations remain separate |

Network recognition currently includes Ethereum, Base, Sepolia and Base
Sepolia for the external-asset panel. Native DApp protocol/control manifests
use their supported testnet set. Legacy clearing also has an explicit local
EVM test profile. Chain recognition does not authorize a transaction or prove
compatibility with every wallet application on that chain.

## Deliberate limits and remaining integrations

- Tokens are selected by explicit contract address; automatic inventory,
  indexer discovery, ENS, swaps, bridges and a marketplace are not supplied.
- External transfers use the supported EOA/injected-provider path. WalletConnect,
  arbitrary account-abstraction/4337 or EIP-7702 signer integration is not
  established by this Beta. The V3 supported controlled-account path is a
  separate, narrowly verified account model.
- External ERC-20 transfers may target contract recipients, but the supported
  native controlled-account contract has no general ERC-20 withdrawal path.
  Do not send tokens there without an independently verified withdrawal path.
- A token address and runtime-code hash bind the observed contract code. They
  do not pin an upgradeable proxy implementation or eliminate issuer/admin
  trust. An exact transfer event is not a guarantee of economic value, fees,
  redeemability or future balance.
- ERC-20 optional name/symbol/decimals metadata is presentation data, not token
  identity, value or signing authority. Amounts bind exact integer units; an
  unavailable metadata field must not silently invent a precision.
- Token extensions, fee-on-transfer/rebasing semantics and unusual transfer
  event behavior require explicit compatibility evidence. A mismatched effect
  must not be reported as successful merely because a transaction hash exists.
- A passing test suite, browser rendering or mainnet-capable code does not
  establish general-release, genuine-wallet/device or independent-audit
  acceptance.

These are current evidence and implementation limits, not a redefinition of
8415wallet as an ERC-8415-exclusive product. Record additional standards and
provider support as it is implemented and tested rather than replacing this
matrix with an unqualified universal claim.
