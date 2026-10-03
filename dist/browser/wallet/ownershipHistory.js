import { decodeLog, encodeTopic, topicOf } from "../sdk/events.js";
import { ZERO_ADDRESS, } from "../sdk/types.js";
const NOTE_UNAVAILABLE = 'This reader cannot fetch logs, so the ERC-721 ownership sequence cannot be ' +
    'read and only the projection is shown. That is half the record; an empty ' +
    'position history here is not a statement that the token never moved.';
const NOTE_AVAILABLE = 'Both sequences the ERC tracks, ordered by instant. A position change is ' +
    'dated by the block that recorded it; an entry by the effective time the ' +
    'register gave it, which routinely precedes the block that admitted it.';
const CAVEAT = 'Pairing a position change with an entry is this wallet’s inference, not the ' +
    'protocol’s. ERC-8415 defines no link between a transfer and the entry that ' +
    'records it, and an entry naming the same party may have an entirely ' +
    'different cause. Read a correspondence as apparent, and a lag as the ' +
    'interval between two facts rather than the duration of one process.';
export async function buildOwnershipHistory(reader, tokenId) {
    const entries = await readEntries(reader, tokenId);
    if (reader.getLogs === undefined || reader.chainInstantAt === undefined) {
        return {
            tokenId,
            available: false,
            timeline: entries.timeline,
            positionChanges: 0,
            entries: entries.timeline.length,
            outstanding: [],
            correspondences: [],
            note: NOTE_UNAVAILABLE,
            caveat: CAVEAT,
        };
    }
    const logs = await reader.getLogs({
        address: reader.source.address,
        topics: [topicOf('Transfer'), null, null, encodeTopic('uint256', tokenId)],
    });
    const positions = [];
    for (const log of logs) {
        const decoded = decodeLog(log);
        if (decoded?.kind !== 'Transfer')
            continue;
        positions.push({
            kind: 'position',
            at: await reader.chainInstantAt(decoded.blockNumber),
            blockNumber: decoded.blockNumber,
            from: decoded.from,
            to: decoded.to,
            minted: decoded.from === ZERO_ADDRESS,
        });
    }
    const correspondences = positions.map((position) => correspond(position, entries.records));
    const timeline = [...positions, ...entries.timeline].sort((left, right) => Number(left.at - right.at) || rank(left) - rank(right));
    return {
        tokenId,
        available: true,
        timeline,
        positionChanges: positions.length,
        entries: entries.records.length,
        outstanding: correspondences.filter((item) => item.state === 'outstanding'),
        correspondences,
        note: NOTE_AVAILABLE,
        caveat: CAVEAT,
    };
}
/** Where two events share an instant, the position change is shown first. */
function rank(event) {
    return event.kind === 'position' ? 0 : 1;
}
async function readEntries(reader, tokenId) {
    const count = await reader.entryCount(tokenId);
    const records = [];
    const timeline = [];
    for (let version = 1n; version <= count; version += 1n) {
        const entry = await reader.entryAt(tokenId, version);
        records.push({ version, effectiveAt: entry.effectiveAt, holder: entry.holder });
        timeline.push({
            kind: 'entry',
            at: entry.effectiveAt,
            version,
            holder: entry.holder,
            recordCommitment: entry.recordCommitment,
            admittedInBlock: undefined,
        });
    }
    return { records, timeline };
}
function correspond(position, records) {
    const apparent = records.find((record) => record.holder === position.to && record.effectiveAt >= position.at);
    return {
        to: position.to,
        positionAt: position.at,
        blockNumber: position.blockNumber,
        apparentEntry: apparent === undefined
            ? undefined
            : { version: apparent.version, effectiveAt: apparent.effectiveAt },
        lag: apparent === undefined ? undefined : apparent.effectiveAt - position.at,
        state: apparent === undefined ? 'outstanding' : 'apparently-registered',
    };
}
