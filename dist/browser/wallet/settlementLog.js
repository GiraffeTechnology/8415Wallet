import { decodeLog, tokenFilter, } from "../sdk/events.js";
const MEANING = {
    admitted: 'An entry was appended. Instants before its effective time are now final; ' +
        'instants at or after it are not.',
    cancelled: 'The contest ended and nothing settled. The preceding entry stays in ' +
        'force and no instant became final. This is not a rejection — the ' +
        'protocol defines no such event.',
    superseded: 'A new settlement replaced this one. The projection is unchanged, and any ' +
        'proof already produced for this settlement is now unusable.',
    'still-open': 'A change is in flight. Nothing has settled yet.',
};
const NOTE_UNAVAILABLE = 'This reader cannot fetch logs, so gap transitions cannot be shown. The ' +
    'entry walk still shows every admission, but a gap that closed by ' +
    'cancellation or supersession leaves no trace there and is not visible ' +
    'here either. Absence below is not evidence that none occurred.';
const NOTE_AVAILABLE = 'Every gap this token has had, and how each ended. A closure that admitted ' +
    'nothing is shown as such; it is not an omission.';
/** `GapStatus` as the contract reports it, mapped to what it means for a reader. */
const CLOSURE_BY_STATUS = {
    NONE: 'still-open',
    OPEN: 'still-open',
    ADMITTED: 'admitted',
    CANCELLED: 'cancelled',
    SUPERSEDED: 'superseded',
};
const SETTLEMENT_EVENTS = [
    'SettlementStarted',
    'SettlementFinalized',
    'SettlementCancelled',
    'SettlementSuperseded',
];
/**
 * Read a token's gap transitions and fold them into episodes.
 *
 * When the reader cannot fetch logs the view says so explicitly rather than
 * returning an empty list: an empty list and "cannot be read" are different
 * claims, and only one of them means no gap ever opened.
 */
export async function buildSettlementLog(reader, tokenId) {
    if (reader.getLogs === undefined) {
        return { tokenId, available: false, episodes: [], events: [], note: NOTE_UNAVAILABLE };
    }
    const collected = [];
    for (const name of SETTLEMENT_EVENTS) {
        const logs = await reader.getLogs(tokenFilter(reader.source.address, name, tokenId));
        for (const log of logs) {
            const decoded = decodeLog(log);
            if (decoded !== undefined)
                collected.push(decoded);
        }
    }
    collected.sort((left, right) => Number(left.blockNumber - right.blockNumber) || Number(left.logIndex - right.logIndex));
    return {
        tokenId,
        available: true,
        episodes: await enrich(reader, foldEpisodes(collected)),
        events: collected,
        note: NOTE_AVAILABLE,
    };
}
/**
 * Take each episode's state from the contract.
 *
 * The log says which settlements existed and carries their details; the
 * contract says what became of each. Where both speak, the contract is
 * authoritative — a log can be truncated by a node's retention, and a status
 * folded from a partial log would be a guess.
 */
async function enrich(reader, episodes) {
    if (reader.settlement === undefined)
        return [...episodes];
    const enriched = [];
    for (const episode of episodes) {
        try {
            const record = await reader.settlement(episode.settlementId);
            const closure = CLOSURE_BY_STATUS[record.status];
            enriched.push({
                ...episode,
                openedAt: record.openedAt,
                deadline: record.deadline,
                expectedHolder: record.expectedHolder,
                initiator: record.initiator,
                closure,
                meaning: MEANING[closure],
            });
        }
        catch {
            // The record could not be read. The log-derived episode stands, with
            // openedAt left absent rather than filled in.
            enriched.push(episode);
        }
    }
    return enriched;
}
function foldEpisodes(events) {
    const byId = new Map();
    const order = [];
    for (const event of events) {
        switch (event.kind) {
            case 'SettlementStarted':
                byId.set(event.settlementId, {
                    settlementId: event.settlementId,
                    openedAt: undefined,
                    deadline: event.deadline,
                    expectedHolder: event.expectedHolder,
                    initiator: event.initiator,
                    closure: 'still-open',
                    meaning: MEANING['still-open'],
                });
                order.push(event.settlementId);
                break;
            case 'SettlementFinalized':
                update(byId, event.settlementId, {
                    closure: 'admitted',
                    admitted: { version: event.version, effectiveAt: event.effectiveAt },
                    meaning: MEANING.admitted,
                });
                break;
            case 'SettlementCancelled':
                update(byId, event.settlementId, {
                    closure: 'cancelled',
                    meaning: MEANING.cancelled,
                });
                break;
            case 'SettlementSuperseded':
                update(byId, event.supersededId, {
                    closure: 'superseded',
                    replacedBy: event.replacementId,
                    meaning: MEANING.superseded,
                });
                break;
            default:
                break;
        }
    }
    return order.flatMap((id) => {
        const episode = byId.get(id);
        return episode === undefined ? [] : [episode];
    });
}
function update(byId, settlementId, patch) {
    const existing = byId.get(settlementId);
    // A closure for a settlement whose opening was never seen is dropped rather
    // than invented: the log may have been truncated, and a half-known episode
    // would be a claim the wallet cannot support.
    if (existing !== undefined)
        byId.set(settlementId, { ...existing, ...patch });
}
