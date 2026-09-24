import { isBytes32, type Bytes32, type CandidateEntry, type Commitment, type Instant, type TokenId } from '../projection/types.ts';

/**
 * What an admission proof is checked against.
 *
 * The binding is what stops a proof produced for one place being replayed in
 * another: it names the local chain and contract, the token and settlement it
 * belongs to, the holder and commitments it claims, and the version and
 * effective time it carries.
 */
export interface AdmissionBinding {
  readonly chainId: bigint;
  readonly contract: string;
  readonly tokenId: TokenId;
  readonly settlementId: string;
  /** Snapshot of the open settlement; zero for projection-only admission. */
  readonly snapshotHash: Bytes32;
  readonly holder: string;
  readonly priorCommitment: Commitment;
  readonly nextCommitment: Commitment;
  readonly version: bigint;
  readonly effectiveAt: Instant;
}

/** The proof material a relayer submits alongside a candidate entry. */
export interface ProofMaterial {
  readonly profile: string;
  /** Height of the remote state the proof claims inclusion in. */
  readonly remoteHeight: bigint;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ProofContext {
  readonly binding: AdmissionBinding;
  readonly candidate: CandidateEntry;
  /** Highest remote height already accepted for this token. */
  readonly acceptedRemoteHeight: bigint;
  /** Whether the adapter considers the claimed remote height finalized. */
  readonly remoteFinalized: boolean;
}

export type ProofVerdict = { readonly admitted: true } | { readonly admitted: false; readonly reason: string };

export const admitted: ProofVerdict = { admitted: true };
export const refused = (reason: string): ProofVerdict => ({ admitted: false, reason });

/**
 * A proof profile decides whether evidence may admit an entry.
 *
 * It MUST NOT set finality. A verdict of `admitted` means the entry enters
 * history; whether any instant is final is computed from that history
 * afterwards, by the later-admission rule and by nothing else.
 */
export interface ProofProfile {
  readonly id: string;
  verify(material: ProofMaterial, context: ProofContext): ProofVerdict;
}

/** Explicit, immutable mapping from the advertised identity to one verifier. */
export class ProofProfileRegistry {
  readonly #profiles = new Map<Bytes32, ProofProfile>();
  readonly #ids = new Set<string>();

  register(profile: ProofProfile, identity: Bytes32): void {
    if (!isBytes32(identity)) throw new Error('verification profile identity must be bytes32');
    const key = identity.toLowerCase();
    if (this.#profiles.has(key) || this.#ids.has(profile.id)) {
      throw new Error('verification profile is already registered');
    }
    this.#profiles.set(key, Object.freeze({ id: profile.id, verify: profile.verify.bind(profile) }));
    this.#ids.add(profile.id);
  }

  get(identity: Bytes32): ProofProfile | undefined {
    return this.#profiles.get(identity.toLowerCase());
  }

  ids(): readonly string[] {
    return [...this.#ids].sort();
  }
}
