/** Solidity enum ordering. */
export const FRESHNESS_BY_INDEX = [
    'UNKNOWN',
    'STALE',
    'FRESH_PENDING',
    'FRESH_FINAL',
];
/** Derive a feed identifier and return it as a binding. */
export async function bindByRegistrar(reader, registrar, salt, claimedRegisterId) {
    return {
        reader,
        assetId: await reader.computeAssetId(registrar, salt),
        provenance: 'computed',
        ...(claimedRegisterId === undefined ? {} : { claimedRegisterId }),
    };
}
