import type { Address, Bytes32 } from '../sdk/types.ts';

/** Experimental deterministic control kernel. No signer, storage, RPC or escrow. */
export type ResponsibilityDomain = {
  readonly chainId: bigint;
  readonly token: Address;
  readonly tokenId: bigint;
  readonly sequenceId: Bytes32;
  readonly controlId: Bytes32;
};
export type ResponsibilityPosition = { readonly occurrenceId: Bytes32; readonly account: Address };
export type ResponsibilityLeg = {
  readonly id: Bytes32;
  readonly buyer: ResponsibilityPosition;
  readonly termsHash: Bytes32;
  readonly acceptanceHash: Bytes32;
  readonly returnAuthority: Address;
  readonly returnConditionHash: Bytes32;
  readonly outcome: 'active' | 'completed' | 'returning' | 'returned';
};
export type ResponsibilityState = {
  readonly domain: ResponsibilityDomain;
  readonly revision: bigint;
  readonly initial: ResponsibilityPosition;
  readonly legs: readonly ResponsibilityLeg[];
  readonly callback: null | { readonly rootLegId: Bytes32 };
};
export type ResponsibilityBinding = {
  readonly domain: ResponsibilityDomain;
  readonly expectedRevision: bigint;
};
export type InheritedResponsibility = {
  readonly legId: Bytes32;
  readonly termsHash: Bytes32;
  readonly acceptanceHash: Bytes32;
};
export type ResponsibilityCommand = ResponsibilityBinding & (
  | { readonly kind: 'forward'; readonly leg: ResponsibilityLeg;
      readonly inherited: readonly InheritedResponsibility[] }
  | { readonly kind: 'complete-prefix'; readonly throughLegId: Bytes32 }
  | { readonly kind: 'begin-return'; readonly rootLegId: Bytes32 }
  | { readonly kind: 'return-hop'; readonly legId: Bytes32 }
);

/**
 * Values from an execution adapter, NOT authenticated by this kernel.
 * The adapter MUST verify actor, recipient consent over the entire command and
 * inherited scope, occurrence proofs and callback condition in its atomic
 * execution boundary. Never expose this function as an untrusted JSON endpoint.
 */
export type ResponsibilityFacts = ResponsibilityBinding & {
  readonly actor: Address;
  /** Separately authenticated recipient consent; exact signed command, not a UI flag. */
  readonly recipientAcceptance?: Extract<ResponsibilityCommand, { kind: 'forward' }>;
  readonly completion?: {
    readonly owner: ResponsibilityPosition;
    readonly admittedHolder: ResponsibilityPosition;
    readonly protocolFinality: boolean | null;
  };
  readonly callbackConditionHash?: Bytes32;
};
export type ResponsibilityEffect = {
  readonly kind: 'transfer-token';
  readonly legId: Bytes32;
  readonly from: ResponsibilityPosition;
  readonly to: ResponsibilityPosition;
};
export type ResponsibilityProposal = {
  readonly status: 'UNCOMMITTED_PROPOSAL';
  readonly expectedRevision: bigint;
  readonly next: ResponsibilityState;
  readonly effects: readonly ResponsibilityEffect[];
  /** Caller must NOT persist next before the effects and authorization commit. */
  readonly requiresAtomicAuthenticatedExecution: true;
};

