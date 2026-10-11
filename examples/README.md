# ERC-8415 discussion examples

Selected TypeScript implementation excerpts and three small offline models addressing
questions in the [ERC-8415 discussion](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634).
The excerpts included here are readable without access to the private wallet source.
The models illustrate specific boundaries; they are not a complete wallet, production
integration, security audit, or evidence of a live deployment.

## 1. Keep status signals separate

Discussion: [pending-state UX, post 2](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/2),
[follow-up, post 5](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/5),
and [freshness/finality, post 13](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/13).

- [Exact TypeScript excerpts](status-signals.excerpts.md) read the ERC-721 position,
  admitted holder, `isFinalAsOf` answer and gap as separate facts.
- [Adapted model and tests](status-signals.test.mjs) show that reorg-safe does not make
  a provisional answer final, stale does not revoke a final historical answer, and
  neither owner agreement nor gap closure establishes finality.
- An open gap means registration is pending. It does not itself mean failure. The
  fixture assumes a settlement-capable projection and omits unsupported interfaces,
  failed RPC reads, proof verification and registrar contact information.
- Freshness is a separate optional watchtower observation. It is not the ERC's temporal
  finality signal. No watchtower maintenance or key-rotation implementation is included.

## 2. Show a custody policy without claiming clawback authority

Discussion: [unwinding, post 10](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/10)
and [custody/authorization boundary, post 29](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/29).

- The [independently written decision model](escrow-terms.test.mjs) evaluates synthetic
  facts for a pre-agreed custody arrangement: whether a recipient matches, a new record
  was observed, and its effective date is within the accepted terms.
- This model allows release when those conditions hold, or return after a strictly passed
  deadline when they do not. Satisfied terms take precedence over the elapsed deadline.
  A cancelled gap is not itself rejection or a reason to return an asset.
- When a required observation is unavailable, this model waits. That is a deliberate
  illustrative policy, not a claim about the private wallet contract's behavior.
- The asset must already be held under enforceable custody terms. This model cannot
  reclaim a freely transferred third-party NFT. It supplies no signing, custody, payment,
  contract, transaction or failure-recovery implementation.

No wallet Solidity code is copied into these examples. These JavaScript tests do not
prove EVM atomicity, rollback, transfer safety or compatibility with a deployed contract.

## 3. Surface bounded cross-token reuse without overstating it

Discussion: [collision concern, post 24](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/24)
and [response, post 25](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/25).

- [Exact TypeScript excerpts](reuse-scan.excerpts.md) show 32-token/2,048-entry work
  limits and indexing of commitments and references.
- [Adapted model and tests](reuse-scan.test.mjs) report cross-token repeated values,
  the supplied token set and the number of entries examined.
- Reuse across tokens is a finding, not by itself proof of invalidity. A repeated
  `registryReference` may be legitimate for its profile.
  [Invariant 4](https://github.com/GiraffeTechnology/ERC-8415/blob/5d65d65b0f788abc13c0eb0469500211efddf1c9/ERCS/erc-8415-asynchronous-register-projection.md#L69-L75)
  requires commitment uniqueness within one token, while
  [registry references are profile-defined locators](https://github.com/GiraffeTechnology/ERC-8415/blob/5d65d65b0f788abc13c0eb0469500211efddf1c9/ERCS/erc-8415-asynchronous-register-projection.md#L48).
- The adaptation does not copy the original reporter's claim that same-token reference
  reuse violates invariant 4. It is not a complete conformance checker, and its fixture
  labels are not on-chain `bytes32` encodings.
- No finding means only no cross-token repeat in this input. Sequential RPC scans are
  non-atomic; these tests do not exercise RPC failure, identity drift, proof verification
  or the source scanner's remaining input protections. No security guarantee follows.

## Record-date claims: public external reference

For the [same-transaction discussion, posts 30–34](https://ethereum-magicians.org/t/erc-8415-asynchronous-register-projection-for-nfts/29634/30),
see the public [Kit RecordDateClaim.sol example](https://github.com/GiraffeTechnology/ERC8415-Kit/blob/2ccc328b07a89b678c636127c91d0962c579fe7c/contracts/examples/RecordDateClaim.sol)
and its [on-chain tests](https://github.com/GiraffeTechnology/ERC8415-Kit/blob/2ccc328b07a89b678c636127c91d0962c579fe7c/tests/onchain/recordDateClaim.onchain.cjs).
They cover a same-block gap, confirmation strictly after a record date, a single payout,
and payment to the historical holder after a later transfer. Waiting while a gap is open
is that consumer's additional policy; it does not make an already-final date non-final.
The Kit is external, linked only, and remains governed by its own terms.

## Run the offline models

Use Node.js 22 or later. No dependencies, accounts or network access are needed by the
tests. From the repository root:

```sh
node --test examples/*.test.mjs
```

Expected: 14 tests, 14 pass, 0 fail. These tests execute only the three JavaScript models.
They do not execute the quoted TypeScript, upstream test suites, an EVM or a live wallet,
and they neither deploy nor transfer assets.

## Non-commercial permission

Individuals and research or educational institutions may download and use this example
code for non-commercial purposes, including personal study, research and teaching,
under [LICENSE, Section 4](../LICENSE). This grant covers only material its rights holder
owns or is authorized to license under those terms. It does not extend to the rest of
the wallet or grant commercial-use or redistribution rights for covered material.
Retain applicable notices. Existing independent rights and valid prior permissions remain
governed by their own terms. Installation packages retain their existing trial terms
and accompanying licenses; this example-code permission does not modify them.

## Provenance and notices

The six verbatim TypeScript blocks were selected from the private
`GiraffeTechnology/8415Wallet-Code` repository at commit
`de79227f0b886d86d674a70d67d5608576c8156c`. Each included block identifies its source
path and line range. [source-excerpts.json](source-excerpts.json) records hashes of those
exact excerpt bytes. The code blocks are unchanged; their dependencies and surrounding
implementation are intentionally omitted. They are not standalone source files.

The status and reuse test files are explicitly adapted local models. The custody decision
model was independently written for this example set and is not a port of a wallet
contract. These examples and explanations were prepared on 2026-10-11.

The source notice accompanying the copied TypeScript portions is preserved in
[8415Wallet-Code-LICENSE.txt](notices/8415Wallet-Code-LICENSE.txt). The selected TypeScript
files have no file-level SPDX notices. Their inclusion does not assert a blanket
open-source grant. The additional non-commercial permission above applies only within
its stated scope; the source attribution and any valid independent rights are preserved.
