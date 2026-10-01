import type { Erc8415Reader } from '../sdk/port.ts';
import { detectConformance } from '../sdk/conformance.ts';
import { ContractIdentityPin } from '../sdk/identity.ts';
import { ProjectionNotInitialized } from '../sdk/errors.ts';
import type { Bytes32, TokenId, Version } from '../sdk/types.ts';

/**
 * Collisions the protocol does not prevent.
 *
 * Commitment and `registryReference` uniqueness is enforced **per token**. One
 * off-chain register entry can therefore back the confirmed-holder claim on
 * two separate tokens at once, and every invariant on each token individually
 * still holds — a single-token audit surfaces nothing at all. The ERC assigns
 * detection here: downstream indexers should surface such collisions rather
 * than expect the contract to reject them.
 *
 * The check has a hard limit and says so: it compares the tokens it was given.
 * Finding none is not evidence that none exists, only that none exists among
 * those. A wallet that let "no collisions found" read as "no collisions" would
 * be making exactly the claim the protocol declined to make.
 */

export type CollisionKind = 'recordCommitment' | 'registryReference';

export type CollisionOccurrence = {
  readonly tokenId: TokenId;
  readonly version: Version;
};

export type Collision = {
  readonly kind: CollisionKind;
  readonly value: Bytes32;
  /** Every place the value was seen, across the tokens examined. */
  readonly occurrences: readonly CollisionOccurrence[];
  /** True when the occurrences span more than one token. */
  readonly crossToken: boolean;
  readonly note: string;
};

export type CollisionReport = {
  readonly tokensExamined: readonly TokenId[];
  readonly entriesExamined: number;
  readonly collisions: readonly Collision[];
  readonly scopeNote: string;
};

const SCOPE_NOTE =
  'This compares only the tokens it was given. Finding no collision here is not ' +
  'evidence that none exists — the protocol enforces uniqueness per token only, ' +
  'and a register entry reused on a token outside this set would be invisible to ' +
  'a single-token audit and to this one. These are sequential live reads, not ' +
  'an atomic snapshot, proof of legal identity or authority to send a transaction.';

/** Work limits for one interactive scan, not protocol or chain-lifetime limits. */
export const COLLISION_SCAN_MAX_TOKENS = 32;
export const COLLISION_SCAN_MAX_ENTRIES = 2048;

export class CollisionScanError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CollisionScanError';
    this.code = code;
  }
}

const NOTE_COMMITMENT =
  'The same record commitment backs entries on more than one token. Under the ' +
  'protocol every one of those tokens is individually well formed. An application ' +
  'that assumes a register entry maps to one live asset should treat this as a ' +
  'finding and resolve it with the registrar.';

const NOTE_REFERENCE =
  'The same registry reference appears on more than one token. The reference is ' +
  'an opaque locator the wallet never interprets, so this may be legitimate for ' +
  'this register — or it may be one record backing two assets. The protocol does ' +
  'not distinguish the two cases, and neither can this wallet.';

/**
 * Compare commitments and references across several tokens.
 *
 * Reports repeats within a single token too. Those should be impossible under
 * invariant 4, so seeing one means the contract is not conforming — worth
 * surfacing rather than filtering out as uninteresting.
 */
export async function detectCollisions(
  reader: Erc8415Reader,
  tokenIds: readonly TokenId[],
  options: { readonly identityPin?: ContractIdentityPin } = {},
): Promise<CollisionReport> {
  if (!Array.isArray(tokenIds) || tokenIds.length === 0 || tokenIds.length > COLLISION_SCAN_MAX_TOKENS) {
    throw new CollisionScanError('COLLISION_TOKEN_BUDGET_REFUSED');
  }
  // Copy before the first await; caller mutation must not alter the review set.
  const tokens: TokenId[] = [];
  const unique = new Set<TokenId>();
  for (let index = 0; index < tokenIds.length; index++) {
    const id = tokenIds[index];
    if (typeof id !== 'bigint' || id < 0n || id >= 1n << 256n) {
      throw new CollisionScanError('COLLISION_TOKEN_ID_REFUSED');
    }
    if (unique.has(id)) throw new CollisionScanError('COLLISION_DUPLICATE_TOKEN_REFUSED');
    unique.add(id); tokens.push(id);
  }
  const identity = options.identityPin ?? new ContractIdentityPin(reader);
  const conformance = await detectConformance(reader);
  await identity.read(conformance);
  const commitments = new Map<Bytes32, CollisionOccurrence[]>();
  const references = new Map<Bytes32, CollisionOccurrence[]>();
  let entriesExamined = 0;

  for (const tokenId of tokens) {
    const count = await reader.entryCount(tokenId);
    if (typeof count !== 'bigint' || count < 0n || count >= 1n << 64n) {
      throw new CollisionScanError('COLLISION_ENTRY_COUNT_REFUSED');
    }
    if (count === 0n) throw new ProjectionNotInitialized(tokenId);
    if (count > BigInt(COLLISION_SCAN_MAX_ENTRIES - entriesExamined)) {
      throw new CollisionScanError('COLLISION_ENTRY_BUDGET_REFUSED');
    }
    for (let version = 1n; version <= count; version += 1n) {
      const entry = await reader.entryAt(tokenId, version);
      entriesExamined += 1;
      record(commitments, entry.recordCommitment, { tokenId, version });
      record(references, entry.registryReference, { tokenId, version });
    }
  }

  await identity.read(await detectConformance(reader));

  return {
    tokensExamined: tokens,
    entriesExamined,
    collisions: [
      ...gather(commitments, 'recordCommitment', NOTE_COMMITMENT),
      ...gather(references, 'registryReference', NOTE_REFERENCE),
    ],
    scopeNote: SCOPE_NOTE,
  };
}

function record(
  index: Map<Bytes32, CollisionOccurrence[]>,
  value: Bytes32,
  occurrence: CollisionOccurrence,
): void {
  const existing = index.get(value);
  if (existing === undefined) index.set(value, [occurrence]);
  else existing.push(occurrence);
}

function gather(
  index: Map<Bytes32, CollisionOccurrence[]>,
  kind: CollisionKind,
  note: string,
): Collision[] {
  const found: Collision[] = [];
  for (const [value, occurrences] of index) {
    if (occurrences.length < 2) continue;
    const tokens = new Set(occurrences.map((occurrence) => occurrence.tokenId));
    found.push({
      kind,
      value,
      occurrences,
      crossToken: tokens.size > 1,
      note: tokens.size > 1 ? note : `${note} These occurrences are on one token, which invariant 4 forbids: the contract is not conforming.`,
    });
  }
  return found;
}
