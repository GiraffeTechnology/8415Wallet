import type { TimelineRow, TokenOverview } from './view.ts';

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] as string));

const row = (label: string, value: string): string =>
  `<tr><th scope="row">${escape(label)}</th><td>${escape(value)}</td></tr>`;

/**
 * Renders the overview as three separate statements.
 *
 * There is no combined badge anywhere in this file, and no phrasing that reads
 * as one. "Final" and "provisional" describe the instant; "open gap" describes
 * what is in flight; the tradeable position and the confirmed holder are two
 * rows, never reconciled into one.
 */
export const renderOverview = (view: TokenOverview): string => {
  const coverage = {
    covered: 'covered by the projection',
    'not-covered': 'the projection does not cover this instant',
    'no-projection': 'this token has no projection',
  }[view.coverage];

  const gap = view.openGap === null
    ? row('Change in flight', 'none')
    : [
        row('Change in flight', `settlement ${view.openGap.settlementId}`),
        row('Gap opened at', view.openGap.openedAt),
        row('Gap deadline', view.openGap.expired ? `${view.openGap.deadline} (passed)` : view.openGap.deadline),
        row('Expected holder', view.openGap.expectedHolder),
      ].join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Token ${escape(view.tokenId)} — ERC-8415 projection</title>
</head><body>
<h1>Token ${escape(view.tokenId)}</h1>
<p>Register ${escape(view.registerId)}, verification profile ${escape(view.verificationProfile)}.</p>

<h2>At instant ${escape(view.instant)}</h2>
<table>
${row('Tradeable position (ERC-721 owner)', view.tradeablePosition ?? 'not read')}
${row('Confirmed holder (register)', view.confirmedHolder ?? '—')}
${row('Coverage', coverage)}
${row('Can a later admission change the confirmed holder?', view.final ? 'no, this instant is final' : 'yes, this instant is provisional')}
${gap}
${row('Admitted entries', String(view.entryCount))}
</table>

<p>The tradeable position and the confirmed holder are separate facts. They
agree at rest and diverge while the register catches up; neither is derived
from the other.</p>

<p>Whether an instant is final does not depend on whether a gap is open, and
closing a gap does not make any instant final.</p>
</body></html>`;
};

export const renderTimeline = (tokenId: string, rows: readonly TimelineRow[]): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Token ${escape(tokenId)} — audit timeline</title>
</head><body>
<h1>Audit timeline for token ${escape(tokenId)}</h1>
${rows.length === 0 ? '<p>Nothing recorded for this token.</p>' : ''}
${rows.map((item) => `<section>
<h2>${escape(item.at)} — ${escape(item.summary)}</h2>
<table>${item.detail.map(([label, value]) => row(label, value)).join('')}</table>
</section>`).join('\n')}
<p>Entries carry a record commitment and a registry reference. The register's
contents are not shown here: the chain carries a hash and a locator, and
reading the register itself requires entitlement this console does not have.</p>
</body></html>`;
