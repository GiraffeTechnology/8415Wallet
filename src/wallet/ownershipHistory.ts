import { decodeLog, encodeTopic, topicOf } from '../sdk/events.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import {
  ZERO_ADDRESS,
  type Address,
  type Bytes32,
  type Instant,
  type TokenId,
  type Version,
} from '../sdk/types.ts';

/**
 * Both sequences, on one timeline.
 *
 * ERC-8415 tracks two sequences describing the same asset: the ERC-721
 * ownership sequence, and the register-confirmed holder sequence. Until now
 * this wallet walked one of them and reported the other as a single current
 * value, which is half of what "records both sequences faithfully" means.
 *
 * Sharing an axis is not sharing a meaning, and the distinction is kept:
 *
 * - a position change is dated by the block that recorded it — when *this
 *   chain* learned the token moved;
 * - an entry is dated by `effectiveAt` — when *the register* says its change
 *   took effect, which routinely precedes the block that admitted it.
 *
 * The wallet places them on one scale because the ERC puts register instants
 * on the `block.timestamp` scale precisely so they can be compared. It does
 * not thereby claim they measure the same thing.
 */

export type TimelineEvent =
  | {
      readonly kind: 'position';
      readonly at: Instant;
      readonly blockNumber: bigint;
      readonly from: Address;
      readonly to: Address;
      /** A mint is a position appearing, not a transfer between parties. */
      readonly minted: boolean;
    }
  | {
      readonly kind: 'entry';
      readonly at: Instant;
      readonly version: Version;
      readonly holder: Address;
      readonly recordCommitment: Bytes32;
      /** The block that admitted it, when the log was readable. */
      readonly admittedInBlock: bigint | undefined;
    };

/**
 * A position change and whether the register has since confirmed that party.
 *
 * The correspondence is the wallet's inference, not the protocol's: ERC-8415
 * defines no link between a transfer and the entry that records it, and an
 * entry naming the same party could have a different cause. It is reported as
 * an apparent correspondence and labelled as one.
 */
export type Correspondence = {
  readonly to: Address;
  readonly positionAt: Instant;
  readonly blockNumber: bigint;
  /** The earliest entry naming that party with an effective time at or after the move. */
  readonly apparentEntry: { readonly version: Version; readonly effectiveAt: Instant } | undefined;
  /** `effectiveAt` minus the position's block time, when one was found. */
  readonly lag: bigint | undefined;
  readonly state: 'apparently-registered' | 'outstanding';
};

export type OwnershipHistoryView = {
  readonly tokenId: TokenId;
  /** False when the reader cannot fetch logs, so the position sequence is unavailable. */
  readonly available: boolean;
  /** Both sequences, ordered by instant. */
  readonly timeline: readonly TimelineEvent[];
  readonly positionChanges: number;
  readonly entries: number;
  /** Position changes with no entry naming that party at or after them. */
  readonly outstanding: readonly Correspondence[];
  readonly correspondences: readonly Correspondence[];
  readonly note: string;
  readonly caveat: string;
};

const NOTE_UNAVAILABLE =
  'This reader cannot fetch logs, so the ERC-721 ownership sequence cannot be ' +
  'read and only the projection is shown. That is half the record; an empty ' +
  'position history here is not a statement that the token never moved.';

const NOTE_AVAILABLE =
  'Both sequences the ERC tracks, ordered by instant. A position change is ' +
  'dated by the block that recorded it; an entry by the effective time the ' +
  'register gave it, which routinely precedes the block that admitted it.';

const CAVEAT =
  'Pairing a position change with an entry is this wallet’s inference, not the ' +
  'protocol’s. ERC-8415 defines no link between a transfer and the entry that ' +
  'records it, and an entry naming the same party may have an entirely ' +
  'different cause. Read a correspondence as apparent, and a lag as the ' +
  'interval between two facts rather than the duration of one process.';

export async function buildOwnershipHistory(
  reader: Erc8415Reader,
  tokenId: TokenId,
): Promise<OwnershipHistoryView> {
  const entries = await readEntries(reader, tokenId);

  if (reader.getLogs === undefined || reader.chainInstantAt === undefined) {
    return {
      tokenId,
      available: false,
      timeline: entries.timeline,
      positionChanges: 0,
      entries: entries.timeline.length,
      outstanding: [],
      correspondences: [],
      note: NOTE_UNAVAILABLE,
      caveat: CAVEAT,
    };
  }

  const logs = await reader.getLogs({
    address: reader.source.address,
    topics: [topicOf('Transfer'), null, null, encodeTopic('uint256', tokenId)],
  });

  const positions: Extract<TimelineEvent, { kind: 'position' }>[] = [];
  for (const log of logs) {
    const decoded = decodeLog(log);
    if (decoded?.kind !== 'Transfer') continue;
    positions.push({
      kind: 'position',
      at: await reader.chainInstantAt(decoded.blockNumber),
      blockNumber: decoded.blockNumber,
      from: decoded.from,
      to: decoded.to,
      minted: decoded.from === ZERO_ADDRESS,
    });
  }

  const correspondences = positions.map((position) => correspond(position, entries.records));
  const timeline = [...positions, ...entries.timeline].sort(
    (left, right) => Number(left.at - right.at) || rank(left) - rank(right),
  );

  return {
    tokenId,
    available: true,
    timeline,
    positionChanges: positions.length,
    entries: entries.records.length,
    outstanding: correspondences.filter((item) => item.state === 'outstanding'),
    correspondences,
    note: NOTE_AVAILABLE,
    caveat: CAVEAT,
  };
}

/** Where two events share an instant, the position change is shown first. */
function rank(event: TimelineEvent): number {
  return event.kind === 'position' ? 0 : 1;
}

type EntryRecord = { version: Version; effectiveAt: Instant; holder: Address };

async function readEntries(
  reader: Erc8415Reader,
  tokenId: TokenId,
): Promise<{ records: EntryRecord[]; timeline: Extract<TimelineEvent, { kind: 'entry' }>[] }> {
  const count = await reader.entryCount(tokenId);
  const records: EntryRecord[] = [];
  const timeline: Extract<TimelineEvent, { kind: 'entry' }>[] = [];

  for (let version = 1n; version <= count; version += 1n) {
    const entry = await reader.entryAt(tokenId, version);
    records.push({ version, effectiveAt: entry.effectiveAt, holder: entry.holder });
    timeline.push({
      kind: 'entry',
      at: entry.effectiveAt,
      version,
      holder: entry.holder,
      recordCommitment: entry.recordCommitment,
      admittedInBlock: undefined,
    });
  }
  return { records, timeline };
}

function correspond(
  position: Extract<TimelineEvent, { kind: 'position' }>,
  records: readonly EntryRecord[],
): Correspondence {
  const apparent = records.find(
    (record) => record.holder === position.to && record.effectiveAt >= position.at,
  );

  return {
    to: position.to,
    positionAt: position.at,
    blockNumber: position.blockNumber,
    apparentEntry:
      apparent === undefined
        ? undefined
        : { version: apparent.version, effectiveAt: apparent.effectiveAt },
    lag: apparent === undefined ? undefined : apparent.effectiveAt - position.at,
    state: apparent === undefined ? 'outstanding' : 'apparently-registered',
  };
}
