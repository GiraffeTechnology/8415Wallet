import {
  FIRST_VERSION,
  ZERO_BYTES32,
  isAddress,
  isBytes32,
  isUint64,
  type CandidateEntry,
  type Commitment,
  type Address,
  type Instant,
  type ProjectionEntry,
} from './types.ts';
import { ProjectionError, reject } from './errors.ts';

/**
 * The append-only projection history of one token, and the temporal queries
 * over it. This is the standard's four projection invariants and its finality
 * rule, and nothing else.
 *
 * The kernel has no notion of current ERC-721 ownership and cannot be given
 * one. `holderAsOf` answers from admitted history alone.
 *
 * Finality is not stored. `isFinalAsOf` compares against the first and latest
 * effective times on every call, so admitting an entry changes the answer for
 * earlier instants with nothing written back.
 */
export class TokenProjection {
  #entries: ProjectionEntry[] = [];
  readonly #commitments = new Set<Commitment>();
  readonly #byVersion = new Map<string, number>();

  get length(): number {
    return this.#entries.length;
  }

  /** Indexed by version, as `entryAt(uint256,uint64)` is. Reverts if absent. */
  entryAt(version: bigint): ProjectionEntry {
    const index = this.#byVersion.get(version.toString());
    if (index === undefined) {
      return reject('UNKNOWN_VERSION', `no entry at version ${version}`);
    }
    return this.#entries[index] as ProjectionEntry;
  }

  currentEntry(): ProjectionEntry {
    const entry = this.#entries.at(-1);
    if (entry === undefined) {
      return reject('EMPTY_PROJECTION', 'the projection has no entries');
    }
    return entry;
  }

  /**
   * Validate a candidate against all four projection invariants and append it.
   *
   * Invariant 2 also closes the preceding entry: its `supersededAt` becomes
   * this entry's `effectiveAt`. That is the one write the standard makes to an
   * already-admitted entry, it happens exactly once, and nothing else about
   * that entry moves.
   */
  admit(candidate: CandidateEntry): ProjectionEntry {
    validateCandidateShape(candidate);
    const previous = this.#entries.at(-1);

    if (previous === undefined) {
      // Invariant 1.
      if (candidate.version !== FIRST_VERSION) {
        reject('NON_CONSECUTIVE_VERSION', `the first entry must have version 1, got ${candidate.version}`);
      }
      if (candidate.previousCommitment !== ZERO_BYTES32) {
        reject('BROKEN_COMMITMENT_LINKAGE', 'the first entry must have a zero previousCommitment');
      }
    } else {
      // Invariant 2.
      if (candidate.version !== previous.version + 1n) {
        reject('NON_CONSECUTIVE_VERSION', `version must be ${previous.version + 1n}, got ${candidate.version}`);
      }
      if (candidate.previousCommitment !== previous.recordCommitment) {
        reject('BROKEN_COMMITMENT_LINKAGE', 'previousCommitment does not link the preceding record commitment');
      }
      // Invariant 3.
      if (candidate.effectiveAt <= previous.effectiveAt) {
        reject(
          'EFFECTIVE_AT_NOT_INCREASING',
          `effectiveAt must exceed ${previous.effectiveAt}, got ${candidate.effectiveAt}`,
        );
      }
    }

    // Invariant 4, scoped to this token. A commitment held by another token is
    // none of this projection's business: cross-token replay is a registrar or
    // application concern, and checking it here would need global state the
    // standard does not assume.
    if (this.#commitments.has(candidate.recordCommitment)) {
      reject('COMMITMENT_REUSED', 'this record commitment is already in the token history');
    }

    const entry: ProjectionEntry = { ...candidate, supersededAt: 0n };

    if (previous !== undefined) {
      const index = this.#entries.length - 1;
      this.#entries[index] = { ...previous, supersededAt: candidate.effectiveAt };
    }
    this.#entries.push(entry);
    this.#commitments.add(entry.recordCommitment);
    this.#byVersion.set(entry.version.toString(), this.#entries.length - 1);
    return entry;
  }

  /**
   * The entry whose effective interval contains the instant.
   *
   * Reverts for an instant preceding the first entry: the projection does not
   * cover it. An instant at or after the latest entry's effectiveAt resolves,
   * but provisionally — `entryAsOf` does not distinguish the two cases, which
   * is why a consumer needing a settled answer must check `isFinalAsOf`.
   */
  entryAsOf(instant: Instant): ProjectionEntry {
    const first = this.#entries[0];
    if (first === undefined || instant < first.effectiveAt) {
      return reject('INSTANT_NOT_COVERED', `the projection does not cover instant ${instant}`);
    }

    let low = 0;
    let high = this.#entries.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      const candidate = this.#entries[mid];
      if (candidate !== undefined && candidate.effectiveAt <= instant) low = mid;
      else high = mid - 1;
    }
    return this.#entries[low] as ProjectionEntry;
  }

  /** That entry's holder, and only that. Whether it can still move is a separate question. */
  holderAsOf(instant: Instant): Address {
    return this.entryAsOf(instant).holder;
  }

  /**
   * Final if and only if the instant is at or after the first entry's
   * effectiveAt and strictly before the latest entry's.
   *
   * Nothing else produces finality: not a closed gap, not a cancellation, not
   * a verified proof, not block depth, not a timeout. Never reverts.
   */
  isFinalAsOf(instant: Instant): boolean {
    const first = this.#entries[0];
    const latest = this.#entries.at(-1);
    if (first === undefined || latest === undefined) return false;
    return instant >= first.effectiveAt && instant < latest.effectiveAt;
  }

  entries(): readonly ProjectionEntry[] {
    return this.#entries.slice();
  }

}

/** Validate fields before any proof profile or caller dereferences them. */
export const validateCandidateShape = (candidate: CandidateEntry): void => {
  const bad = (why: string): never => reject('MALFORMED_ENTRY', why);

  if (typeof candidate !== 'object' || candidate === null) bad('entry must be an object');

  if (!isAddress(candidate.holder)) bad('holder is not a lowercase 0x address');
  if (!isBytes32(candidate.recordCommitment)) bad('recordCommitment is not bytes32');
  if (!isBytes32(candidate.previousCommitment)) bad('previousCommitment is not bytes32');
  if (!isBytes32(candidate.registryReference)) bad('registryReference is not bytes32');
  if (!isUint64(candidate.effectiveAt)) bad('effectiveAt is not a uint64');
  if (!isUint64(candidate.version)) bad('version is not a uint64');
  if (candidate.recordCommitment === ZERO_BYTES32) bad('recordCommitment is zero');
  if (candidate.recordCommitment === candidate.previousCommitment) {
    bad('recordCommitment repeats previousCommitment');
  }
};

export { ProjectionError };
