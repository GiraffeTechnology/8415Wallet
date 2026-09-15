import { encodeWords } from '../../codec/abi.ts';
import {
  EVENT_DEFINITIONS,
  encodeTopic,
  topicOf,
  type EventName,
  type LogFilter,
  type RawLog,
} from '../../sdk/events.ts';
import type { Address } from '../../sdk/types.ts';
import type { ContractEvent, LoggedEvent } from './events.ts';

/**
 * Encode a modelled event as a raw log.
 *
 * The in-memory adapter holds structured events and could hand them over
 * directly. It encodes them instead, so the wallet's decoder runs on both
 * sides of the wire here exactly as it does against a node. A decoder only
 * ever exercised against hand-written fixtures is a decoder nobody has tested.
 */
export function encodeEvent(logged: LoggedEvent, address: Address): RawLog | undefined {
  const { event } = logged;
  if (event.kind === 'Transfer') {
    // The ERC-721 transfer sequence is real and is recorded, but it is not one
    // of the ERC-8415 events this decoder names.
    return undefined;
  }

  const name: EventName = event.kind;
  const definition = EVENT_DEFINITIONS[name];

  const indexedValues: (bigint | string)[] = [];
  const dataValues: (bigint | string)[] = [];

  switch (event.kind) {
    case 'RegisterInitialized':
      indexedValues.push(event.tokenId, event.recordCommitment, event.holder);
      dataValues.push(event.version, event.effectiveAt);
      break;
    case 'RegisterSuperseded':
      indexedValues.push(event.tokenId, event.version, event.recordCommitment);
      dataValues.push(event.previousCommitment, event.holder, event.effectiveAt);
      break;
    case 'SettlementStarted':
      indexedValues.push(event.settlementId, event.tokenId, event.initiator);
      dataValues.push(event.expectedHolder, event.snapshotHash, event.deadline);
      break;
    case 'SettlementFinalized':
      indexedValues.push(event.settlementId, event.tokenId, event.recordCommitment);
      dataValues.push(event.version, event.effectiveAt);
      break;
    case 'SettlementCancelled':
      indexedValues.push(event.settlementId, event.tokenId, event.reasonHash);
      break;
    case 'SettlementSuperseded':
      indexedValues.push(event.supersededId, event.replacementId, event.tokenId);
      break;
  }

  return {
    address,
    topics: [
      topicOf(name),
      ...definition.indexed.map((type, position) => encodeTopic(type, indexedValues[position]!)),
    ],
    data: definition.data.length === 0 ? '0x' : encodeWords(definition.data, dataValues),
    blockNumber: logged.blockNumber,
    logIndex: logged.logIndex,
  };
}

/** Apply a topic filter the way a node would: position by position, `null` matching anything. */
export function matchesFilter(log: RawLog, filter: LogFilter): boolean {
  if (log.address.toLowerCase() !== filter.address.toLowerCase()) return false;
  return filter.topics.every((topic, position) => {
    if (topic === null || topic === undefined) return true;
    return log.topics[position] === topic;
  });
}

/** Encode a contract's whole log, dropping events this decoder does not name. */
export function encodeLog(
  entries: readonly LoggedEvent[],
  address: Address,
): readonly RawLog[] {
  return entries.flatMap((logged) => {
    const encoded = encodeEvent(logged, address);
    return encoded === undefined ? [] : [encoded];
  });
}

export type { ContractEvent };
