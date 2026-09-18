import { ContractRevertError } from '../../src/sdk/errors.ts';
import type { Erc8415Reader } from '../../src/sdk/port.ts';
import { ZERO_BYTES32 } from '../../src/sdk/types.ts';
import type { KitFetch } from '../../src/adapters/kit/kitApi.ts';

/**
 * A stand-in for the Kit's projection API.
 *
 * It serves the routes and the wire shapes the Kit's `api/routes.ts` and
 * `api/serialize.ts` define, backed by the same in-memory contract the rest of
 * the suite reads. That is the point: the Kit adapter is then exercised
 * against the API's actual contract — decimal-string integers, a 404 for an
 * instant the projection does not cover, a finality route that answers
 * without reverting — rather than against a shape invented to suit it.
 *
 * It is not a model of the Kit's kernel. Admission, proof verification and gap
 * closure belong to the Kit and are tested there; what is under test here is
 * whether the wallet carries the Kit's answers across faithfully.
 */

export type FakeKitOptions = {
  /** Override the identity the API reports, to model a misrouted backend. */
  readonly registerId?: string;
  readonly verificationProfile?: string;
  /** Fail every request with this status, to model a backend that is down. */
  readonly failWith?: { status: number; error: string };
};

export function fakeKitFetch(reader: Erc8415Reader, options: FakeKitOptions = {}): KitFetch {
  return async (url) => {
    const path = new URL(url).pathname;
    if (options.failWith !== undefined) {
      return response(options.failWith.status, { error: options.failWith.error });
    }
    try {
      return await route(reader, path, options);
    } catch (error) {
      // The Kit reports an uncovered instant as a 404 with a code, the same
      // fact the contract reports as a revert.
      if (error instanceof ContractRevertError) {
        return response(404, { error: 'INSTANT_NOT_COVERED', message: error.message });
      }
      return response(500, { error: 'INTERNAL', message: String(error) });
    }
  };
}

async function route(reader: Erc8415Reader, path: string, options: FakeKitOptions) {
  const segments = path.split('/').filter((part) => part.length > 0);
  if (segments[0] !== 'projection' || segments[1] === undefined) {
    return response(404, { error: 'NOT_FOUND' });
  }
  const tokenId = BigInt(segments[1]);
  const tail = segments.slice(2);

  if (tail.length === 0) {
    const settlementId = (await reader.openGapOf?.(tokenId)) ?? ZERO_BYTES32;
    const openGap =
      settlementId === ZERO_BYTES32 || reader.settlement === undefined
        ? null
        : settlementJson(settlementId, await reader.settlement(settlementId));
    return response(200, {
      registerId: options.registerId ?? (await reader.registerId()),
      verificationProfile:
        options.verificationProfile ?? (await reader.verificationProfile?.()) ?? ZERO_BYTES32,
      tokenId: tokenId.toString(),
      entryCount: Number(await reader.entryCount(tokenId)),
      openGap,
    });
  }

  if (tail[0] === 'entry' && tail[1] === 'version' && tail[2] !== undefined) {
    return response(200, { entry: entryJson(await reader.entryAt(tokenId, BigInt(tail[2]))) });
  }

  if (tail[1] === 'as-of' && tail[2] !== undefined) {
    const instant = BigInt(tail[2]);
    switch (tail[0]) {
      case 'entry':
        return response(200, { entry: entryJson(await reader.entryAsOf(tokenId, instant)) });
      case 'holder':
        return response(200, { holder: await reader.holderAsOf(tokenId, instant) });
      case 'finality':
        return response(200, { final: await reader.isFinalAsOf(tokenId, instant) });
      default:
        return response(404, { error: 'NOT_FOUND' });
    }
  }

  return response(404, { error: 'NOT_FOUND' });
}

function response(status: number, body: unknown) {
  return { status, json: async () => body };
}

/**
 * Wire shapes, copied from the Kit's `api/serialize.ts`.
 *
 * Every integer crosses as a decimal string there, because an instant, a
 * version or a token id can exceed what a JSON number holds exactly. The one
 * exception is `entryCount`, which the Kit sends as a number.
 */
function entryJson(entry: {
  version: bigint;
  holder: string;
  effectiveAt: bigint;
  supersededAt: bigint;
  recordCommitment: string;
  previousCommitment: string;
  registryReference: string;
}) {
  return {
    version: entry.version.toString(),
    holder: entry.holder,
    effectiveAt: entry.effectiveAt.toString(),
    supersededAt: entry.supersededAt.toString(),
    recordCommitment: entry.recordCommitment,
    previousCommitment: entry.previousCommitment,
    registryReference: entry.registryReference,
  };
}

function settlementJson(
  settlementId: string,
  record: {
    tokenId: bigint;
    initiator: string;
    expectedHolder: string;
    snapshotHash: string;
    openedAt: bigint;
    deadline: bigint;
    status: string;
  },
) {
  return {
    settlementId,
    tokenId: record.tokenId.toString(),
    initiator: record.initiator,
    expectedHolder: record.expectedHolder,
    snapshotHash: record.snapshotHash,
    openedAt: record.openedAt.toString(),
    deadline: record.deadline.toString(),
    status: record.status,
  };
}
