import { requireProjectionConformance, requireSettlementConformance } from "./conformance.js";
import { IdentityChangedError } from "./errors.js";
import { ZERO_BYTES32 } from "./types.js";
/**
 * Read and pin a contract's identity.
 *
 * `registerId` and `verificationProfile` are specified as nonzero and
 * unchanging. Re-reading them against a pin is therefore a real check: a
 * change means the wallet is not talking to the contract it believes it is,
 * and no displayed answer from it can be trusted.
 */
export class ContractIdentityPin {
    #reader;
    #pinned;
    constructor(reader) {
        this.#reader = reader;
    }
    get pinned() {
        return this.#pinned;
    }
    /**
     * Read the identity, pinning it on first use and verifying it thereafter.
     *
     * A zero identifier is rejected rather than shown: the ERC requires both to
     * be nonzero, so a zero one means the contract is not answering the question
     * that was asked.
     */
    async read(conformance) {
        requireProjectionConformance(this.#reader, conformance);
        const registerId = await this.#reader.registerId();
        if (registerId === ZERO_BYTES32) {
            throw new IdentityChangedError('registerId', 'a nonzero identifier', registerId);
        }
        let verificationProfile;
        if (conformance.settlement) {
            requireSettlementConformance(this.#reader, conformance);
            verificationProfile = await this.#reader.verificationProfile();
            if (verificationProfile === ZERO_BYTES32) {
                throw new IdentityChangedError('verificationProfile', 'a nonzero identifier', verificationProfile);
            }
        }
        const observed = {
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
            throw new IdentityChangedError('verificationProfile', pinned.verificationProfile ?? 'absent', observed.verificationProfile ?? 'absent');
        }
        return observed;
    }
}
