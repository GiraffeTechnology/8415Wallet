import { formatAddress, formatDuration, formatInstant, shortHex } from "./format.js";
import { wrapText } from "./wrap.js";
/**
 * Render the asset view as text.
 *
 * Layout carries meaning here. The position and the confirmed holder are given
 * equal weight under separate headings, each with its disclosure attached, so
 * neither can be skimmed as the answer to the other's question. The three
 * signals — finality, contest, and what the contract is — are separate blocks
 * for the same reason.
 */
export function renderAssetView(view) {
    const lines = [];
    const write = (text = '') => lines.push(text);
    const field = (label, value) => write(`  ${label.padEnd(20)}${value}`);
    const wrap = (text) => {
        for (const line of wrapText(text, 74))
            write(`    ${line}`);
    };
    write(`Token ${view.tokenId}  ·  ${view.identity.address}  ·  chain ${view.identity.chainId}`);
    write(`Observed at ${formatInstant(view.observedAt)}`);
    write();
    write('TRADEABLE POSITION');
    field('Owner', formatAddress(view.tradeablePosition.owner));
    wrap(view.tradeablePosition.disclosure);
    write();
    write('CONFIRMED HOLDER');
    field('Holder', formatAddress(view.confirmedHolder.holder));
    field('Admitted by', `entry v${view.confirmedHolder.version} of ${view.confirmedHolder.entryCount}, ` +
        `effective ${formatInstant(view.confirmedHolder.effectiveAt)}`);
    field('Commitment', shortHex(view.confirmedHolder.recordCommitment));
    field('Previous', shortHex(view.confirmedHolder.previousCommitment));
    field('Reference', `${shortHex(view.confirmedHolder.registryReference)}  (opaque locator)`);
    wrap(view.confirmedHolder.disclosure);
    write();
    write(`ALIGNMENT  ·  ${view.alignment.aligned ? 'agree' : 'diverged'}`);
    wrap(view.alignment.note);
    write();
    write(`FINALITY OF THE PRESENT  ·  ${view.presentFinality.final ? 'Final' : 'Provisional'}`);
    wrap(view.presentFinality.explanation);
    write();
    write(`SETTLEMENT GAP  ·  ${gapHeadline(view)}`);
    if (view.gap.kind === 'open') {
        field('Settlement', shortHex(view.gap.settlementId));
        field('Opened at', formatInstant(view.gap.openedAt));
        field('Deadline', formatInstant(view.gap.deadline));
        field('Time remaining', `${formatDuration(view.gap.timeRemaining)} of a ${formatDuration(view.gap.settlementPeriod)} period`);
        field('Expected holder', formatAddress(view.gap.expectedHolder));
        field('Initiator', formatAddress(view.gap.initiator));
        field('Contested from', formatInstant(view.gap.contestedFrom));
        field('Cancellable', view.gap.cancellable ? 'yes, the deadline has passed' : 'no, before deadline');
    }
    wrap(view.gap.note);
    write();
    write('SETTLEMENT AUTHORITY');
    if (view.authority.account !== undefined) {
        field('Account', formatAddress(view.authority.account));
    }
    // Three states, not two. `undefined` means the contract could not be asked,
    // and rendering that as "no" would report an answer nobody gave.
    field('May open a gap', view.authority.authorized === undefined
        ? 'not reported'
        : view.authority.authorized
            ? 'yes'
            : 'no');
    wrap(view.authority.note);
    write();
    write('CONTRACT IDENTITY');
    field('Register', shortHex(view.identity.registerId));
    field('Profile', view.identity.verificationProfile === undefined
        ? 'none — no settlement interface'
        : shortHex(view.identity.verificationProfile));
    field('Settlement period', view.settlementPeriod === undefined
        ? 'none — no settlement interface'
        : `${formatDuration(view.settlementPeriod)} maximum for any one gap`);
    field('Conformance', [
        view.conformance.projection ? 'projection 0x6309e170' : 'projection absent',
        view.conformance.settlement ? 'settlement 0xf4a7d71b' : 'settlement absent',
    ].join('  ·  '));
    wrap(view.identityNote);
    return lines.join('\n');
}
function gapHeadline(view) {
    switch (view.gap.kind) {
        case 'unsupported':
            return 'not offered by this contract';
        case 'none':
            return 'none open';
        case 'open':
            return 'open';
    }
}
