/**
 * Keccak-256, as used by Ethereum for function selectors and interface ids.
 *
 * This is original Keccak (pad byte `0x01`), not FIPS-202 SHA3-256 (pad byte
 * `0x06`). Node's `crypto` offers the latter only, and the two produce
 * different digests, so the wallet carries its own implementation rather than
 * silently using the wrong one.
 *
 * The wallet needs this for exactly one job: deriving function selectors so it
 * can call a contract, and XOR-folding them to check an ERC-165 interface id.
 * It never hashes register content — the chain carries commitments the wallet
 * only compares, never recomputes.
 */
const MASK = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1600 bits of state minus 512 bits of capacity
const ROUND_CONSTANTS = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Rho rotation offsets, indexed by lane `x + 5y`. */
const ROTATION_OFFSETS = [
    0n, 1n, 62n, 28n, 27n,
    36n, 44n, 6n, 55n, 20n,
    3n, 10n, 43n, 25n, 39n,
    41n, 45n, 15n, 21n, 8n,
    18n, 2n, 61n, 56n, 14n,
];
function rotateLeft(lane, offset) {
    if (offset === 0n)
        return lane;
    return ((lane << offset) | (lane >> (64n - offset))) & MASK;
}
/** Keccak-f[1600] permutation, in place. */
function permute(state) {
    const c = new Array(5);
    const d = new Array(5);
    const b = new Array(25);
    for (const roundConstant of ROUND_CONSTANTS) {
        // Theta
        for (let x = 0; x < 5; x += 1) {
            c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        }
        for (let x = 0; x < 5; x += 1) {
            d[x] = c[(x + 4) % 5] ^ rotateLeft(c[(x + 1) % 5], 1n);
        }
        for (let y = 0; y < 5; y += 1) {
            for (let x = 0; x < 5; x += 1) {
                state[x + 5 * y] = state[x + 5 * y] ^ d[x];
            }
        }
        // Rho and Pi
        for (let y = 0; y < 5; y += 1) {
            for (let x = 0; x < 5; x += 1) {
                const source = x + 5 * y;
                const target = y + 5 * ((2 * x + 3 * y) % 5);
                b[target] = rotateLeft(state[source], ROTATION_OFFSETS[source]);
            }
        }
        // Chi
        for (let y = 0; y < 5; y += 1) {
            for (let x = 0; x < 5; x += 1) {
                state[x + 5 * y] =
                    b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]) & MASK;
            }
        }
        // Iota
        state[0] = state[0] ^ roundConstant;
    }
}
/** Keccak-256 digest of `message`. */
export function keccak256(message) {
    const state = new Array(25).fill(0n);
    // Pad10*1 with the Keccak domain byte.
    const padded = new Uint8Array(Math.ceil((message.length + 1) / RATE_BYTES) * RATE_BYTES);
    padded.set(message);
    padded[message.length] = 0x01;
    padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;
    // Absorb.
    for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
        for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
            let value = 0n;
            for (let byte = 7; byte >= 0; byte -= 1) {
                value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]);
            }
            state[lane] = state[lane] ^ value;
        }
        permute(state);
    }
    // Squeeze: 32 bytes fit inside the rate, so one squeeze is enough.
    const digest = new Uint8Array(32);
    for (let lane = 0; lane < 4; lane += 1) {
        let value = state[lane];
        for (let byte = 0; byte < 8; byte += 1) {
            digest[lane * 8 + byte] = Number(value & 0xffn);
            value >>= 8n;
        }
    }
    return digest;
}
/** Keccak-256 of a UTF-8 string, as a `0x`-prefixed lowercase hex digest. */
export function keccak256Utf8(message) {
    return `0x${Array.from(keccak256(new TextEncoder().encode(message)), b => b.toString(16).padStart(2, '0')).join('')}`;
}
