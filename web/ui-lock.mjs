// One page-wide operation at a time across both custody boundaries. Provider
// connection events still invalidate sessions while an operation is in flight.
let held = null;
export function acquireWalletUi() { if (held !== null) return null; held = Symbol('wallet-operation'); return held; }
export function releaseWalletUi(token) { if (held === token) held = null; }
export function walletUiBusy() { return held !== null; }
