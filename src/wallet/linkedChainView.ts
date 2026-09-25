import type {
  LinkedAsset, LinkedControlReader, LinkedChainSnapshot, LinkedCompletionEvidence, LinkedLeg,
} from '../sdk/linked.ts';
import { ZERO_ADDRESS, ZERO_BYTES32, type Bytes32 } from '../sdk/types.ts';

export class LinkedChainInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'LinkedChainInputError';
    this.code = code;
  }
}

export type LinkedChainView = {
  readonly asset: LinkedAsset;
  readonly sequenceId: Bytes32;
  readonly revision: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: Bytes32;
  readonly evidenceStatus: 'bound' | 'unavailable' | 'ambiguous';
  readonly protocolFinality: boolean | null;
  readonly detachedLegIds: readonly Bytes32[];
  /** Predicate-satisfying active prefix only. NOT executed obligation completion or authorization. */
  readonly completionPrefix: readonly Bytes32[];
  readonly legs: readonly (LinkedLeg & {
    readonly completionPredicate: 'satisfied' | 'not-yet' | 'unavailable' | 'not-applicable';
  })[];
  /** Earliest permitted return boundary according to the control's already completed obligations. */
  readonly returnBoundary: { readonly occurrenceId: Bytes32; readonly account: string };
  readonly executionRequired: true;
  readonly note: string;
};

const UINT256_MAX = (1n << 256n) - 1n;
/** The controller's active-leg window. Detached history does not count. */
const MAX_ACTIVE_LEGS = 128;
/**
 * A guard on untrusted snapshots, not a protocol rule: retained history is
 * uncapped on chain. A sequence that approaches this needs a paginated read.
 */
const MAX_JOURNAL_LEGS = 1_048_576;
const NOTE = 'Read-only snapshot, not obligation completion or recall authorization. ' +
  'The condition/execution control must revalidate atomically and enforce accepted terms. ' +
  'Commercial completion is separate from ERC temporal finality and legal title.';

function requireInput(ok: boolean, code: string): asserts ok {
  if (!ok) throw new LinkedChainInputError(code);
}

function uint(value: bigint, positive = false): boolean {
  return typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value <= UINT256_MAX;
}

function hash(value: string): boolean {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && value !== ZERO_BYTES32;
}

function address(value: string): boolean {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) &&
    value !== ZERO_ADDRESS;
}

function validateAsset(asset: LinkedAsset): void {
  requireInput(uint(asset.chainId, true) && uint(asset.tokenId) && address(asset.contract),
    'LINKED_ASSET_INVALID');
}

function sameAsset(a: LinkedAsset, b: LinkedAsset): boolean {
  return a.chainId === b.chainId && a.contract === b.contract && a.tokenId === b.tokenId;
}

/** Validates structure, not the authenticity of supplied backend records. */
function validateSnapshot(snapshot: LinkedChainSnapshot): {
  occurrences: Map<Bytes32, { account: string; position: number }>;
  detachedCount: number;
} {
  validateAsset(snapshot.asset);
  requireInput(hash(snapshot.sequenceId) && uint(snapshot.revision) &&
    uint(snapshot.blockNumber) && hash(snapshot.blockHash), 'LINKED_SNAPSHOT_INVALID');
  requireInput(hash(snapshot.initialOccurrenceId) && address(snapshot.initialHolder),
    'LINKED_INITIAL_OCCURRENCE_INVALID');
  requireInput(Array.isArray(snapshot.legs) && snapshot.legs.length <= MAX_JOURNAL_LEGS,
    'LINKED_SEQUENCE_LIMIT');
  // A snapshot carrying more unresolved legs than the controller's window could
  // not have come from it, so it is refused rather than rendered.
  requireInput(
    snapshot.legs.filter(leg => leg.outcome === 'active').length <= MAX_ACTIVE_LEGS,
    'LINKED_ACTIVE_SEQUENCE_LIMIT');
  const occurrences = new Map([[snapshot.initialOccurrenceId,
    { account: snapshot.initialHolder, position: 0 }]]);
  const legIds = new Set<Bytes32>();
  const acceptances = new Set<Bytes32>();
  let predecessor: Bytes32 | null = null;
  let previousHolder = snapshot.initialHolder;
  let activeSeen = false;
  let returnedSeen = false;
  let detachedCount = 0;
  for (const [index, leg] of snapshot.legs.entries()) {
    requireInput(hash(leg.id) && !legIds.has(leg.id), 'LINKED_LEG_ID_INVALID');
    requireInput(leg.predecessorId === predecessor && leg.seller === previousHolder,
      'LINKED_PREDECESSOR_MISMATCH');
    requireInput(address(leg.seller) && address(leg.buyer),
      'LINKED_PARTICIPANT_INVALID');
    requireInput(hash(leg.buyerOccurrenceId) && !occurrences.has(leg.buyerOccurrenceId),
      'LINKED_OCCURRENCE_REUSED');
    requireInput(hash(leg.termsHash),
      'LINKED_TERMS_INVALID');
    requireInput(['active', 'completed', 'returning', 'returned'].includes(leg.outcome),
      'LINKED_OUTCOME_INVALID');
    requireInput(leg.control !== undefined && hash(leg.control.controlId) &&
      hash(leg.control.acceptanceHash) && !acceptances.has(leg.control.acceptanceHash),
    'LINKED_CONTROL_BINDING_INVALID');
    acceptances.add(leg.control.acceptanceHash);
    // Completed obligations form a prefix; executed returns form a suffix.
    if (leg.outcome === 'completed') {
      requireInput(!activeSeen, 'LINKED_COMPLETION_PREFIX_INVALID');
      detachedCount++;
    } else {
      activeSeen = true;
    }
    if (leg.outcome === 'returned') returnedSeen = true;
    else requireInput(!returnedSeen, 'LINKED_RETURN_SUFFIX_INVALID');
    occurrences.set(leg.buyerOccurrenceId, { account: leg.buyer, position: index + 1 });
    legIds.add(leg.id);
    predecessor = leg.id;
    previousHolder = leg.buyer;
  }
  return { occurrences, detachedCount };
}

