import type { StaticType } from '../codec/abi.ts';
import { decodeResult, encodeWords } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import type { Address, Bytes32, Instant, TokenId, Version } from './types.ts';

/**
 * The ERC-8415 event surface.
 *
 * Both sequences leave a trace: entries through `RegisterInitialized` and
 * `RegisterSuperseded`, and gap transitions through the four settlement
 * events. The settlement ones matter to a reader because a gap can close
 * without admitting anything — by cancellation or supersession — and that
 * closure appears nowhere in the entry walk. A history built only from
 * entries would show a projection that never moved and give no hint that
 * anything had been attempted.
 */

export type EventDefinition = {
  readonly signature: string;
  /** Types of the indexed parameters, in order, occupying topics 1..3. */
  readonly indexed: readonly StaticType[];
  /** Types of the non-indexed parameters, in order, ABI-encoded in `data`. */
  readonly data: readonly StaticType[];
};

export const EVENT_DEFINITIONS = {
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
} as const satisfies Record<string, EventDefinition>;

export type EventName = keyof typeof EVENT_DEFINITIONS;

/** `topics[0]` for an event: the keccak-256 of its canonical signature. */
export function topicOf(name: EventName): Bytes32 {
  return keccak256Utf8(EVENT_DEFINITIONS[name].signature);
}

/** Encode an indexed value-type parameter as a topic. */
export function encodeTopic(type: StaticType, value: bigint | string | boolean): Bytes32 {
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
export const TOKEN_TOPIC_INDEX: Record<EventName, number> = {
  RegisterInitialized: 1,
  RegisterSuperseded: 1,
  SettlementStarted: 2,
  SettlementFinalized: 2,
  SettlementCancelled: 2,
  SettlementSuperseded: 3,
};

/** A log as it comes off the chain, undecoded. */
export type RawLog = {
  readonly address: Address;
  readonly topics: readonly Bytes32[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly logIndex: bigint;
};

export type LogFilter = {
  readonly address: Address;
  /** `null` matches any value in that position. */
  readonly topics: readonly (Bytes32 | null)[];
};

/** Where a decoded event sat in the chain's own order. */
export type LogPosition = {
  readonly blockNumber: bigint;
  readonly logIndex: bigint;
};

export type Erc8415Event = LogPosition &
  (
    | {
        readonly kind: 'RegisterInitialized';
        readonly tokenId: TokenId;
        readonly recordCommitment: Bytes32;
        readonly holder: Address;
        readonly version: Version;
        readonly effectiveAt: Instant;
      }
    | {
        readonly kind: 'RegisterSuperseded';
        readonly tokenId: TokenId;
        readonly version: Version;
        readonly recordCommitment: Bytes32;
        readonly previousCommitment: Bytes32;
        readonly holder: Address;
        readonly effectiveAt: Instant;
      }
    | {
        readonly kind: 'SettlementStarted';
        readonly settlementId: Bytes32;
        readonly tokenId: TokenId;
        readonly initiator: Address;
        readonly expectedHolder: Address;
        readonly snapshotHash: Bytes32;
        readonly deadline: Instant;
      }
    | {
        readonly kind: 'SettlementFinalized';
        readonly settlementId: Bytes32;
        readonly tokenId: TokenId;
        readonly recordCommitment: Bytes32;
        readonly version: Version;
        readonly effectiveAt: Instant;
      }
    | {
        readonly kind: 'SettlementCancelled';
        readonly settlementId: Bytes32;
        readonly tokenId: TokenId;
        readonly reasonHash: Bytes32;
      }
    | {
        readonly kind: 'SettlementSuperseded';
        readonly supersededId: Bytes32;
        readonly replacementId: Bytes32;
        readonly tokenId: TokenId;
      }
  );

/**
 * Decode a log into an event.
 *
 * Returns `undefined` for a log whose `topics[0]` is not one of these events,
 * rather than guessing: a log the wallet cannot name is not a gap transition
 * it may report.
 */
export function decodeLog(log: RawLog): Erc8415Event | undefined {
  const topic0 = log.topics[0];
  if (topic0 === undefined) return undefined;

  const name = (Object.keys(EVENT_DEFINITIONS) as EventName[]).find(
    (candidate) => topicOf(candidate) === topic0,
  );
  if (name === undefined) return undefined;

  const definition: EventDefinition = EVENT_DEFINITIONS[name];
  if (log.topics.length !== definition.indexed.length + 1) return undefined;

  const indexed = definition.indexed.map((type, position) =>
    decodeResult([type], log.topics[position + 1]!)[0]!,
  );
  const body = definition.data.length === 0 ? [] : decodeResult(definition.data, log.data);
  const position: LogPosition = { blockNumber: log.blockNumber, logIndex: log.logIndex };

  switch (name) {
    case 'RegisterInitialized':
      return {
        ...position,
        kind: name,
        tokenId: indexed[0] as bigint,
        recordCommitment: indexed[1] as Bytes32,
        holder: indexed[2] as Address,
        version: body[0] as bigint,
        effectiveAt: body[1] as bigint,
      };
    case 'RegisterSuperseded':
      return {
        ...position,
        kind: name,
        tokenId: indexed[0] as bigint,
        version: indexed[1] as bigint,
        recordCommitment: indexed[2] as Bytes32,
        previousCommitment: body[0] as Bytes32,
        holder: body[1] as Address,
        effectiveAt: body[2] as bigint,
      };
    case 'SettlementStarted':
      return {
        ...position,
        kind: name,
        settlementId: indexed[0] as Bytes32,
        tokenId: indexed[1] as bigint,
        initiator: indexed[2] as Address,
        expectedHolder: body[0] as Address,
        snapshotHash: body[1] as Bytes32,
        deadline: body[2] as bigint,
      };
    case 'SettlementFinalized':
      return {
        ...position,
        kind: name,
        settlementId: indexed[0] as Bytes32,
        tokenId: indexed[1] as bigint,
        recordCommitment: indexed[2] as Bytes32,
        version: body[0] as bigint,
        effectiveAt: body[1] as bigint,
      };
    case 'SettlementCancelled':
      return {
        ...position,
        kind: name,
        settlementId: indexed[0] as Bytes32,
        tokenId: indexed[1] as bigint,
        reasonHash: indexed[2] as Bytes32,
      };
    case 'SettlementSuperseded':
      return {
        ...position,
        kind: name,
        supersededId: indexed[0] as Bytes32,
        replacementId: indexed[1] as Bytes32,
        tokenId: indexed[2] as bigint,
      };
  }
}

/** Build the per-event filter that selects one token's logs server-side. */
export function tokenFilter(address: Address, name: EventName, tokenId: TokenId): LogFilter {
  const slot = TOKEN_TOPIC_INDEX[name];
  const topics: (Bytes32 | null)[] = [topicOf(name), null, null, null].slice(
    0,
    EVENT_DEFINITIONS[name].indexed.length + 1,
  );
  topics[slot] = encodeTopic('uint256', tokenId);
  return { address, topics };
}
