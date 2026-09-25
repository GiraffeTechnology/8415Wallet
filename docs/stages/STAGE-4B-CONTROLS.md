# Stage 4B — independent responsibility execution contracts

Draft implementation; NOT compiled/tested/deployed/security-audited.
Depends on the independent-kernel/PRD foundation in PR #3. Keep PR #3 and this
stage unmerged until all development is complete and unified validation passes.

Scope: immutable recipient-owned token account, EIP-712/1271 acceptance,
control-owned revision/obligations, atomic transfers, accepted registrar
entry-to-occurrence binding, permanent prefix detachment, bounded reverse
transfers, close/reopen history, separate optional per-leg native payments.
No ERC interface or temporal-finality changes. No keys or chain activity.

Files: the four Solidity sources under `contracts/controls/`.
Payment does not decide completion/callback. Funding follows transfer as a
separate transaction; unfunded state must not be presented as reserved funds.
The accepted registrar and callback authority are explicit trust assumptions,
not automatic legal proof or trustless repeated-address association. Token
proxy upgrade behavior requires deployment-specific review.

Required later: adversarial EVM and integrated W-01–W-21 tests, independent
security review, actual public-testnet deployment/transactions and UI evidence.
Existing tests/earlier Sepolia receipts do not validate this stage.

Development commits use `[skip ci]` solely to implement the user's deferred-CI
order. Do not merge with skipped/pending checks; publish a fresh no-skip commit
after all stages are developed, then validate the exact candidate.
