import type { AcquisitionDisclosure } from './acquisition.ts';
import type { CollisionReport } from './collisions.ts';
import { formatAddress, formatDuration, formatInstant, shortHex } from './format.ts';
import type { OwnershipHistoryView } from './ownershipHistory.ts';
import type { PostureView } from './posture.ts';
import type { RegistrationView } from './registration.ts';
import { wrapText } from './wrap.ts';

const WIDTH = 74;

function blockText(lines: string[], text: string, indent: string, translate: (text: string) => string): void {
  for (const line of wrapText(translate(text), WIDTH)) lines.push(translate(`${indent}${line}`));
}

/** The holder-facing answer: what is happening, and whether they do anything. */
export function renderRegistration(view: RegistrationView, translate: (text: string) => string = text => text): string {
  const block = (lines: string[], text: string, indent = '    ') => blockText(lines, text, indent, translate);
  const lines: string[] = [];
  lines.push(translate(`REGISTRATION  ·  ${view.headline}`));
  lines.push(translate(''));
  block(lines, view.meaning);
  lines.push(translate(''));
  lines.push(translate('  What you do'));
  block(lines, view.action, '      ');

  if (view.registering !== undefined) {
    lines.push(translate(''));
    lines.push(translate(`  Being registered now   ${formatAddress(view.registering)}`));
    lines.push(
      translate(`  More behind it         ${view.furtherHopsBehind ? 'yes — at least one further transfer' : 'no'}`),
    );
  }

  if (view.commitmentWindow !== undefined) {
    lines.push(translate(''));
    lines.push(translate(`  Agreed window          ${formatInstant(view.commitmentWindow.deadline)}`));
    lines.push(
      translate(`  ${view.commitmentWindow.passed ? translate('Passed') : translate('Remaining').padEnd(22)}${
        view.commitmentWindow.passed
          ? `                 ${translate(`yes, ${formatDuration(-view.commitmentWindow.remaining)} ago`)}`
          : formatDuration(view.commitmentWindow.remaining)
      }`),
    );
    lines.push(translate(''));
    block(lines, view.commitmentWindow.note, '      ');
  }

  lines.push(translate(''));
  lines.push(translate('  Who to ask'));
  block(lines, view.whoToAsk, '      ');
  return lines.join('\n');
}

/** Facts for a decision not yet made. Never a verdict. */
export function renderAcquisitionDisclosure(view: AcquisitionDisclosure, translate: (text: string) => string = text => text): string {
  const block = (lines: string[], text: string, indent = '    ') => blockText(lines, text, indent, translate);
  const lines: string[] = [];
  lines.push(translate(`BEFORE YOU ACQUIRE  ·  token ${view.tokenId}`));
  lines.push(translate(''));
  lines.push(translate(`  Position now     ${formatAddress(view.position)}`));
  lines.push(translate(`  Register says    ${formatAddress(view.confirmedHolder)}`));
  lines.push(translate(''));
  for (const point of view.points) {
    block(lines, `• ${point}`, '  ');
    lines.push(translate(''));
  }
  block(lines, view.boundary, '  ');
  return lines.join('\n');
}

/** The pair, with stale as its own case. */
export function renderPosture(view: PostureView, translate: (text: string) => string = text => text): string {
  const block = (lines: string[], text: string, indent = '    ') => blockText(lines, text, indent, translate);
  const lines: string[] = [];
  lines.push(translate(`POSTURE  ·  ${view.label}`));
  lines.push(translate(''));
  block(lines, view.explanation);
  lines.push(translate(''));
  lines.push(translate('  Projection'));
  block(lines, view.projection, '      ');
  lines.push(translate(''));
  lines.push(translate('  Attestation feed'));
  block(lines, view.feed, '      ');
  lines.push(translate(''));
  lines.push(translate('  Reference pattern (non-normative, not advice)'));
  block(lines, view.referencePattern, '      ');
  lines.push(translate(''));
  block(lines, view.boundary, '  ');
  return lines.join('\n');
}

/** Collisions across the tokens examined, with the limit of the check stated. */
export function renderCollisions(report: CollisionReport, translate: (text: string) => string = text => text): string {
  const block = (lines: string[], text: string, indent = '    ') => blockText(lines, text, indent, translate);
  const lines: string[] = [];
  lines.push(
    translate(`CROSS-TOKEN CHECK  ·  ${report.tokensExamined.length} token(s), ` +
      `${report.entriesExamined} entries`),
  );
  lines.push(translate(''));

  if (report.collisions.length === 0) {
    lines.push(translate('  No collision among the tokens examined.'));
  }
  for (const collision of report.collisions) {
    lines.push(
      translate(`  ${translate(collision.crossToken ? 'CROSS-TOKEN' : 'WITHIN ONE TOKEN')}  ${collision.kind}  ` +
        shortHex(collision.value)),
    );
    for (const occurrence of collision.occurrences) {
      lines.push(translate(`      token ${occurrence.tokenId}  v${occurrence.version}`));
    }
    block(lines, collision.note, '      ');
    lines.push(translate(''));
  }

  lines.push(translate(''));
  block(lines, report.scopeNote, '  ');
  return lines.join('\n');
}

/** Both sequences on one timeline, with what each date means kept apart. */
export function renderOwnershipHistory(view: OwnershipHistoryView, translate: (text: string) => string = text => text): string {
  const block = (lines: string[], text: string, indent = '    ') => blockText(lines, text, indent, translate);
  const lines: string[] = [];
  lines.push(
    translate(`BOTH SEQUENCES  ·  token ${view.tokenId}  ·  ` +
      `${view.positionChanges} position change(s), ${view.entries} entries`),
  );
  lines.push(translate(''));

  if (!view.available) {
    block(lines, view.note, '  ');
    return lines.join('\n');
  }

  for (const event of view.timeline) {
    if (event.kind === 'position') {
      lines.push(
        translate(`  ${formatInstant(event.at)}  ·  POSITION  ·  block ${event.blockNumber}`),
      );
      lines.push(
        translate(event.minted
          ? `      minted to ${formatAddress(event.to)}`
          : `      ${formatAddress(event.from)}\n      →  ${formatAddress(event.to)}`),
      );
    } else {
      lines.push(translate(`  ${formatInstant(event.at)}  ·  REGISTER   ·  entry v${event.version}`));
      lines.push(translate(`      confirms ${formatAddress(event.holder)}`));
      lines.push(translate(`      commitment ${shortHex(event.recordCommitment)}`));
    }
    lines.push(translate(''));
  }

  lines.push(translate('  Apparent correspondence'));
  for (const item of view.correspondences) {
    lines.push(
      translate(`      ${formatAddress(item.to)}  ${
        translate(item.state === 'outstanding'
          ? 'not yet confirmed by any entry'
          : `entry v${item.apparentEntry?.version}, ${formatDuration(item.lag ?? 0n)} later`)
      }`),
    );
  }
  lines.push(translate(''));
  block(lines, view.note, '  ');
  lines.push(translate(''));
  block(lines, view.caveat, '  ');
  return lines.join('\n');
}