export class ResponsibilityControlError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'ResponsibilityControlError';
    this.code = code;
  }
}
const MAX_UINT = (1n << 256n) - 1n;
const MAX_LEGS = 4096;
function requireControl(ok: boolean, code: string): asserts ok {
  if (!ok) throw new ResponsibilityControlError(code);
}
function hash(value: string): boolean {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value);
}
function address(value: string): boolean {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0+$/.test(value);
}
function uint(value: bigint): boolean {
  return typeof value === 'bigint' && value >= 0n && value <= MAX_UINT;
}
function sameDomain(a: ResponsibilityDomain, b: ResponsibilityDomain): boolean {
  return a.chainId === b.chainId && a.token === b.token && a.tokenId === b.tokenId &&
    a.sequenceId === b.sequenceId && a.controlId === b.controlId;
}
function positions(state: ResponsibilityState): ResponsibilityPosition[] {
  return [state.initial, ...state.legs.map(leg => leg.buyer)];
}
function cursor(state: ResponsibilityState): number {
  const firstReturned = state.legs.findIndex(leg => leg.outcome === 'returned');
  return firstReturned < 0 ? state.legs.length : firstReturned;
}
function validate(state: ResponsibilityState): void {
  const d = state.domain;
  requireControl(uint(d.chainId) && d.chainId > 0n && address(d.token) && uint(d.tokenId) &&
    hash(d.sequenceId) && hash(d.controlId), 'CONTROL_DOMAIN_INVALID');
  requireControl(uint(state.revision), 'CONTROL_REVISION_INVALID');
  requireControl(Array.isArray(state.legs) && state.legs.length <= MAX_LEGS, 'CONTROL_LEG_LIMIT');
  const ids = new Set<string>();
  const acceptances = new Set<string>();
  const occurrences = new Set<string>();
  for (const position of positions(state)) {
    requireControl(hash(position.occurrenceId) && address(position.account) &&
      !occurrences.has(position.occurrenceId), 'CONTROL_OCCURRENCE_INVALID');
    occurrences.add(position.occurrenceId);
  }
  let nonCompleted = false;
  let returned = false;
  const root = state.callback === null ? -1 : state.legs.findIndex(l => l.id === state.callback!.rootLegId);
  requireControl(state.callback === null || root >= 0, 'CONTROL_CALLBACK_STATE_INVALID');
  for (const [i, leg] of state.legs.entries()) {
    requireControl(hash(leg.id) && !ids.has(leg.id) && hash(leg.termsHash) &&
      hash(leg.acceptanceHash) && !acceptances.has(leg.acceptanceHash) &&
      address(leg.returnAuthority) && hash(leg.returnConditionHash), 'CONTROL_LEG_INVALID');
    ids.add(leg.id);
    acceptances.add(leg.acceptanceHash);
    requireControl(['active', 'completed', 'returning', 'returned'].includes(leg.outcome), 'CONTROL_OUTCOME_INVALID');
    if (leg.outcome === 'completed') requireControl(!nonCompleted, 'CONTROL_COMPLETION_PREFIX_INVALID');
    else nonCompleted = true;
    if (leg.outcome === 'returned') returned = true;
    else requireControl(!returned, 'CONTROL_RETURN_SUFFIX_INVALID');
    requireControl(leg.outcome !== 'returning' || (root >= 0 && i >= root), 'CONTROL_CALLBACK_STATE_INVALID');
    if (root >= 0 && i >= root) requireControl(
      leg.outcome === 'returning' || leg.outcome === 'returned', 'CONTROL_CALLBACK_STATE_INVALID');
  }
  if (root >= 0) requireControl(state.legs[root]!.outcome === 'returning', 'CONTROL_CALLBACK_STATE_INVALID');
}
function positionIndex(state: ResponsibilityState, position: ResponsibilityPosition): number {
  const index = positions(state).findIndex(p => p.occurrenceId === position.occurrenceId && p.account === position.account);
  requireControl(index >= 0, 'CONTROL_EVIDENCE_OCCURRENCE_REFUSED');
  return index;
}

/**
 * Prepares a transition, not an authorization or execution receipt. It never
 * mutates state or moves tokens. A production adapter must atomically verify
 * facts + consent, CAS expectedRevision, execute all effects, and commit next;
 * failed effects MUST leave the previous state intact. No such adapter ships yet.
 */
