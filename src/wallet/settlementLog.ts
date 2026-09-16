import {
  decodeLog,
  tokenFilter,
  type Erc8415Event,
  type EventName,
} from '../sdk/events.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import type { Bytes32, GapStatus, Instant, TokenId } from '../sdk/types.ts';

/**
 * The gap-transition log for a token.
 *
 * A gap can close three ways and only one of them admits anything. The entry
 * walk shows admissions; cancellations and supersessions leave no trace there
 * at all. Reading them is the only way a user can see that a change was
 * attempted and settled nothing.
 */

/** How a gap ended, and what that means for the projection. */
export type ClosureKind = 'admitted' | 'cancelled' | 'superseded' | 'still-open';

export type GapEpisode = {
  readonly settlementId: Bytes32;
  /**
   * From `settlement(settlementId)`, not from the log.
   *
   * `SettlementStarted` does not carry it — `openedAt` is the block timestamp
   * at which `beginSettlement` succeeded — and it is what bounds the contested
   * interval, so it is read rather than guessed at. `undefined` when the
   * settlement record could not be read.
   */
  readonly openedAt: Instant | undefined;
  readonly deadline: Instant;
  readonly expectedHolder: string;
  readonly initiator: string;
  readonly closure: ClosureKind;
  /** The entry admitted, when the closure was an admission. */
  readonly admitted?: { readonly version: bigint; readonly effectiveAt: Instant };
  /** The settlement that replaced this one, when it was superseded. */
  readonly replacedBy?: Bytes32;
  readonly meaning: string;
};

export type SettlementLogView = {
  readonly tokenId: TokenId;
  readonly available: boolean;
  readonly episodes: readonly GapEpisode[];
  readonly events: readonly Erc8415Event[];
  readonly note: string;
};

const MEANING: Record<ClosureKind, string> = {
  admitted:
    'An entry was appended. Instants before its effective time are now final; ' +
    'instants at or after it are not.',
  cancelled:
    'The contest ended and nothing settled. The preceding entry stays in ' +
    'force and no instant became final. This is not a rejection — the ' +
    'protocol defines no such event.',
  superseded:
    'A new settlement replaced this one. The projection is unchanged, and any ' +
    'proof already produced for this settlement is now unusable.',
  'still-open': 'A change is in flight. Nothing has settled yet.',
};

const NOTE_UNAVAILABLE =
  'This reader cannot fetch logs, so gap transitions cannot be shown. The ' +
  'entry walk still shows every admission, but a gap that closed by ' +
  'cancellation or supersession leaves no trace there and is not visible ' +
  'here either. Absence below is not evidence that none occurred.';

const NOTE_AVAILABLE =
  'Every gap this token has had, and how each ended. A closure that admitted ' +
  'nothing is shown as such; it is not an omission.';

/** `GapStatus` as the contract reports it, mapped to what it means for a reader. */
const CLOSURE_BY_STATUS: Record<GapStatus, ClosureKind> = {
  NONE: 'still-open',
  OPEN: 'still-open',
  ADMITTED: 'admitted',
  CANCELLED: 'cancelled',
  SUPERSEDED: 'superseded',
};

const SETTLEMENT_EVENTS: readonly EventName[] = [
  'SettlementStarted',
  'SettlementFinalized',
  'SettlementCancelled',
  'SettlementSuperseded',
];

/**
 * Read a token's gap transitions and fold them into episodes.
 *
 * When the reader cannot fetch logs the view says so explicitly rather than
 * returning an empty list: an empty list and "cannot be read" are different
 * claims, and only one of them means no gap ever opened.
 */
export async function buildSettlementLog(
  reader: Erc8415Reader,
  tokenId: TokenId,
): Promise<SettlementLogView> {
  if (reader.getLogs === undefined) {
    return { tokenId, available: false, episodes: [], events: [], note: NOTE_UNAVAILABLE };
  }

  const collected: Erc8415Event[] = [];
  for (const name of SETTLEMENT_EVENTS) {
    const logs = await reader.getLogs(tokenFilter(reader.source.address, name, tokenId));
    for (const log of logs) {
      const decoded = decodeLog(log);
      if (decoded !== undefined) collected.push(decoded);
    }
  }
  collected.sort(
    (left, right) =>
      Number(left.blockNumber - right.blockNumber) || Number(left.logIndex - right.logIndex),
  );

  return {
    tokenId,
    available: true,
    episodes: await enrich(reader, foldEpisodes(collected)),
    events: collected,
    note: NOTE_AVAILABLE,
  };
}

/**
 * Take each episode's state from the contract.
 *
 * The log says which settlements existed and carries their details; the
 * contract says what became of each. Where both speak, the contract is
 * authoritative — a log can be truncated by a node's retention, and a status
 * folded from a partial log would be a guess.
 */
async function enrich(
  reader: Erc8415Reader,
  episodes: readonly GapEpisode[],
): Promise<GapEpisode[]> {
  if (reader.settlement === undefined) return [...episodes];

  const enriched: GapEpisode[] = [];
  for (const episode of episodes) {
    try {
      const record = await reader.settlement(episode.settlementId);
      const closure = CLOSURE_BY_STATUS[record.status];
      enriched.push({
        ...episode,
        openedAt: record.openedAt,
        deadline: record.deadline,
        expectedHolder: record.expectedHolder,
        initiator: record.initiator,
        closure,
        meaning: MEANING[closure],
      });
    } catch {
      // The record could not be read. The log-derived episode stands, with
      // openedAt left absent rather than filled in.
      enriched.push(episode);
    }
  }
  return enriched;
}

function foldEpisodes(events: readonly Erc8415Event[]): GapEpisode[] {
  const byId = new Map<Bytes32, GapEpisode>();
  const order: Bytes32[] = [];

  for (const event of events) {
    switch (event.kind) {
      case 'SettlementStarted':
        byId.set(event.settlementId, {
          settlementId: event.settlementId,
          openedAt: undefined,
          deadline: event.deadline,
          expectedHolder: event.expectedHolder,
          initiator: event.initiator,
          closure: 'still-open',
          meaning: MEANING['still-open'],
        });
        order.push(event.settlementId);
        break;
      case 'SettlementFinalized':
        update(byId, event.settlementId, {
          closure: 'admitted',
          admitted: { version: event.version, effectiveAt: event.effectiveAt },
          meaning: MEANING.admitted,
        });
        break;
      case 'SettlementCancelled':
        update(byId, event.settlementId, {
          closure: 'cancelled',
          meaning: MEANING.cancelled,
        });
        break;
      case 'SettlementSuperseded':
        update(byId, event.supersededId, {
          closure: 'superseded',
          replacedBy: event.replacementId,
          meaning: MEANING.superseded,
        });
        break;
      default:
        break;
    }
  }

  return order.flatMap((id) => {
    const episode = byId.get(id);
    return episode === undefined ? [] : [episode];
  });
}

function update(
  byId: Map<Bytes32, GapEpisode>,
  settlementId: Bytes32,
  patch: Partial<GapEpisode>,
): void {
  const existing = byId.get(settlementId);
  // A closure for a settlement whose opening was never seen is dropped rather
  // than invented: the log may have been truncated, and a half-known episode
  // would be a claim the wallet cannot support.
  if (existing !== undefined) byId.set(settlementId, { ...existing, ...patch });
}
