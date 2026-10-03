/**
 * Presentation helpers.
 *
 * Formatting is display only. Nothing here decides anything, and nothing here
 * is allowed to lose the value it was given.
 */
/** Beyond this, a JavaScript `Date` cannot represent the instant at all. */
const MAX_REPRESENTABLE_SECONDS = 8640000000000n;
/**
 * Render an instant as UTC alongside the integer that was queried.
 *
 * Both, always. An instant is `uint64` seconds on the `block.timestamp` scale,
 * and a formatted time a user cannot resolve back to that integer is not the
 * thing the projection was asked about.
 *
 * A `uint64` reaches far past representable calendar time. That is not a
 * hypothetical: an admitted far-future `effectiveAt` permanently ends a
 * token's projection, so it is a value the wallet exists to show. It is
 * reported as the integer rather than silently rendered as an invalid date.
 */
export function formatInstant(instant) {
    if (instant < 0n || instant > MAX_REPRESENTABLE_SECONDS) {
        return `${instant} (beyond representable calendar time)`;
    }
    const iso = new Date(Number(instant) * 1000).toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC (${instant})`;
}
/**
 * Render a duration in seconds.
 *
 * Signed: a negative remaining time is a deadline that has passed, which is
 * the condition cancellation becomes possible under, so it is shown rather
 * than clamped to zero.
 */
export function formatDuration(seconds) {
    const negative = seconds < 0n;
    let remaining = negative ? -seconds : seconds;
    const days = remaining / 86400n;
    remaining %= 86400n;
    const hours = remaining / 3600n;
    remaining %= 3600n;
    const minutes = remaining / 60n;
    const parts = [];
    if (days > 0n)
        parts.push(`${days}d`);
    if (hours > 0n)
        parts.push(`${hours}h`);
    if (minutes > 0n || parts.length === 0)
        parts.push(`${minutes}m`);
    return `${negative ? '-' : ''}${parts.join(' ')}`;
}
/**
 * Addresses are never truncated.
 *
 * A holder and a position are the two facts a user is here to tell apart, and
 * two different addresses can share a prefix. Abbreviating them would make the
 * one distinction this wallet exists for harder to see.
 */
export function formatAddress(address) {
    return address;
}
/**
 * Commitments, references and settlement ids are abbreviated.
 *
 * These are opaque 32-byte values a user compares rather than reads, and a
 * full one per line would crowd out the values that carry meaning. The full
 * value stays on the view model.
 */
export function shortHex(value, lead = 10, tail = 6) {
    return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