export function prepareResponsibilityTransition(
  state: ResponsibilityState, command: ResponsibilityCommand, facts: ResponsibilityFacts,
): ResponsibilityProposal {
  validate(state);
  requireControl(sameDomain(state.domain, command.domain), 'CONTROL_DOMAIN_MISMATCH');
  requireControl(state.revision === command.expectedRevision, 'CONTROL_STALE_REVISION');
  requireControl(sameDomain(state.domain, facts.domain) && facts.expectedRevision === state.revision,
    'CONTROL_FACTS_BINDING_REFUSED');
  requireControl(state.revision < MAX_UINT, 'CONTROL_REVISION_EXHAUSTED');
  requireControl(address(facts.actor), 'CONTROL_ACTOR_INVALID');
  const legs = state.legs.map(l => ({ ...l, buyer: { ...l.buyer } }));
  let callback = state.callback === null ? null : { ...state.callback };
  const effects: ResponsibilityEffect[] = [];
  const currentPosition = positions(state)[cursor(state)]!;
  switch (command.kind) {
    case 'forward': {
      requireControl(callback === null, 'CONTROL_CALLBACK_ACTIVE');
      requireControl(!legs.some(l => l.outcome === 'returned'), 'CONTROL_SEQUENCE_RESTART_REQUIRED');
      requireControl(facts.actor === currentPosition.account, 'CONTROL_ACTOR_REFUSED');
      requireControl(command.leg.outcome === 'active', 'CONTROL_NEW_LEG_OUTCOME_REFUSED');
      const consent = facts.recipientAcceptance;
      requireControl(consent !== undefined && consent.kind === 'forward' &&
        sameDomain(state.domain, consent.domain) && consent.expectedRevision === state.revision &&
        consent.leg.id === command.leg.id && consent.leg.buyer.account === command.leg.buyer.account &&
        consent.leg.buyer.occurrenceId === command.leg.buyer.occurrenceId &&
        consent.leg.termsHash === command.leg.termsHash && consent.leg.acceptanceHash === command.leg.acceptanceHash &&
        consent.leg.returnAuthority === command.leg.returnAuthority &&
        consent.leg.returnConditionHash === command.leg.returnConditionHash && consent.leg.outcome === 'active' &&
        consent.inherited.length === command.inherited.length && consent.inherited.every((a, i) => {
          const b = command.inherited[i]!;
          return a.legId === b.legId && a.termsHash === b.termsHash && a.acceptanceHash === b.acceptanceHash;
        }), 'CONTROL_RECIPIENT_ACCEPTANCE_REQUIRED');
      const active = legs.filter(l => l.outcome === 'active');
      requireControl(command.inherited.length === active.length && active.every((l, i) => {
        const accepted = command.inherited[i]!;
        return accepted.legId === l.id && accepted.termsHash === l.termsHash && accepted.acceptanceHash === l.acceptanceHash;
      }), 'CONTROL_INHERITANCE_REFUSED');
      const leg = { ...command.leg, buyer: { ...command.leg.buyer } };
      legs.push(leg);
      effects.push({ kind: 'transfer-token', legId: leg.id, from: { ...currentPosition }, to: { ...leg.buyer } });
      break;
    }
    case 'complete-prefix': {
      requireControl(callback === null, 'CONTROL_CALLBACK_ACTIVE');
      const end = legs.findIndex(l => l.id === command.throughLegId);
      requireControl(end >= 0 && legs[end]!.outcome === 'active', 'CONTROL_COMPLETION_TARGET_REFUSED');
      const proof = facts.completion;
      requireControl(proof !== undefined, 'CONTROL_COMPLETION_EVIDENCE_REQUIRED');
      requireControl(proof.protocolFinality === null || typeof proof.protocolFinality === 'boolean', 'CONTROL_FINALITY_INVALID');
      const owner = positionIndex(state, proof.owner);
      const holder = positionIndex(state, proof.admittedHolder);
      requireControl(owner === cursor(state), 'CONTROL_OWNER_STATE_MISMATCH');
      requireControl(owner >= end + 1 && holder >= end + 1, 'CONTROL_DUAL_POSITION_REQUIRED');
      for (let i = 0; i <= end; i++) {
        requireControl(legs[i]!.outcome === 'active' || legs[i]!.outcome === 'completed', 'CONTROL_COMPLETION_PREFIX_INVALID');
        legs[i]!.outcome = 'completed';
      }
      break;
    }
    case 'begin-return': {
      requireControl(callback === null, 'CONTROL_CALLBACK_ACTIVE');
      const root = legs.findIndex(l => l.id === command.rootLegId);
      requireControl(root >= 0 && legs[root]!.outcome === 'active', 'CONTROL_RETURN_BOUNDARY_REFUSED');
      const leg = legs[root]!;
      requireControl(facts.actor === leg.returnAuthority, 'CONTROL_RETURN_AUTHORITY_REFUSED');
      requireControl(facts.callbackConditionHash === leg.returnConditionHash, 'CONTROL_RETURN_CONDITION_REFUSED');
      for (let i = root; i < legs.length; i++) if (legs[i]!.outcome === 'active') legs[i]!.outcome = 'returning';
      callback = { rootLegId: leg.id };
      break;
    }
    case 'return-hop': {
      requireControl(callback !== null, 'CONTROL_CALLBACK_REQUIRED');
      const index = cursor(state) - 1;
      const leg = legs[index];
      requireControl(leg !== undefined && leg.id === command.legId && leg.outcome === 'returning', 'CONTROL_RETURN_ORDER_REFUSED');
      const root = legs.find(l => l.id === callback!.rootLegId)!;
      requireControl(facts.actor === root.returnAuthority, 'CONTROL_RETURN_AUTHORITY_REFUSED');
      effects.push({ kind: 'transfer-token', legId: leg.id, from: { ...currentPosition }, to: { ...positions(state)[index]! } });
      leg.outcome = 'returned';
      if (leg.id === root.id) callback = null;
      break;
    }
    default: throw new ResponsibilityControlError('CONTROL_COMMAND_REFUSED');
  }
  const next: ResponsibilityState = {
    domain: { ...state.domain }, revision: state.revision + 1n,
    initial: { ...state.initial }, legs, callback,
  };
  validate(next);
  return { status: 'UNCOMMITTED_PROPOSAL', expectedRevision: state.revision, next, effects,
    requiresAtomicAuthenticatedExecution: true };
}
