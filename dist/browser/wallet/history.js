import { detectConformance, requireProjectionConformance } from "../sdk/conformance.js";
import { ProjectionNotInitialized } from "../sdk/errors.js";
import { ContractIdentityPin } from "../sdk/identity.js";
import { ZERO_BYTES32, } from "../sdk/types.js";
const NOTE_INTACT = 'Every entry links to its predecessor by commitment, versions are ' +
    'consecutive, effective times strictly increase, and each interval is ' +
    'closed at its successor. Commitments are compared, never recomputed: the ' +
    'register’s contents are off chain and the wallet cannot see them.';
const NOTE_BROKEN = 'One or more links do not hold. These are the invariants that make an ' +
    'instant resolve to exactly one holder, so a projection that breaks them ' +
    'cannot be relied on. The entries are shown exactly as read.';
/**
 * Walk a token's entries.
 *
 * The chain check compares values the contract handed over against the
 * invariants the ERC states. That is verification of received data, not
 * recomputation of a protocol answer: the wallet never derives a holder or a
 * finality answer from it, and reports faults rather than correcting them.
 */
export async function buildHistoryView(reader, tokenId, options = {}) {
    const conformance = await detectConformance(reader);
    requireProjectionConformance(reader, conformance);
    const pin = options.identityPin ?? new ContractIdentityPin(reader);
    const identity = await pin.read(conformance);
    const count = await reader.entryCount(tokenId);
    if (count === 0n) {
        throw new ProjectionNotInitialized(tokenId);
    }
    const entries = [];
    for (let version = 1n; version <= count; version += 1n) {
        entries.push(await reader.entryAt(tokenId, version));
    }
    const views = entries.map((entry, index) => {
        const previous = index === 0 ? undefined : entries[index - 1];
        const isLatest = index === entries.length - 1;
        return {
            entry,
            intervalEnd: entry.supersededAt === 0n ? undefined : entry.supersededAt,
            linkFaults: checkLink(entry, previous, isLatest ? undefined : entries[index + 1]),
        };
    });
    const chainIntact = views.every((view) => view.linkFaults.length === 0);
    return {
        identity,
        conformance,
        tokenId,
        entries: views,
        chainIntact,
        note: chainIntact ? NOTE_INTACT : NOTE_BROKEN,
    };
}
function checkLink(entry, previous, next) {
    const faults = [];
    if (previous === undefined) {
        if (entry.previousCommitment !== ZERO_BYTES32) {
            faults.push('first-entry-has-nonzero-previous');
        }
    }
    else {
        if (entry.previousCommitment !== previous.recordCommitment) {
            faults.push('previous-commitment-mismatch');
        }
        if (entry.version !== previous.version + 1n) {
            faults.push('version-not-consecutive');
        }
        if (entry.effectiveAt <= previous.effectiveAt) {
            faults.push('effective-time-not-increasing');
        }
    }
    // An entry's interval is closed by the register at its successor's effective
    // time, not at the moment the chain learned of it.
    if (next !== undefined && entry.supersededAt !== next.effectiveAt) {
        faults.push('interval-not-closed-at-successor');
    }
    return faults;
}
