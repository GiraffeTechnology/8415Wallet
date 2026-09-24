import type { EscrowView } from './escrowView.ts';
import { formatAddress, formatDuration, formatInstant } from './format.ts';
import { ZERO_ADDRESS } from '../sdk/types.ts';
import { wrapText } from './wrap.ts';

const WIDTH = 74;

function block(lines: string[], text: string, indent = '    '): void {
  for (const line of wrapText(text, WIDTH)) lines.push(`${indent}${line}`);
}

/** A trade in escrow, as either party needs to read it. */
export function renderEscrow(view: EscrowView): string {
  const lines: string[] = [];
  lines.push(`ESCROW  ·  ${view.headline}`);
  lines.push('');
  block(lines, view.meaning);
  lines.push('');
  lines.push('  What happens next');
  block(lines, view.action, '      ');

  if (view.state !== 'no-such-trade') {
    lines.push('');
    lines.push(`  Seller                 ${formatAddress(view.seller)}`);
    lines.push(`  Buyer                  ${formatAddress(view.buyer)}`);
    lines.push(`  Price                  ${formatWei(view.price)}`);
    lines.push('');
    // The two sequences, side by side and never merged. While a trade is live
    // these differ by design: that divergence is what is being escrowed.
    lines.push(`  Position sits with     ${holder(view.positionHolder)}`);
    lines.push(`  Register confirms      ${holder(view.confirmedHolder)}`);
  }

  if (view.confirmingVersion !== undefined) {
    lines.push(
      `  Confirming entry       v${view.confirmingVersion}` +
        `, effective ${formatInstant(view.confirmingEffectiveAt!)}`,
    );
  }

  if (view.window !== undefined) {
    lines.push('');
    lines.push(`  Deadline               ${formatInstant(view.window.deadline)}`);
    lines.push(
      `  ${view.window.passed ? 'Passed' : 'Remaining'}               ` +
        `${formatDuration(abs(view.window.remaining))}` +
        `${view.window.passed ? ' ago' : ''}`,
    );
  }

  if (view.provisionalNote !== undefined) {
    lines.push('');
    lines.push('  On what this rests');
    block(lines, view.provisionalNote, '      ');
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * A zero address is the register having no entry at all, or the token not
 * existing. Reporting it as an address would read as a party to the trade.
 */
function holder(address: string): string {
  return address === ZERO_ADDRESS ? 'nobody — no record' : formatAddress(address);
}

const WEI_PER_ETH = 1_000_000_000_000_000_000n;

/** Exact, never rounded: this is a price. */
function formatWei(amount: bigint): string {
  const whole = amount / WEI_PER_ETH;
  const fraction = (amount % WEI_PER_ETH).toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole}${fraction === '' ? '' : `.${fraction}`} ETH`;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
