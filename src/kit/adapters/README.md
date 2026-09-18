# adapters/

`EthereumChainAdapter` requires `applicationRoot: { contract, callData }`.
The configured getter must return exactly one bytes32 SHA-256 admission-tree
root. `refresh()` reads it with `eth_call` pinned to the canonical finalized
block hash (EIP-1898). The RPC must support that block selector. The generic
`stateRootAt` port returns this **application root**, never Ethereum's block
`stateRoot`, which belongs to a different tree format.

The RPC and configured root-publishing contract are trust dependencies. The Kit
does not independently verify Ethereum MPT/storage proofs. Tests exercise the
RPC request/response boundary using a fake node; deployment and live-chain
contract integration remain undelivered Stage 3 work.
