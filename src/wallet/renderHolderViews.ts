import type { AcquisitionDisclosure } from './acquisition.ts';
import type { CollisionReport } from './collisions.ts';
import { formatAddress, formatDuration, formatInstant, shortHex } from './format.ts';
import type { PostureView } from './posture.ts';
import type { RegistrationView } from './registration.ts';
import { wrapText } from './wrap.ts';

const WIDTH = 74;

function block(lines: string[], text: string, indent = '    '): void {
  for (const line of wrapText(text, WIDTH)) lines.push(`${indent}${line}`);
}

/** The holder-facing answer: what is happening, and whether they do anything. */
export function renderRegistration(view: RegistrationView): string {
  const lines: string[] = [];
  lines.push(`REGISTRATION  ·  ${view.headline}`);
  lines.push('');
  block(lines, view.meaning);
  lines.push('');
  lines.push('  What you do');
  block(lines, view.action, '      ');

  if (view.registering !== undefined) {
    lines.push('');
    lines.push(`  Being registered now   ${formatAddress(view.registering)}`);
    lines.push(
      `  More behind it         ${view.furtherHopsBehind ? 'yes — at least one further transfer' : 'no'}`,
    );
  }

  if (view.commitmentWindow !== undefined) {
    lines.push('');
    lines.push(`  Agreed window          ${formatInstant(view.commitmentWindow.deadline)}`);
    lines.push(
      `  ${view.commitmentWindow.passed ? 'Passed' : 'Remaining'.padEnd(22)}${
        view.commitmentWindow.passed
          ? `                 yes, ${formatDuration(-view.commitmentWindow.remaining)} ago`
          : formatDuration(view.commitmentWindow.remaining)
      }`,
    );
    lines.push('');
    block(lines, view.commitmentWindow.note, '      ');
  }

  lines.push('');
  lines.push('  Who to ask');
  block(lines, view.whoToAsk, '      ');
  return lines.join('\n');
}

/** Facts for a decision not yet made. Never a verdict. */
export function renderAcquisitionDisclosure(view: AcquisitionDisclosure): string {
  const lines: string[] = [];
  lines.push(`BEFORE YOU ACQUIRE  ·  token ${view.tokenId}`);
  lines.push('');
  lines.push(`  Position now     ${formatAddress(view.position)}`);
  lines.push(`  Register says    ${formatAddress(view.confirmedHolder)}`);
  lines.push('');
  for (const point of view.points) {
    block(lines, `• ${point}`, '  ');
    lines.push('');
  }
  block(lines, view.boundary, '  ');
  return lines.join('\n');
}

/** The pair, with stale as its own case. */
export function renderPosture(view: PostureView): string {
  const lines: string[] = [];
  lines.push(`POSTURE  ·  ${view.label}`);
  lines.push('');
  block(lines, view.explanation);
  lines.push('');
  lines.push('  Projection');
  block(lines, view.projection, '      ');
  lines.push('');
  lines.push('  Attestation feed');
  block(lines, view.feed, '      ');
  lines.push('');
  lines.push('  Reference pattern (non-normative, not advice)');
  block(lines, view.referencePattern, '      ');
  lines.push('');
  block(lines, view.boundary, '  ');
  return lines.join('\n');
}

/** Collisions across the tokens examined, with the limit of the check stated. */
export function renderCollisions(report: CollisionReport): string {
  const lines: string[] = [];
  lines.push(
    `CROSS-TOKEN CHECK  ·  ${report.tokensExamined.length} token(s), ` +
      `${report.entriesExamined} entries`,
  );
  lines.push('');

  if (report.collisions.length === 0) {
    lines.push('  No collision among the tokens examined.');
  }
  for (const collision of report.collisions) {
    lines.push(
      `  ${collision.crossToken ? 'CROSS-TOKEN' : 'WITHIN ONE TOKEN'}  ${collision.kind}  ` +
        shortHex(collision.value),
    );
    for (const occurrence of collision.occurrences) {
      lines.push(`      token ${occurrence.tokenId}  v${occurrence.version}`);
    }
    block(lines, collision.note, '      ');
    lines.push('');
  }

  lines.push('');
  block(lines, report.scopeNote, '  ');
  return lines.join('\n');
}
