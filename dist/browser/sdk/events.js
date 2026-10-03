import { decodeResult, encodeWords } from "../codec/abi.js";
import { keccak256Utf8 } from "../codec/keccak.js";
export const EVENT_DEFINITIONS = {
    /**
     * ERC-721's own transfer event.
     *
     * Not an ERC-8415 event, and never treated as one: it moves the tradeable
     * position and says nothing about the projection. It is defined here because
     * finding which tokens an account holds has no other source — ERC-721
     * enumeration is optional and most deployments do not implement it.
     */
    Transfer: {
        signature: 'Transfer(address,address,uint256)',
        indexed: ['address', 'address', 'uint256'],
        data: [],
    },
    RegisterInitialized: {
        signature: 'RegisterInitialized(uint256,bytes32,address,uint64,uint64)',
        indexed: ['uint256', 'bytes32', 'address'],
        data: ['uint64', 'uint64'],
    },
    RegisterSuperseded: {
        signature: 'RegisterSuperseded(uint256,uint64,bytes32,bytes32,address,uint64)',
        indexed: ['uint256', 'uint64', 'bytes32'],
        data: ['bytes32', 'address', 'uint64'],
    },
    SettlementStarted: {
        signature: 'SettlementStarted(bytes32,uint256,address,address,bytes32,uint64)',
        indexed: ['bytes32', 'uint256', 'address'],
        data: ['address', 'bytes32', 'uint64'],
    },
    SettlementFinalized: {
        signature: 'SettlementFinalized(bytes32,uint256,bytes32,uint64,uint64)',
        indexed: ['bytes32', 'uint256', 'bytes32'],
        data: ['uint64', 'uint64'],
    },
    SettlementCancelled: {
        signature: 'SettlementCancelled(bytes32,uint256,bytes32)',
        indexed: ['bytes32', 'uint256', 'bytes32'],
        data: [],
    },
    SettlementSuperseded: {
        signature: 'SettlementSuperseded(bytes32,bytes32,uint256)',
        indexed: ['bytes32', 'bytes32', 'uint256'],
        data: [],
    },
};
/** `topics[0]` for an event: the keccak-256 of its canonical signature. */
export function topicOf(name) {
    return keccak256Utf8(EVENT_DEFINITIONS[name].signature);
}
/** Encode an indexed value-type parameter as a topic. */
export function encodeTopic(type, value) {
    return encodeWords([type], [value]);
}
/**
 * Which topic position carries `tokenId`, per event.
 *
 * It is not the same position in every one: the settlement events lead with
 * the settlement identifier, and `SettlementSuperseded` leads with two of
 * them. Filtering server-side needs the right slot, so the positions are
 * stated here rather than assumed.
 */
export const TOKEN_TOPIC_INDEX = {
    Transfer: 3,
    RegisterInitialized: 1,
    RegisterSuperseded: 1,
    SettlementStarted: 2,
    SettlementFinalized: 2,
    SettlementCancelled: 2,
    SettlementSuperseded: 3,
};
/**
 * Decode a log into an event.
 *
 * Returns `undefined` for a log whose `topics[0]` is not one of these events,
 * rather than guessing: a log the wallet cannot name is not a gap transition
 * it may report.
 */
export function decodeLog(log) {
    const topic0 = log.topics[0];
    if (topic0 === undefined)
        return undefined;
    const name = Object.keys(EVENT_DEFINITIONS).find((candidate) => topicOf(candidate) === topic0);
    if (name === undefined)
        return undefined;
    const definition = EVENT_DEFINITIONS[name];
    if (log.topics.length !== definition.indexed.length + 1)
        return undefined;
    const indexed = definition.indexed.map((type, position) => decodeResult([type], log.topics[position + 1])[0]);
    const body = definition.data.length === 0 ? [] : decodeResult(definition.data, log.data);
    const position = { blockNumber: log.blockNumber, logIndex: log.logIndex };
    switch (name) {
        case 'Transfer':
            return {
                ...position,
                kind: name,
                from: indexed[0],
                to: indexed[1],
                tokenId: indexed[2],
            };
        case 'RegisterInitialized':
            return {
                ...position,
                kind: name,
                tokenId: indexed[0],
                recordCommitment: indexed[1],
                holder: indexed[2],
                version: body[0],
                effectiveAt: body[1],
            };
        case 'RegisterSuperseded':
            return {
                ...position,
                kind: name,
                tokenId: indexed[0],
                version: indexed[1],
                recordCommitment: indexed[2],
                previousCommitment: body[0],
                holder: body[1],
                effectiveAt: body[2],
            };
        case 'SettlementStarted':
            return {
                ...position,
                kind: name,
                settlementId: indexed[0],
                tokenId: indexed[1],
                initiator: indexed[2],
                expectedHolder: body[0],
                snapshotHash: body[1],
                deadline: body[2],
            };
        case 'SettlementFinalized':
            return {
                ...position,
                kind: name,
                settlementId: indexed[0],
                tokenId: indexed[1],
                recordCommitment: indexed[2],
                version: body[0],
                effectiveAt: body[1],
            };
        case 'SettlementCancelled':
            return {
                ...position,
                kind: name,
                settlementId: indexed[0],
                tokenId: indexed[1],
                reasonHash: indexed[2],
            };
        case 'SettlementSuperseded':
            return {
                ...position,
                kind: name,
                supersededId: indexed[0],
                replacementId: indexed[1],
                tokenId: indexed[2],
            };
    }
}
/** Build the per-event filter that selects one token's logs server-side. */
export function tokenFilter(address, name, tokenId) {
    const slot = TOKEN_TOPIC_INDEX[name];
    const topics = [topicOf(name), null, null, null].slice(0, EVENT_DEFINITIONS[name].indexed.length + 1);
    topics[slot] = encodeTopic('uint256', tokenId);
    return { address, topics };
}
