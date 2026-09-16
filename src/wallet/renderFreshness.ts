import type { FreshnessView } from './freshness.ts';
import { wrapText } from './wrap.ts';

/**
 * Render freshness in its own block.
 *
 * It is deliberately not placed next to finality, and it carries its
 * disclaimer every time. The contract's own enum name for the deepest state
 * is shown as raw data, labelled as such, so a reader who goes looking for
 * `FRESH_FINAL` finds it without the wallet ever presenting it as finality.
 */
export function renderFreshness(view: FreshnessView): string {
  const lines: string[] = [];
  const write = (text = '') => lines.push(text);
  const field = (label: string, value: string) => write(`  ${label.padEnd(18)}${value}`);
  const wrap = (text: string) => {
    for (const line of wrapText(text, 74)) write(`    ${line}`);
  };

  write(`WATCHTOWER FRESHNESS  ·  ${view.label}`);
  if (view.reported !== undefined) {
    field('Contract enum', `${view.reported}  (raw value, not a wallet label)`);
  }
  if (view.age !== undefined) field('Head age', `${view.age} block(s)`);
  if (view.finalityDepth !== undefined) {
    field('Reorg depth', `${view.finalityDepth} block(s)`);
  }
  wrap(view.explanation);
  write();
  wrap(view.disclaimer);

  return lines.join('\n');
}
