import { buildHistoryView } from "./history.js";
import { buildSettlementLog } from "./settlementLog.js";
/**
 * An audit trail a third party can re-check against the chain.
 *
 * Every value is carried in the form the contract returned it: integers as
 * decimal strings so no precision is lost, hashes verbatim, and each gap
 * transition with the block and log index it was emitted at. Nothing is
 * summarised, rounded, or reordered, because the point of the export is that
 * someone who does not trust this wallet can go and read the same values.
 *
 * It records what was read and when. It is not a certification: the wallet
 * cannot attest that the contract is honest, only that this is what it said.
 */
export const AUDIT_SCHEMA = 'erc8415-wallet-audit/1';
const NOTES = [
    'Integers are decimal strings, so no value is narrowed by a JSON number.',
    'Instants are uint64 seconds since the Unix epoch, on the block.timestamp scale.',
    'A registryReference is an opaque locator. Its contents are off chain and are ' +
        'not included here; resolving one requires entitlement to read the register.',
    'Gap transitions carry the block and log index they were emitted at, so each can ' +
        'be located on chain independently of this file.',
    'When settlementLog.available is false, no gap transition could be read. That is ' +
        'not a record that none occurred.',
    'This is a record of what the contract returned at observedAt. It is not a ' +
        'certification that the contract, the register or the proofs behind it are honest.',
];
export async function exportAuditTrail(reader, tokenId, options = {}) {
    const history = await buildHistoryView(reader, tokenId, options.identityPin === undefined ? {} : { identityPin: options.identityPin });
    const log = await buildSettlementLog(reader, tokenId);
    const observedAt = await reader.chainInstant();
    const owner = await reader.ownerOf(tokenId);
    return {
        schema: AUDIT_SCHEMA,
        exportedAt: new Date().toISOString(),
        source: {
            chainId: history.identity.chainId.toString(),
            contract: history.identity.address,
            registerId: history.identity.registerId,
            verificationProfile: history.identity.verificationProfile ?? null,
        },
        tokenId: tokenId.toString(),
        observedAt: observedAt.toString(),
        tradeablePosition: { owner },
        entries: history.entries.map((item) => ({
            version: item.entry.version.toString(),
            holder: item.entry.holder,
            effectiveAt: item.entry.effectiveAt.toString(),
            supersededAt: item.entry.supersededAt.toString(),
            recordCommitment: item.entry.recordCommitment,
            previousCommitment: item.entry.previousCommitment,
            registryReference: item.entry.registryReference,
            linkFaults: [...item.linkFaults],
        })),
        chainIntact: history.chainIntact,
        settlementLog: {
            available: log.available,
            episodes: log.episodes.map((episode) => ({
                settlementId: episode.settlementId,
                openedAt: episode.openedAt === undefined ? null : episode.openedAt.toString(),
                deadline: episode.deadline.toString(),
                expectedHolder: episode.expectedHolder,
                initiator: episode.initiator,
                closure: episode.closure,
                admittedVersion: episode.admitted === undefined ? null : episode.admitted.version.toString(),
                replacedBy: episode.replacedBy ?? null,
            })),
            events: log.events.map((event) => ({
                kind: event.kind,
                blockNumber: event.blockNumber.toString(),
                logIndex: event.logIndex.toString(),
            })),
        },
        notes: NOTES,
    };
}
/** Serialise an audit trail deterministically, so two exports of one state match. */
export function serialiseAuditTrail(trail) {
    return `${JSON.stringify(trail, null, 2)}\n`;
}
