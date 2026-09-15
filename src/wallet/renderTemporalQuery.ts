import { formatAddress, formatInstant, shortHex } from './format.ts';
import type { HistoryView } from './history.ts';
import type { TemporalView } from './temporalQuery.ts';
import { wrapText } from './wrap.ts';

/**
 * Render a temporal query.
 *
 * Resolution and finality get their own blocks, in that order, because they
 * are different questions. The tradeable position is last and labelled as
 * such, so it cannot be read as the answer.
 */
export function renderTemporalQuery(view: TemporalView): string {
  const lines: string[] = [];
  const write = (text = '') => lines.push(text);
  const field = (label: string, value: string) => write(`  ${label.padEnd(18)}${value}`);
  const wrap = (text: string) => {
    for (const line of wrapText(text, 74)) write(`    ${line}`);
  };

  write(`Token ${view.tokenId}  ·  ${view.identity.address}  ·  chain ${view.identity.chainId}`);
  write(`As of        ${formatInstant(view.instant)}`);
  write(`Queried at   ${formatInstant(view.observedAt)}`);
  write();

  write('CONFIRMED HOLDER AT THIS INSTANT');
  switch (view.resolution.kind) {
    case 'resolved': {
      const { holder, entry, interval, holderAgreesWithEntry } = view.resolution;
      field('Holder', formatAddress(holder));
      field(
        'Admitted by',
        `entry v${entry.version} of ${view.entryCount}, effective ${formatInstant(entry.effectiveAt)}`,
      );
      field(
        'In force',
        interval.until === undefined
          ? `from ${formatInstant(interval.from)} — still the latest entry`
          : `${formatInstant(interval.from)}\n                    until ${formatInstant(interval.until)}`,
      );
      field('Commitment', shortHex(entry.recordCommitment));
      field('Previous', shortHex(entry.previousCommitment));
      field('Reference', `${shortHex(entry.registryReference)}  (opaque locator)`);
      if (!holderAgreesWithEntry) {
        write();
        wrap(
          `holderAsOf returned ${holder} while entryAsOf returned an entry whose ` +
            `holder is ${entry.holder}. The ERC requires these to agree; this ` +
            `contract is at fault and neither answer should be relied on.`,
        );
      }
      break;
    }
    case 'not-covered':
      field('Holder', 'none — the projection does not cover this instant');
      field('First entry', `effective ${formatInstant(view.resolution.firstEffectiveAt)}`);
      wrap(view.resolution.note);
      break;
    case 'unavailable':
      field('Holder', 'unavailable');
      field('Reason', view.resolution.reason);
      wrap(view.resolution.note);
      break;
  }
  write();

  write(`FINALITY  ·  ${view.finality.label}`);
  wrap(view.finality.explanation);
  write();

  write('TRADEABLE POSITION (for contrast, not the answer)');
  field('Owner now', formatAddress(view.tradeablePosition.owner));
  wrap(view.tradeablePosition.disclosure);

  return lines.join('\n');
}

/**
 * Render the append-only entry walk, newest first.
 *
 * Newest first because that is the order a reader scans; the entries
 * themselves are never reordered, and each carries its version so the
 * admission order stays readable.
 */
export function renderHistory(view: HistoryView): string {
  const lines: string[] = [];
  const write = (text = '') => lines.push(text);
  const wrap = (text: string, indent = '    ') => {
    for (const line of wrapText(text, 74)) write(`${indent}${line}`);
  };

  write(`PROJECTION HISTORY  ·  token ${view.tokenId}  ·  ${view.entries.length} entries`);
  write(`Chain of commitments: ${view.chainIntact ? 'intact' : 'BROKEN'}`);
  write();

  for (const item of [...view.entries].reverse()) {
    const { entry } = item;
    write(`  v${entry.version}  ${formatAddress(entry.holder)}`);
    write(
      `      in force  ${formatInstant(entry.effectiveAt)}` +
        (item.intervalEnd === undefined
          ? '  —  still the latest entry'
          : `\n                until ${formatInstant(item.intervalEnd)}`),
    );
    write(`      commitment  ${shortHex(entry.recordCommitment)}`);
    write(
      `      previous    ${
        entry.previousCommitment === `0x${'0'.repeat(64)}`
          ? 'zero — first entry'
          : shortHex(entry.previousCommitment)
      }`,
    );
    write(`      reference   ${shortHex(entry.registryReference)}  (opaque locator)`);
    if (item.linkFaults.length > 0) {
      write(`      FAULTS      ${item.linkFaults.join(', ')}`);
    }
    write();
  }

  wrap(view.note, '  ');
  return lines.join('\n');
}
