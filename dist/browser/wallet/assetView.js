import { detectConformance, requireProjectionConformance } from "../sdk/conformance.js";
import { ProjectionNotInitialized } from "../sdk/errors.js";
import { ContractIdentityPin } from "../sdk/identity.js";
import { ZERO_BYTES32, } from "../sdk/types.js";
const DISCLOSURE_POSITION = 'The ERC-721 position. It moves the moment the market moves, and it is not ' +
    'the confirmed holder at any instant.';
const DISCLOSURE_HOLDER = 'The holder the register has confirmed, from the latest admitted entry. It ' +
    'moves only through proof-verified admission.';
const NOTE_ALIGNED = 'The position and the confirmed holder currently agree. They are still two ' +
    'separate facts, and they may diverge again at any time. Agreement is not ' +
    'verified identity: the protocol does not, and cannot, check that these two ' +
    'records refer to the same underlying right. It reports what each side says.';
const NOTE_DIVERGED = 'The position and the confirmed holder currently differ. This is the design, ' +
    'not a fault: the token keeps trading while the register catches up. Neither ' +
    'agreement nor divergence is verified identity — the protocol does not, and ' +
    'cannot, check that these two records refer to the same underlying right.';
const NOTE_IDENTITY_WITH_PROFILE = 'This projection is attributable to the register and profile above. Whether ' +
    'to accept them is your decision; reading them is not approving them.';
const NOTE_IDENTITY_WITHOUT_PROFILE = 'This projection is attributable to the register above. The contract names ' +
    'no verification profile, so what it accepts as proof cannot be checked ' +
    'from here. Whether to accept the register is your decision.';
const NOTE_NO_SETTLEMENT_INTERFACE = 'This contract offers no settlement interface, so it has no gaps and no ' +
    'contested instants at all. That is a property of the contract, not an ' +
    'observation that no gap is open.';
const NOTE_NO_OPEN_GAP = 'No gap is open. An interval in which none is open and none is begun is an ' +
    'interval the projection cannot move in.';
const NOTE_OPEN_GAP = 'A change is in flight. An open gap says what is expected, not what has ' +
    'settled, and closing it does not by itself make any instant final.';
/**
 * Build the asset view for a token.
 *
 * Conformance is checked before anything from the projection is read, so a
 * contract that never claimed a projection cannot have one displayed for it.
 */
export async function buildAssetView(reader, tokenId, options = {}) {
    const conformance = await detectConformance(reader);
    requireProjectionConformance(reader, conformance);
    const pin = options.identityPin ?? new ContractIdentityPin(reader);
    const identity = await pin.read(conformance);
    const observedAt = await reader.chainInstant();
    const owner = await reader.ownerOf(tokenId);
    const entryCount = await reader.entryCount(tokenId);
    if (entryCount === 0n) {
        // No entries means the projection has not been initialized. The wallet
        // says so rather than presenting the position as if it were the record.
        throw new ProjectionNotInitialized(tokenId);
    }
    const latest = await reader.currentEntry(tokenId);
    const presentFinal = await reader.isFinalAsOf(tokenId, observedAt);
    return {
        identity,
        conformance,
        tokenId,
        observedAt,
        tradeablePosition: { owner, disclosure: DISCLOSURE_POSITION },
        confirmedHolder: {
            holder: latest.holder,
            version: latest.version,
            effectiveAt: latest.effectiveAt,
            recordCommitment: latest.recordCommitment,
            previousCommitment: latest.previousCommitment,
            registryReference: latest.registryReference,
            entryCount,
            disclosure: DISCLOSURE_HOLDER,
        },
        alignment: {
            aligned: owner === latest.holder,
            note: owner === latest.holder ? NOTE_ALIGNED : NOTE_DIVERGED,
        },
        presentFinality: {
            instant: observedAt,
            final: presentFinal,
            latestEffectiveAt: latest.effectiveAt,
            explanation: explainPresentFinality(presentFinal, observedAt, latest.effectiveAt),
        },
        gap: await buildGapView(reader, tokenId, conformance, observedAt),
        settlementPeriod: conformance.settlement && reader.settlementPeriod !== undefined
            ? await reader.settlementPeriod()
            : undefined,
        authority: await buildAuthorityView(reader, tokenId, conformance, options.account),
        identityNote: identity.verificationProfile === undefined
            ? NOTE_IDENTITY_WITHOUT_PROFILE
            : NOTE_IDENTITY_WITH_PROFILE,
    };
}
function explainPresentFinality(final, observedAt, latestEffectiveAt) {
    if (final) {
        return (`The contract reports the present instant (${observedAt}) as final, which ` +
            `the finality rule does not allow: it is at or after the latest entry's ` +
            `effective time (${latestEffectiveAt}). Treat this contract's answers with suspicion.`);
    }
    return (`The present instant is at or after the latest entry's effective time ` +
        `(${latestEffectiveAt}), so it is provisional, as every present instant is. ` +
        `It becomes final once an entry with a later effective time is admitted — ` +
        `including a confirming entry naming the same holder.`);
}
async function buildGapView(reader, tokenId, conformance, observedAt) {
    if (!conformance.settlement || reader.openGapOf === undefined) {
        return { kind: 'unsupported', note: NOTE_NO_SETTLEMENT_INTERFACE };
    }
    const settlementId = await reader.openGapOf(tokenId);
    if (settlementId === ZERO_BYTES32) {
        return { kind: 'none', note: NOTE_NO_OPEN_GAP };
    }
    const record = await reader.settlement(settlementId);
    const settlementPeriod = await reader.settlementPeriod();
    const timeRemaining = record.deadline - observedAt;
    return {
        kind: 'open',
        settlementId,
        initiator: record.initiator,
        expectedHolder: record.expectedHolder,
        snapshotHash: record.snapshotHash,
        openedAt: record.openedAt,
        deadline: record.deadline,
        settlementPeriod,
        timeRemaining,
        cancellable: observedAt > record.deadline,
        contestedFrom: record.openedAt,
        note: NOTE_OPEN_GAP,
    };
}
async function buildAuthorityView(reader, tokenId, conformance, account) {
    if (!conformance.settlement || reader.isSettlementAuthority === undefined) {
        return {
            account,
            authorized: undefined,
            note: 'This contract offers no settlement interface, so there is no authority ' +
                'to report. The projection is maintained by other means.',
        };
    }
    if (account === undefined) {
        return {
            account: undefined,
            authorized: undefined,
            note: 'No account supplied, so no authority is reported. Who may open a gap ' +
                'is a separate question from who owns the token.',
        };
    }
    const authorized = await reader.isSettlementAuthority(tokenId, account);
    return {
        account,
        authorized,
        note: authorized
            ? 'This account may open a gap on this token, and can therefore advance ' +
                'the projection — or hold a gap open by superseding.'
            : 'This account may not open a gap on this token. Owning the token does ' +
                'not confer the authority.',
    };
}
