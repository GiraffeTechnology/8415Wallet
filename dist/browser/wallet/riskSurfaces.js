import { detectConformance } from "../sdk/conformance.js";
import { ZERO_BYTES32 } from "../sdk/types.js";
import { buildSettlementLog } from "./settlementLog.js";
const NOTE = 'Reported as facts. The wallet does not score these, does not produce a ' +
    'safe or unsafe verdict, and gates nothing on them. What a right does with ' +
    'them is decided by its own terms.';
/** A year, as the point past which a future effective time is worth remarking on. */
const FAR_FUTURE_DRIFT = 365n * 24n * 60n * 60n;
export async function buildRiskSurfaces(reader, tokenId, options = {}) {
    const conformance = await detectConformance(reader);
    const observedAt = await reader.chainInstant();
    const latest = await reader.currentEntry(tokenId);
    const surfaces = [];
    // Stalled register.
    const standing = observedAt - latest.effectiveAt;
    surfaces.push({
        id: 'stalled-register',
        heading: 'How long the latest entry has stood',
        finding: `The latest entry (v${latest.version}) took effect at ${latest.effectiveAt}; ` +
            `${standing} seconds have passed since. No entry has been admitted after it.`,
        meaning: 'Finality depends on a later entry existing. A register that stops ' +
            'producing entries leaves recent instants permanently non-final, and ' +
            'anything waiting on them waits indefinitely. This is a liveness ' +
            'dependency on the register and its profile, not a safety defect.',
        present: standing > 0n,
    });
    // Held-open gap, measured by supersessions.
    const log = await buildSettlementLog(reader, tokenId);
    const supersessions = log.episodes.filter((episode) => episode.closure === 'superseded').length;
    const openGap = conformance.settlement && reader.openGapOf !== undefined
        ? await reader.openGapOf(tokenId)
        : ZERO_BYTES32;
    surfaces.push({
        id: 'held-open-gap',
        heading: 'Supersessions on this token',
        finding: log.available
            ? `${supersessions} settlement(s) on this token were superseded rather than ` +
                `admitted or cancelled. A gap is ${openGap === ZERO_BYTES32 ? 'not ' : ''}open now.`
            : 'Logs could not be read, so supersessions cannot be counted. Absence of a ' +
                'count here is not a count of zero.',
        meaning: 'Whoever may begin settlements can supersede indefinitely, keeping a ' +
            "token's gap open and leaving every recent instant non-final and " +
            'contested. Nothing is misreported when this happens — the projection ' +
            'states exactly that the answer is unsettled — but it stops tracking the ' +
            'register, which is the one thing it exists to do.',
        present: supersessions > 0,
    });
    // Authority scope.
    const authorized = conformance.settlement && reader.isSettlementAuthority !== undefined && options.account !== undefined
        ? await reader.isSettlementAuthority(tokenId, options.account)
        : undefined;
    surfaces.push({
        id: 'authority-scope',
        heading: 'Who may move the answer',
        finding: !conformance.settlement
            ? 'This contract offers no settlement interface, so no authority is reported.'
            : options.account === undefined
                ? 'No account was supplied, so no authority is reported. `isSettlementAuthority` ' +
                    'answers for any account you name.'
                : `isSettlementAuthority reports ${authorized} for ${options.account}.`,
        meaning: 'The ability to begin settlements is a privilege: it can advance the ' +
            'projection and it can withhold. Reading who holds it is not approving ' +
            'them — a consumer relying on the projection must decide whether it ' +
            'accepts that authority, exactly as it must decide about the profile.',
        present: conformance.settlement,
    });
    // Profile acceptance.
    const profile = conformance.settlement && reader.verificationProfile !== undefined
        ? await reader.verificationProfile()
        : undefined;
    surfaces.push({
        id: 'profile-acceptance',
        heading: 'What is accepted as proof',
        finding: profile === undefined
            ? 'This contract names no verification profile, so what it accepts as proof ' +
                'cannot be identified from here.'
            : `Proofs are accepted under profile ${profile}.`,
        meaning: 'A proof establishes that bytes were included in accepted finalized ' +
            'remote state. It does not establish that an asset exists, that a ' +
            'registrar told the truth, or that a record is legally effective. Where ' +
            'the register is not itself a ledger with consensus, some party commits ' +
            'to its contents; identifying that party is part of the profile you must ' +
            'accept before relying on the projection.',
        present: true,
    });
    // Far-future effective time.
    const drift = latest.effectiveAt > observedAt ? latest.effectiveAt - observedAt : 0n;
    surfaces.push({
        id: 'far-future-effective-time',
        heading: 'Effective time ahead of now',
        finding: drift === 0n
            ? "The latest entry's effective time is at or before now."
            : `The latest entry's effective time is ${drift} seconds ahead of now.`,
        meaning: 'Effective times strictly increase, so an admitted effective time far in ' +
            'the future permanently ends the projection for that token: no later ' +
            'entry can exceed it. Nothing in the ERC bounds how far ahead one may ' +
            'be; a profile that cannot rule it out inherits an unrecoverable state.',
        present: drift > FAR_FUTURE_DRIFT,
    });
    return { tokenId, observedAt, surfaces, note: NOTE };
}
