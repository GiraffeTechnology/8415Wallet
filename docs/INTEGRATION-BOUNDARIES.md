# 8415Wallet integration boundaries v1

Status: **NOT_INDEPENDENTLY_AUDITED**. ERC-8415 Beta control acceptance is testnet-only.
The normal DApp enforces supported testnets; direct SDK consumers must enforce
their own network policy. This is not a global SDK mainnet barrier.
This contract describes product behavior, not a release certificate.

## Protocol observations

Keep the ERC-721 tradeable position (`ownerOf`), admitted confirmed holder,
protocol temporal finality (`isFinalAsOf`), open-gap contest and chain freshness
separate. Discover projection and settlement interfaces independently using
the fixed identifiers `0x6309e170` and `0xf4a7d71b`. A failed read remains
unavailable; an instant before the first entry is not covered. Report register,
verification profile and settlement authority without implying approval.

## Forbidden inferences

Never derive the confirmed holder from ownerOf, or temporal finality from
record agreement, confirmation depth, proof verification, cancellation or gap
closure. Record agreement is not verified legal identity or title. Registration
delay is normal and is not a rejection or an automatic remedy. Never display
register contents from a commitment or resolve a locator without entitlement.
Single-token commitment uniqueness does not rule out cross-token collisions.
Watchtower migration continuity must not be assumed.

## Responsibility and optional payment

Standalone use remains independent of linked controls and external products.
In linked use, acceptance covers the exact leg and all still-active upstream
conditions. Commercial completion requires both owner and admitted holder at
the buyer occurrence or later in the accepted chain; addresses are not ordered
positions. Only a completed prefix detaches, permanently. A later callback
cannot cross its boundary or erase projection history. The limit is 128 live
unresolved legs, not lifetime trades. Detached history is verified against its
on-chain commitment rather than trusted from a backend flag.

Payment is optional and cannot authorize completion or return. Settlement and
refunds bind each original payer and exact recipient to one leg. A payment
failure remains due; it never restores detached responsibility. Return requires
an explicitly accepted trigger and actual bounded token movement, not mere lag.

## Execution and recovery

Authenticate chain, account, deployment, nonce, revision, expiry, recipient
acceptance and admitted occurrence evidence. Revalidate dependent observations
atomically on chain. Display reads are snapshots, not execution authority.
Protected accounts must reject alternate paths that discard accepted terms.
Unsupported account/proxy/provider profiles must not be treated as protected.

Persist uncertainty before a wallet send. A hash is not success; reconcile
canonical receipts and expected effects. Never auto-resend after timeouts or
clear an unknown outcome merely because the page restarted. Public journals
must not contain private keys, credentials or raw consent signatures. A direct
numeric EIP-1193 code 4001 is a known request rejection, not a transaction
receipt. Its exact owned claim may clear only after durable cancellation
storage succeeds. Other failures remain uncertain and cannot silently retry.

## Deployment and acceptance

Deployment and testing target CTYun/SIN Linux environments, not Windows hosts.
Keep source, local regression, public-chain receipts, browser/device journeys
and independent security review separate. Historical real testnet transactions
exist; they do not validate every new candidate or close all W-01–W-24 cases.
The package's own build/install checks do not establish release acceptance.
Independent review of the exact contracts, adapters, evidence and signature
verification, recovery and optional payments remains required before general release. Functional-testing Beta artifacts can be built and
handed over while these deployment/device/security results remain uncollected.

## External-account companion and tenant identity

8415wallet is the product and 8415wallet.com is its UI platform domain.
Xiongan is a V2 tenant. The additive EOA interface recognizes Ethereum/Base and their selected
testnets for ETH and standard ERC-721/ERC-1155. This does not establish mainnet responsibility acceptance or turn a controlled-account contract into a general
asset vault. Real assets stay in the user's external EOA; each prepared action
requires a new owner review and genuine-wallet signing/submission. No agent has
keys, a session grant, token approval or an autonomous send route. This companion
is functional-testing Beta code with uncompleted genuine-provider/device and
independent-security evidence; chain support is not production acceptance.
