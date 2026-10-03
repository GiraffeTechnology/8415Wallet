const NEVER_BLOCKS = 'Your token is not blocked and never will be by this. It can be transferred ' +
    'at any time; only the register is behind.';
const SERIAL = 'Registration is sequential and physical: the token can change hands on ' +
    'chain every few minutes, while the register records each transfer one at a ' +
    'time — first one hop, then the next. No wallet or standard removes that lag.';
export function describeRegistration(view) {
    const position = view.tradeablePosition.owner;
    const confirmed = view.confirmedHolder.holder;
    const gap = view.gap;
    const inFlight = gap.kind === 'open' ? gap.expectedHolder : undefined;
    const furtherHopsBehind = inFlight !== undefined && inFlight !== position;
    const state = gap.kind === 'unsupported'
        ? 'no-gap-interface'
        : gap.kind === 'open'
            ? furtherHopsBehind
                ? 'registering-with-more-behind'
                : 'registering'
            : confirmed === position
                ? 'level'
                : 'behind-with-nothing-in-flight';
    return {
        state,
        headline: HEADLINES[state],
        meaning: meaningFor(state, { position, confirmed, inFlight }),
        action: ACTIONS[state],
        commitmentWindow: gap.kind === 'open'
            ? {
                deadline: gap.deadline,
                passed: gap.cancellable,
                remaining: gap.timeRemaining,
                note: gap.cancellable
                    ? 'The window the register was given has passed. That is a signal the ' +
                        'transfer being recorded may itself have an issue. What follows — ' +
                        'whether a trade can be unwound, by whom, on what terms — is governed by ' +
                        'the terms you agreed with your counterparty. It is not decided by this ' +
                        'protocol and not by this wallet.'
                    : 'The register has until this time under the agreed window. Nothing is ' +
                        'wrong while it has not passed.',
            }
            : undefined,
        registering: inFlight,
        furtherHopsBehind,
        whoToAsk: whoToAsk(view),
        registerId: view.identity.registerId,
    };
}
const HEADLINES = {
    level: 'The register is up to date',
    registering: 'A transfer is being registered',
    'registering-with-more-behind': 'A transfer is being registered, and more are behind it',
    'behind-with-nothing-in-flight': 'The register is behind, and nothing is being recorded',
    'no-gap-interface': 'This contract records no registrations in flight',
};
const ACTIONS = {
    level: 'Nothing. The register and the position agree.',
    registering: 'Wait. There is nothing for you to do and nothing to fix.',
    'registering-with-more-behind': 'Wait. There is nothing for you to do. Each transfer is recorded in turn, so ' +
        'yours follows the one in flight.',
    'behind-with-nothing-in-flight': 'Wait, and watch the register. No change is currently in flight, so nothing ' +
        'will move until the registrar opens one.',
    'no-gap-interface': 'Nothing here. This contract keeps a projection by other means, so it never ' +
        'reports a change in flight.',
};
function meaningFor(state, parties) {
    switch (state) {
        case 'level':
            return (`The register confirms ${parties.confirmed}, which is also the current ` +
                `position. Nothing is pending. ${NEVER_BLOCKS}`);
        case 'registering':
            return (`A previous transfer has not yet been recorded by the register. This is not a ` +
                `failure and not an error — it is the register catching up. The change in ` +
                `flight will record ${parties.inFlight}, bringing the register level with the ` +
                `position. ${SERIAL} ${NEVER_BLOCKS}`);
        case 'registering-with-more-behind':
            return (`A previous transfer has not yet been recorded. This is not a failure — it is ` +
                `the register catching up. The change in flight records ${parties.inFlight}, but ` +
                `the position has already moved on to ${parties.position}, so at least one more ` +
                `registration must follow this one before the register is level. ${SERIAL} ` +
                `${NEVER_BLOCKS}`);
        case 'behind-with-nothing-in-flight':
            return (`The register confirms ${parties.confirmed} while the position is ` +
                `${parties.position}, and no change is currently in flight to record the ` +
                `difference. This is not a failure; it means the registrar has not yet opened ` +
                `one. ${SERIAL} ${NEVER_BLOCKS}`);
        case 'no-gap-interface':
            return ('This contract offers no settlement interface, so it never reports a change ' +
                `in flight. The register confirms ${parties.confirmed}. ${NEVER_BLOCKS}`);
    }
}
/**
 * Who to ask, and what the wallet cannot tell you.
 *
 * `registerId` and the settlement authority are on-chain identifiers.
 * Resolving either to a party a person can contact is defined by the
 * verification profile and lives off chain. Saying so is better than leaving a
 * holder to conclude there is nobody to ask.
 */
function whoToAsk(view) {
    const authority = view.authority.account !== undefined && view.authority.authorized === true
        ? `Your own account may open a gap on this token, so you are one of the parties ` +
            `who can move the answer. `
        : '';
    return (`${authority}The register is identified on chain as ${view.identity.registerId}, and ` +
        `who may move the answer is answered by the contract for any account you name. ` +
        `Neither resolves to a name, an address or a contact from on-chain data alone — ` +
        `that mapping is defined by the verification profile and kept off chain. The wallet ` +
        `cannot look it up for you; your counterparty or the issuer can.`);
}
