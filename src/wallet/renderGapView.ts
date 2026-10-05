import { formatAddress, formatInstant, shortHex } from './format.ts';
import type { RiskSurfaceView } from './riskSurfaces.ts';
import type { SettlementLogView } from './settlementLog.ts';
import { wrapText } from './wrap.ts';

/**
 * Render the gap history.
 *
 * Every episode shows how it ended and what that ending means, because the
 * three closures are not interchangeable and only one of them admitted
 * anything.
 */
export function renderSettlementLog(view: SettlementLogView, translate: (text: string) => string = text => text): string {
  const lines: string[] = [];
  const write = (text = '') => lines.push(translate(text));
  const wrap = (text: string, indent = '      ') => {
    for (const line of wrapText(translate(text), 72)) write(`${indent}${line}`);
  };

  write(`SETTLEMENT HISTORY  ·  token ${view.tokenId}`);
  if (!view.available) {
    write();
    wrap(view.note, '  ');
    return lines.join('\n');
  }

  write(`${view.episodes.length} gap(s) on record`);
  write();

  for (const episode of view.episodes) {
    write(`  ${shortHex(episode.settlementId)}  —  ${episode.closure}`);
    write(
      `      opened      ${
        episode.openedAt === undefined ? 'not read' : formatInstant(episode.openedAt)
      }`,
    );
    write(`      deadline    ${formatInstant(episode.deadline)}`);
    write(`      expected    ${formatAddress(episode.expectedHolder)}`);
    if (episode.admitted !== undefined) {
      write(
        `      admitted    entry v${episode.admitted.version}, effective ` +
          `${formatInstant(episode.admitted.effectiveAt)}`,
      );
    }
    if (episode.replacedBy !== undefined) {
      write(`      replaced by ${shortHex(episode.replacedBy)}`);
    }
    wrap(episode.meaning);
    write();
  }

  wrap(view.note, '  ');
  return lines.join('\n');
}

/** Render the risk surfaces, as findings with their meaning and no verdict. */
export function renderRiskSurfaces(view: RiskSurfaceView, translate: (text: string) => string = text => text): string {
  const lines: string[] = [];
  const write = (text = '') => lines.push(translate(text));
  const wrap = (text: string, indent = '      ') => {
    for (const line of wrapText(translate(text), 72)) write(`${indent}${line}`);
  };

  write(`RISK SURFACES  ·  token ${view.tokenId}  ·  as of ${formatInstant(view.observedAt)}`);
  write();

  for (const surface of view.surfaces) {
    write(`  ${surface.present ? '•' : '·'} ${surface.heading}`);
    wrap(surface.finding);
    write();
    wrap(surface.meaning);
    write();
  }

  wrap(view.note, '  ');
  return lines.join('\n');
}
