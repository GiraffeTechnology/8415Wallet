# Standalone signer account binding

The standalone settlement signer now checks the provider's currently selected
account on every send, rather than treating its construction-time account as
permanent authorization. Account changes, revoked access, malformed discovery
and discovery failures do not reach `eth_sendTransaction`. A retained secondary
account is not treated as the selected account. Address casing is normalized.

The chain is checked again after asynchronous account discovery and included in
the transaction request. The provider remains responsible for enforcing the
explicit sender and chain at its signing prompt: sequential RPC checks are not
an atomic lock on provider state. This does not replace contract authorization,
transaction revalidation or user approval, and never retries an uncertain send.

Wire fields are captured before the first provider await; caller mutation cannot
replace the reviewed recipient/calldata/account/chain while discovery is pending.

Six focused regression cases accompany this change. They have not been run by
this development slice. No public-chain transaction, deployment or UI acceptance
is claimed. CI and merge remain a separate release-owner step; deployment and
test execution are limited to CTYun/SIN Linux, not Windows.