/**
 * Evaluate CP-01 over explicitly bound occurrences, never address ordering.
 * No mutation, state transition, signing, transaction or optimistic detachment.
 * Completion comes from the control, never from escrow existence or a payment.
 */
export function buildLinkedChainView(
  snapshot: LinkedChainSnapshot,
  evidence: LinkedCompletionEvidence,
): LinkedChainView {
  const { occurrences, detachedCount } = validateSnapshot(snapshot);
  requireInput(['bound', 'unavailable', 'ambiguous'].includes(evidence.kind),
    'LINKED_EVIDENCE_KIND_INVALID');
  let ownerPosition: number | undefined;
  let holderPosition: number | undefined;
  let protocolFinality: boolean | null = null;
  if (evidence.kind === 'bound') {
    validateAsset(evidence.asset);
    requireInput(sameAsset(snapshot.asset, evidence.asset) &&
      snapshot.sequenceId === evidence.sequenceId && snapshot.revision === evidence.revision,
    'LINKED_EVIDENCE_BINDING_MISMATCH');
    requireInput(snapshot.blockNumber === evidence.blockNumber && snapshot.blockHash === evidence.blockHash,
      'LINKED_EVIDENCE_BLOCK_MISMATCH');
    requireInput(evidence.protocolFinality === null || typeof evidence.protocolFinality === 'boolean',
      'LINKED_FINALITY_INVALID');
    const owner = occurrences.get(evidence.owner.occurrenceId);
    const holder = occurrences.get(evidence.admittedHolder.occurrenceId);
    requireInput(owner !== undefined && owner.account === evidence.owner.account,
      'LINKED_OWNER_OCCURRENCE_MISMATCH');
    requireInput(holder !== undefined && holder.account === evidence.admittedHolder.account,
      'LINKED_HOLDER_OCCURRENCE_MISMATCH');
    ownerPosition = owner.position;
    holderPosition = holder.position;
    protocolFinality = evidence.protocolFinality;
  }

  const completionPrefix: Bytes32[] = [];
  // A committed callback selects a competing outcome: no completion-execution preview.
  let prefixOpen = !snapshot.legs.some(leg => leg.outcome === 'returning' || leg.outcome === 'returned');
  const legs = snapshot.legs.map((leg, index) => {
    const completionPredicate = leg.outcome !== 'active' ? 'not-applicable' as const :
      ownerPosition === undefined || holderPosition === undefined ? 'unavailable' as const :
      ownerPosition >= index + 1 && holderPosition >= index + 1 ? 'satisfied' as const : 'not-yet' as const;
    if (leg.outcome !== 'completed') {
      if (prefixOpen && completionPredicate === 'satisfied') completionPrefix.push(leg.id);
      else prefixOpen = false;
    }
    return { ...leg, control: { ...leg.control }, completionPredicate };
  });
  const lastDetached = snapshot.legs[detachedCount - 1];
  return {
    asset: { ...snapshot.asset },
    sequenceId: snapshot.sequenceId,
    revision: snapshot.revision,
    blockNumber: snapshot.blockNumber,
    blockHash: snapshot.blockHash,
    evidenceStatus: evidence.kind,
    protocolFinality,
    detachedLegIds: snapshot.legs.slice(0, detachedCount).map(leg => leg.id),
    completionPrefix,
    legs,
    returnBoundary: lastDetached === undefined
      ? { occurrenceId: snapshot.initialOccurrenceId, account: snapshot.initialHolder }
      : { occurrenceId: lastDetached.buyerOccurrenceId, account: lastDetached.buyer },
    executionRequired: true,
    note: NOTE,
  };
}

/** Backend errors propagate; no owner/holder fallback or cached-success path. */
export async function readLinkedChainView(
  reader: LinkedControlReader, sequenceId: Bytes32,
): Promise<LinkedChainView> {
  requireInput(hash(sequenceId), 'LINKED_SEQUENCE_ID_INVALID');
  const { snapshot, evidence } = await reader.observe(sequenceId);
  requireInput(snapshot.sequenceId === sequenceId, 'LINKED_SEQUENCE_ID_MISMATCH');
  return buildLinkedChainView(snapshot, evidence);
}
