# Genuine-provider pending nonce compatibility

The Linux genuine MetaMask 13.50.0 acceptance run against base commit
`cbc3ad7217fd5066b6b97a2c2f017683a38532f2` connected and rendered assets,
but refused account creation before requesting a signature with
`CONTROL_RPC_QUANTITY_REFUSED`.

An independent read through that same genuine provider observed numeric `0`
for `eth_getTransactionCount(address, "pending")`, while `"latest"` returned
the canonical string `"0x0"`. Diagnostic SHA-256:
`bb6b11e87acbb942c7c285161b5ca557553369e85b67fbc0d2ea53a56a75e442`.
No transaction was sent by the failed account-creation attempt.

The fix is limited to the pending-nonce read at the two explicit submission
boundaries. Canonical hexadecimal strings remain supported. A numeric value
must be a nonnegative safe integer, excluding negative zero, before lossless
conversion to bigint. Fractions, negative/unsafe/nonfinite numbers and
malformed/coercible values remain refused. Receipt, block, chain and other
quantity parsers remain unchanged. Journaling and exact outbound nonce binding
remain before the single send; no retry path is added.

The new regression covers both submission paths, zero/nonzero wallet numbers,
canonical strings, malformed values, no-send/no-journal rejection, and the
unchanged strict receipt parser. Linux execution results and the repaired
genuine-provider run must be reported against their actual commit/tree.
This source note alone claims no test pass, CI success, independent review,
merge or product acceptance. Contracts and protocol semantics are unchanged.
