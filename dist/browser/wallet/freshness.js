const DISCLAIMER = 'Freshness is not finality. It measures how exposed the attestation is to a ' +
    'chain reorganisation, not whether the register has confirmed a holder, and ' +
    'not whether a projected instant can still change. Read `isFinalAsOf` for ' +
    'that; nothing here substitutes for it.';
const LABELS = {
    'reorg-safe': 'Reorg-safe',
    'fresh-reorg-exposed': 'Fresh, reorg-exposed',
    stale: 'Stale',
    unknown: 'Unknown',
    'not-configured': 'No watchtower configured',
};
const DISPLAY_BY_STATUS = {
    UNKNOWN: 'unknown',
    STALE: 'stale',
    FRESH_PENDING: 'fresh-reorg-exposed',
    FRESH_FINAL: 'reorg-safe',
};
/** The view for a wallet with no watchtower to consult. */
export function noWatchtower() {
    return {
        assetId: undefined,
        source: undefined,
        binding: undefined,
        bindingNote: undefined,
        reported: undefined,
        display: 'not-configured',
        label: LABELS['not-configured'],
        age: undefined,
        finalityDepth: undefined,
        explanation: 'No watchtower freshness layer is configured for this asset. Its absence ' +
            'says nothing about the projection, which is read from the ERC-8415 ' +
            'contract and does not depend on a watchtower.',
        disclaimer: DISCLAIMER,
    };
}
export async function buildFreshnessView(binding) {
    const { reader, assetId } = binding;
    const { status, age } = await reader.freshnessOf(assetId);
    let finalityDepth;
    try {
        finalityDepth = (await reader.policyOf(assetId)).finalityDepth;
    }
    catch {
        finalityDepth = undefined;
    }
    const display = DISPLAY_BY_STATUS[status];
    return {
        assetId,
        source: reader.source,
        binding: {
            provenance: binding.provenance,
            ...(binding.claimedRegisterId === undefined
                ? {}
                : { claimedRegisterId: binding.claimedRegisterId }),
        },
        bindingNote: bindingNote(binding),
        reported: status,
        display,
        label: LABELS[display],
        age,
        finalityDepth,
        explanation: explain(status, age, finalityDepth),
        disclaimer: DISCLAIMER,
    };
}
function explain(status, age, finalityDepth) {
    const depth = finalityDepth === undefined ? 'the configured depth' : `${finalityDepth} blocks`;
    switch (status) {
        case 'FRESH_FINAL':
            return (`The head was signed ${age} block(s) ago, at or beyond ${depth}, so it is ` +
                `buried deeply enough not to flip in a reorganisation. The contract's enum ` +
                `calls this state FRESH_FINAL; it is reorg safety of the attestation, not ` +
                `registrar finality and not projection finality.`);
        case 'FRESH_PENDING':
            return (`The head was signed ${age} block(s) ago, short of ${depth}, so it is recent ` +
                `enough to be useful but still exposed to a reorganisation.`);
        case 'STALE':
            return (`The head is ${age} block(s) old and no longer counts as fresh — its age has ` +
                `passed the threshold it was signed with, or its signing key was revoked. ` +
                `A revoked key means compromise, and collapses the classification retroactively.`);
        case 'UNKNOWN':
            return ('No head is recorded, or the asset is not registered with this watchtower. ' +
                'Nothing is being attested.');
    }
}
function bindingNote(binding) {
    const how = binding.provenance === 'computed'
        ? 'This feed identifier was derived through the watchtower\u2019s own computeAssetId.'
        : 'This feed identifier was supplied by configuration.';
    const claim = binding.claimedRegisterId === undefined
        ? 'Nothing states which register it tracks.'
        : `It is asserted to track register ${binding.claimedRegisterId}.`;
    return (`${how} ${claim} No on-chain link exists between an ERC-8415 register and a ` +
        'watchtower feed \u2014 the two contracts do not know about each other \u2014 so this ' +
        'pairing is an assertion by whoever configured it, not a fact the wallet checked.');
}
