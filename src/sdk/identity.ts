import { requireProjectionConformance, requireSettlementConformance } from './conformance.ts';
import { IdentityChangedError } from './errors.ts';
import type { Erc8415Reader } from './port.ts';
import { ZERO_BYTES32, type Bytes32, type Conformance } from './types.ts';

/**
 * What a projection is a projection of.
 *
 * The parties who rely on this are third parties with no relationship to the
 * registrar, so a projection they cannot attribute to a register, under a
 * proof profile they cannot name, tells them very little. The wallet carries
 * these alongside every answer rather than treating them as configuration.
 */
export type ContractIdentity = {
  readonly chainId: bigint;
  readonly address: string;
  readonly registerId: Bytes32;
  /** Absent when the contract offers no settlement interface. */
  readonly verificationProfile: Bytes32 | undefined;
};

/**
 * Read and pin a contract's identity.
 *
 * `registerId` and `verificationProfile` are specified as nonzero and
 * unchanging. Re-reading them against a pin is therefore a real check: a
 * change means the wallet is not talking to the contract it believes it is,
 * and no displayed answer from it can be trusted.
 */
export class ContractIdentityPin {
  readonly #reader: Erc8415Reader;
  #pinned: ContractIdentity | undefined;

  constructor(reader: Erc8415Reader) {
    this.#reader = reader;
  }

  get pinned(): ContractIdentity | undefined {
    return this.#pinned;
  }

  /**
   * Read the identity, pinning it on first use and verifying it thereafter.
   *
   * A zero identifier is rejected rather than shown: the ERC requires both to
   * be nonzero, so a zero one means the contract is not answering the question
   * that was asked.
   */
  async read(conformance: Conformance): Promise<ContractIdentity> {
    requireProjectionConformance(this.#reader, conformance);

    const registerId = await this.#reader.registerId();
    if (registerId === ZERO_BYTES32) {
      throw new IdentityChangedError('registerId', 'a nonzero identifier', registerId);
    }

    let verificationProfile: Bytes32 | undefined;
    if (conformance.settlement) {
      requireSettlementConformance(this.#reader, conformance);
      verificationProfile = await this.#reader.verificationProfile!();
      if (verificationProfile === ZERO_BYTES32) {
        throw new IdentityChangedError(
          'verificationProfile',
          'a nonzero identifier',
          verificationProfile,
        );
      }
    }

    const observed: ContractIdentity = {
      chainId: this.#reader.source.chainId,
      address: this.#reader.source.address,
      registerId,
      verificationProfile,
    };

    const pinned = this.#pinned;
    if (pinned === undefined) {
      this.#pinned = observed;
      return observed;
    }

    if (pinned.registerId !== observed.registerId) {
      throw new IdentityChangedError('registerId', pinned.registerId, observed.registerId);
    }
    if (pinned.verificationProfile !== observed.verificationProfile) {
      throw new IdentityChangedError(
        'verificationProfile',
        pinned.verificationProfile ?? 'absent',
        observed.verificationProfile ?? 'absent',
      );
    }
    return observed;
  }
}
