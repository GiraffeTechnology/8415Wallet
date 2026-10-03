import { detectConformance, requireProjectionConformance } from "../sdk/conformance.js";
import { ContractRevertError, ProjectionNotInitialized } from "../sdk/errors.js";
import { ContractIdentityPin } from "../sdk/identity.js";
import { ZERO_BYTES32 } from "../sdk/types.js";
import { describeContest } from "./contested.js";
import { describeFinality } from "./finality.js";
const NOTE_NOT_COVERED = 'The projection does not cover this instant: it precedes the first admitted ' +
    'entry. `entryAsOf` and `holderAsOf` revert here by specification. This is ' +
    'not a fault, and it is not an answer of "no holder" either — the register ' +
    'simply says nothing about this instant.';
const NOTE_UNAVAILABLE = 'The projection could not be read for this instant. No neighbouring ' +
    'instant, cached answer, or `ownerOf` has been substituted.';
const DISCLOSURE_POSITION = 'The ERC-721 position as of now. A claim made against a past instant does ' +
    'not care who holds the token now.';
/**
 * Resolve a token at an instant.
 *
 * The contract is asked first and its revert is classified afterwards, rather
 * than the wallet deciding in advance which question the contract would
 * decline. The classification uses entry v1's effective time, never a revert
 * reason — the ERC does not standardize those.
 */
export async function buildTemporalView(reader, tokenId, instant, options = {}) {
    const conformance = await detectConformance(reader);
    requireProjectionConformance(reader, conformance);
    const pin = options.identityPin ?? new ContractIdentityPin(reader);
    const identity = await pin.read(conformance);
    const observedAt = await reader.chainInstant();
    const entryCount = await reader.entryCount(tokenId);
    if (entryCount === 0n) {
        throw new ProjectionNotInitialized(tokenId);
    }
    const first = await reader.entryAt(tokenId, 1n);
    const latest = await reader.currentEntry(tokenId);
    let reportedFinal;
    let finalityFailure;
    try {
        reportedFinal = await reader.isFinalAsOf(tokenId, instant);
    }
    catch (error) {
        // isFinalAsOf is specified never to revert, so a failure here is a
        // transport or contract fault, not a property of the instant.
        finalityFailure = error instanceof Error ? error.message : String(error);
    }
    return {
        identity,
        conformance,
        tokenId,
        instant,
        observedAt,
        entryCount,
        resolution: await resolve(reader, tokenId, instant, first.effectiveAt),
        contest: await contestOf(reader, tokenId, instant, conformance.settlement),
        finality: describeFinality({
            tokenId,
            instant,
            reported: reportedFinal,
            firstEffectiveAt: first.effectiveAt,
            latestEffectiveAt: latest.effectiveAt,
            ...(finalityFailure === undefined ? {} : { unavailableReason: finalityFailure }),
        }),
        tradeablePosition: {
            owner: await reader.ownerOf(tokenId),
            disclosure: DISCLOSURE_POSITION,
        },
    };
}
async function contestOf(reader, tokenId, instant, hasSettlementInterface) {
    if (!hasSettlementInterface || reader.openGapOf === undefined || reader.settlement === undefined) {
        return describeContest({ tokenId, instant, hasSettlementInterface: false, gap: undefined });
    }
    const settlementId = await reader.openGapOf(tokenId);
    if (settlementId === ZERO_BYTES32) {
        return describeContest({ tokenId, instant, hasSettlementInterface: true, gap: undefined });
    }
    return describeContest({
        tokenId,
        instant,
        hasSettlementInterface: true,
        gap: { settlementId, record: await reader.settlement(settlementId) },
    });
}
async function resolve(reader, tokenId, instant, firstEffectiveAt) {
    let entry;
    try {
        entry = await reader.entryAsOf(tokenId, instant);
    }
    catch (error) {
        if (!(error instanceof ContractRevertError))
            throw error;
        // Classify the revert from protocol data. Anything else stays unattributed
        // rather than being reported as a cause the wallet cannot establish.
        if (instant < firstEffectiveAt) {
            return { kind: 'not-covered', firstEffectiveAt, note: NOTE_NOT_COVERED };
        }
        return { kind: 'unavailable', reason: error.message, note: NOTE_UNAVAILABLE };
    }
    let holder;
    try {
        holder = await reader.holderAsOf(tokenId, instant);
    }
    catch (error) {
        if (!(error instanceof ContractRevertError))
            throw error;
        return { kind: 'unavailable', reason: error.message, note: NOTE_UNAVAILABLE };
    }
    return {
        kind: 'resolved',
        holder,
        entry,
        interval: {
            from: entry.effectiveAt,
            until: entry.supersededAt === 0n ? undefined : entry.supersededAt,
        },
        holderAgreesWithEntry: holder === entry.holder,
    };
}
