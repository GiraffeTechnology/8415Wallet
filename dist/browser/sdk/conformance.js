import { ContractRevertError, NonConformantContractError } from "./errors.js";
import { INTERFACE_ID_ERC165, INTERFACE_ID_PROJECTION_SETTLEMENT, INTERFACE_ID_REGISTER_PROJECTION, } from "./interfaceIds.js";
/**
 * Discover which conformance levels a contract advertises.
 *
 * Projection and settlement conformance are advertised separately and a
 * projection may be maintained without the settlement interface, so both are
 * asked for independently rather than inferred from one another.
 *
 * A contract that does not answer ERC-165 at all reports every level false.
 * That is a finding, not an error: the wallet simply may not present
 * projection data for it.
 *
 * Only a revert counts as that answer. A transport failure is not the contract
 * declining to advertise an interface — it is the wallet having failed to ask —
 * and it propagates rather than being reported as non-conformance. Swallowing
 * it would tell a user their contract is not an ERC-8415 contract because their
 * node was down, which is a cause the wallet never established.
 */
export async function detectConformance(reader) {
    const supports = async (interfaceId) => {
        try {
            return await reader.supportsInterface(interfaceId);
        }
        catch (error) {
            if (error instanceof ContractRevertError)
                return false;
            throw error;
        }
    };
    const erc165 = await supports(INTERFACE_ID_ERC165);
    if (!erc165) {
        return { erc165: false, projection: false, settlement: false };
    }
    return {
        erc165,
        projection: await supports(INTERFACE_ID_REGISTER_PROJECTION),
        settlement: await supports(INTERFACE_ID_PROJECTION_SETTLEMENT),
    };
}
/**
 * Gate projection reads on advertised conformance.
 *
 * Called before anything from the projection is read, so the wallet cannot
 * display projection data for a contract that never claimed to have one.
 */
export function requireProjectionConformance(reader, conformance) {
    if (!conformance.projection) {
        throw new NonConformantContractError(reader.source.address, INTERFACE_ID_REGISTER_PROJECTION, 'the projection');
    }
}
/**
 * Gate settlement reads.
 *
 * Absence is a property of the contract, not a fault: a contract offering no
 * settlement interface has no gaps and no contested instants, and callers are
 * expected to present it that way rather than as "no gap open".
 */
export function requireSettlementConformance(reader, conformance) {
    if (!conformance.settlement) {
        throw new NonConformantContractError(reader.source.address, INTERFACE_ID_PROJECTION_SETTLEMENT, 'settlement state');
    }
}
