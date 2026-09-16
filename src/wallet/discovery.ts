import { decodeLog, encodeTopic, topicOf } from '../sdk/events.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import { ZERO_ADDRESS, type Address, type TokenId } from '../sdk/types.ts';

/**
 * Which tokens an account holds.
 *
 * Every other entry point in this wallet takes a `tokenId`, which assumes the
 * caller already knows what to look at. A holder does not: they have an
 * account. Monitoring assets you cannot enumerate is not monitoring.
 *
 * ERC-721 enumeration is optional and most deployments omit it, so this scans
 * `Transfer` logs for the account and then confirms each candidate against
 * `ownerOf`. The log tells you what was ever received; only `ownerOf` tells you
 * what is held now.
 *
 * Its limits are real and are reported rather than hidden: it needs a log
 * reader, and it sees only what the node's retention still serves.
 */

export type HeldToken = {
  readonly tokenId: TokenId;
  /** Confirmed against `ownerOf` at the time of the scan. */
  readonly owner: Address;
  /** Whether the projection has any entries for it. */
  readonly hasProjection: boolean;
};

export type DiscoveryReport = {
  readonly account: Address;
  readonly available: boolean;
  readonly held: readonly HeldToken[];
  /** Seen in the logs as received, but held by someone else now. */
  readonly movedOn: readonly TokenId[];
  readonly note: string;
};

const NOTE_UNAVAILABLE =
  'This reader cannot fetch logs, so tokens cannot be discovered from an ' +
  'account. Supply token identifiers directly. An empty result here is not a ' +
  'statement that the account holds nothing.';

const NOTE_AVAILABLE =
  'Discovered by scanning ERC-721 Transfer logs for this account and then ' +
  'confirming each candidate against ownerOf. It sees only what the node still ' +
  'serves: a log range trimmed by retention would hide a token, so an empty ' +
  'result is not proof the account holds none.';

export async function discoverHeldTokens(
  reader: Erc8415Reader,
  account: Address,
): Promise<DiscoveryReport> {
  if (reader.getLogs === undefined) {
    return { account, available: false, held: [], movedOn: [], note: NOTE_UNAVAILABLE };
  }

  // Transfer(address indexed from, address indexed to, uint256 indexed tokenId):
  // filtering on the `to` slot finds everything this account ever received.
  const received = await reader.getLogs({
    address: reader.source.address,
    topics: [topicOf('Transfer'), null, encodeTopic('address', account)],
  });

  const candidates = new Set<TokenId>();
  for (const log of received) {
    const decoded = decodeLog(log);
    if (decoded?.kind === 'Transfer') candidates.add(decoded.tokenId);
  }

  const held: HeldToken[] = [];
  const movedOn: TokenId[] = [];
  for (const tokenId of [...candidates].sort((left, right) => (left < right ? -1 : 1))) {
    let owner: Address;
    try {
      owner = await reader.ownerOf(tokenId);
    } catch {
      // Burned, or never really there. Not held either way.
      continue;
    }
    if (owner !== account || owner === ZERO_ADDRESS) {
      movedOn.push(tokenId);
      continue;
    }
    held.push({ tokenId, owner, hasProjection: (await reader.entryCount(tokenId)) > 0n });
  }

  return { account, available: true, held, movedOn, note: NOTE_AVAILABLE };
}
