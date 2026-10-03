/**
 * Minimal ABI codec for the ERC-8415 read surface.
 *
 * Every argument and return value the wallet reads is a static type, including
 * both structs — `RegisterEntry` and `Settlement` are tuples of statics, so
 * they encode inline as consecutive words with no head/tail split. That keeps
 * this codec to fixed 32-byte words and no offset arithmetic.
 *
 * `finalizeSettlement` takes `bytes calldata proofData`, so `encodeCallWithTail`
 * handles a head/tail split for dynamic `bytes`. It is the only dynamic type
 * the ERC-8415 surface uses.
 */
import { ValueOutOfRangeError } from "../sdk/errors.js";
import { selectorOf } from "../sdk/interfaceIds.js";
const WORD_HEX = 64;
function stripPrefix(hex) {
    return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}
function requireHex(value, bytes, what) {
    const body = stripPrefix(value).toLowerCase();
    if (body.length !== bytes * 2 || !/^[0-9a-f]*$/.test(body)) {
        throw new ValueOutOfRangeError(`${what} (expected ${bytes} bytes, got ${value})`, 0n);
    }
    return body;
}
function encodeUint(value, bits, what) {
    if (value < 0n || value >= 1n << BigInt(bits)) {
        throw new ValueOutOfRangeError(`${what} as uint${bits}`, value);
    }
    return value.toString(16).padStart(WORD_HEX, '0');
}
function encodeWord(type, value) {
    switch (type) {
        case 'uint256':
            return encodeUint(value, 256, 'value');
        case 'uint64':
            return encodeUint(value, 64, 'value');
        case 'uint8':
            return encodeUint(value, 8, 'value');
        case 'bool':
            return (value ? 1n : 0n).toString(16).padStart(WORD_HEX, '0');
        case 'address':
            return requireHex(value, 20, 'address').padStart(WORD_HEX, '0');
        case 'bytes32':
            return requireHex(value, 32, 'bytes32');
        case 'bytes4':
            // Short byte types are left-aligned, unlike numbers and addresses.
            return requireHex(value, 4, 'bytes4').padEnd(WORD_HEX, '0');
    }
}
function decodeWord(type, word) {
    switch (type) {
        case 'uint256':
        case 'uint64':
        case 'uint8':
            return BigInt(`0x${word}`);
        case 'bool':
            return BigInt(`0x${word}`) !== 0n;
        case 'address':
            return `0x${word.slice(24)}`;
        case 'bytes32':
            return `0x${word}`;
        case 'bytes4':
            return `0x${word.slice(0, 8)}`;
    }
}
/** Build `eth_call` data: four-byte selector followed by one word per argument. */
export function encodeCall(signature, argumentTypes, args) {
    if (argumentTypes.length !== args.length) {
        throw new ValueOutOfRangeError(`argument count for ${signature} (expected ${argumentTypes.length}, got ${args.length})`, 0n);
    }
    const words = argumentTypes.map((type, index) => encodeWord(type, args[index]));
    return `${selectorOf(signature)}${words.join('')}`;
}
/** Encode static values as consecutive 32-byte words, with no selector. */
export function encodeWords(types, values) {
    return `0x${types.map((type, index) => encodeWord(type, values[index])).join('')}`;
}
/**
 * Decode a return payload of static types.
 *
 * A payload shorter than the declared types is rejected rather than
 * zero-filled: a truncated response must not become a plausible-looking answer.
 */
export function decodeResult(types, data) {
    const body = stripPrefix(data).toLowerCase();
    if (body.length < types.length * WORD_HEX) {
        throw new ValueOutOfRangeError(`return payload for ${types.length} word(s) (got ${body.length / 2} bytes)`, 0n);
    }
    return types.map((type, index) => decodeWord(type, body.slice(index * WORD_HEX, (index + 1) * WORD_HEX)));
}
/** Field order of `IRegisterProjection.RegisterEntry`. */
export const REGISTER_ENTRY_TYPES = [
    'bytes32', // recordCommitment
    'bytes32', // previousCommitment
    'bytes32', // registryReference
    'address', // holder
    'uint64', // version
    'uint64', // effectiveAt
    'uint64', // supersededAt
];
/** Field order of `IProjectionSettlement.Settlement`. */
export const SETTLEMENT_TYPES = [
    'uint256', // tokenId
    'address', // initiator
    'address', // expectedHolder
    'bytes32', // snapshotHash
    'uint64', // openedAt
    'uint64', // deadline
    'uint8', // status
];
const WORD_BYTES = 32;
/**
 * Encode a call whose arguments may include dynamic `bytes`.
 *
 * Static arguments sit in the head in place; each `bytes` argument puts a
 * byte offset in the head and its length-prefixed, right-padded contents in
 * the tail. Offsets are measured from the start of the argument block, after
 * the selector.
 */
export function encodeCallWithTail(signature, argumentTypes, args) {
    if (argumentTypes.length !== args.length) {
        throw new ValueOutOfRangeError(`argument count for ${signature} (expected ${argumentTypes.length}, got ${args.length})`, 0n);
    }
    const head = [];
    const tail = [];
    let tailBytes = 0;
    const headBytes = argumentTypes.length * WORD_BYTES;
    for (const [index, type] of argumentTypes.entries()) {
        const value = args[index];
        if (type !== 'bytes') {
            head.push(encodeWord(type, value));
            continue;
        }
        head.push(encodeUint(BigInt(headBytes + tailBytes), 256, 'offset'));
        const encoded = encodeBytes(value);
        tail.push(encoded);
        tailBytes += encoded.length / 2;
    }
    return `${selectorOf(signature)}${head.join('')}${tail.join('')}`;
}
/** Length word followed by the contents, right-padded to a whole number of words. */
function encodeBytes(value) {
    const body = stripPrefix(value).toLowerCase();
    if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) {
        throw new ValueOutOfRangeError(`bytes payload ${JSON.stringify(value)}`, 0n);
    }
    const byteLength = body.length / 2;
    const padded = body.padEnd(Math.ceil(byteLength / WORD_BYTES) * WORD_BYTES * 2, '0');
    return `${encodeUint(BigInt(byteLength), 256, 'bytes length')}${padded}`;
}
