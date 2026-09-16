import type { Bytes32 } from '../sdk/types.ts';
import type { Freshness, WatchtowerBinding } from '../sdk/watchtower.ts';

/**
 * Freshness, presented as what it is.
 *
 * The contract's enum names the deepest state `FRESH_FINAL`. That name is a
 * trap for a reader: it measures whether the head's signing block is buried
 * under `finalityDepth` blocks — on-chain reorg safety — and says nothing
 * about whether the register confirmed anything or whether a projected
 * instant can still change. The wallet therefore labels it *reorg-safe*, and
 * the word "final" appears in this view only where it is denied.
 *
 * This is the third signal. It never touches the first two: no code path lets
 * a freshness answer reach the finality display or the contest display, and
 * the tests hold that line in both directions.
 */

export type FreshnessDisplay =
  | 'reorg-safe'
  | 'fresh-reorg-exposed'
  | 'stale'
  | 'unknown'
  | 'not-configured';

export type FreshnessView = {
  readonly assetId: Bytes32 | undefined;
  /** Which watchtower contract, on which chain, answered. */
  readonly source: { readonly chainId: bigint; readonly address: string } | undefined;
  /**
   * How this feed came to be paired with the projection being read.
   *
   * Never verified on chain: the two contracts do not know about each other.
   * Shown so a reader can see the pairing is someone's assertion.
   */
  readonly binding:
    | { readonly provenance: 'configured' | 'computed'; readonly claimedRegisterId?: Bytes32 }
    | undefined;
  readonly bindingNote: string | undefined;
  /** Exactly what the contract's enum said, when one was consulted. */
  readonly reported: Freshness | undefined;
  readonly display: FreshnessDisplay;
  readonly label: string;
  /** Blocks since the head was signed. */
  readonly age: bigint | undefined;
  readonly finalityDepth: bigint | undefined;
  readonly explanation: string;
  /** Shown wherever the status is shown. */
  readonly disclaimer: string;
};

const DISCLAIMER =
  'Freshness is not finality. It measures how exposed the attestation is to a ' +
  'chain reorganisation, not whether the register has confirmed a holder, and ' +
  'not whether a projected instant can still change. Read `isFinalAsOf` for ' +
  'that; nothing here substitutes for it.';

const LABELS: Record<FreshnessDisplay, string> = {
  'reorg-safe': 'Reorg-safe',
  'fresh-reorg-exposed': 'Fresh, reorg-exposed',
  stale: 'Stale',
  unknown: 'Unknown',
  'not-configured': 'No watchtower configured',
};

const DISPLAY_BY_STATUS: Record<Freshness, FreshnessDisplay> = {
  UNKNOWN: 'unknown',
  STALE: 'stale',
  FRESH_PENDING: 'fresh-reorg-exposed',
  FRESH_FINAL: 'reorg-safe',
};

/** The view for a wallet with no watchtower to consult. */
export function noWatchtower(): FreshnessView {
  return {
    assetId: undefined,
    source: undefined,
    binding: undefined,
    bindingNote: undefined,
    reported: undefined,
    display: 'not-configured',
    label: LABELS['not-configured'],
    age: undefined,
    finalityDepth: undefined,
    explanation:
      'No watchtower freshness layer is configured for this asset. Its absence ' +
      'says nothing about the projection, which is read from the ERC-8415 ' +
      'contract and does not depend on a watchtower.',
    disclaimer: DISCLAIMER,
  };
}

export async function buildFreshnessView(binding: WatchtowerBinding): Promise<FreshnessView> {
  const { reader, assetId } = binding;
  const { status, age } = await reader.freshnessOf(assetId);

  let finalityDepth: bigint | undefined;
  try {
    finalityDepth = (await reader.policyOf(assetId)).finalityDepth;
  } catch {
    finalityDepth = undefined;
  }

  const display = DISPLAY_BY_STATUS[status];
  return {
    assetId,
    source: reader.source,
    binding: {
      provenance: binding.provenance,
      ...(binding.claimedRegisterId === undefined
        ? {}
        : { claimedRegisterId: binding.claimedRegisterId }),
    },
    bindingNote: bindingNote(binding),
    reported: status,
    display,
    label: LABELS[display],
    age,
    finalityDepth,
    explanation: explain(status, age, finalityDepth),
    disclaimer: DISCLAIMER,
  };
}

function explain(status: Freshness, age: bigint, finalityDepth: bigint | undefined): string {
  const depth = finalityDepth === undefined ? 'the configured depth' : `${finalityDepth} blocks`;
  switch (status) {
    case 'FRESH_FINAL':
      return (
        `The head was signed ${age} block(s) ago, at or beyond ${depth}, so it is ` +
        `buried deeply enough not to flip in a reorganisation. The contract's enum ` +
        `calls this state FRESH_FINAL; it is reorg safety of the attestation, not ` +
        `registrar finality and not projection finality.`
      );
    case 'FRESH_PENDING':
      return (
        `The head was signed ${age} block(s) ago, short of ${depth}, so it is recent ` +
        `enough to be useful but still exposed to a reorganisation.`
      );
    case 'STALE':
      return (
        `The head is ${age} block(s) old and no longer counts as fresh — its age has ` +
        `passed the threshold it was signed with, or its signing key was revoked. ` +
        `A revoked key means compromise, and collapses the classification retroactively.`
      );
    case 'UNKNOWN':
      return (
        'No head is recorded, or the asset is not registered with this watchtower. ' +
        'Nothing is being attested.'
      );
  }
}

function bindingNote(binding: WatchtowerBinding): string {
  const how =
    binding.provenance === 'computed'
      ? 'This feed identifier was derived through the watchtower\u2019s own computeAssetId.'
      : 'This feed identifier was supplied by configuration.';
  const claim =
    binding.claimedRegisterId === undefined
      ? 'Nothing states which register it tracks.'
      : `It is asserted to track register ${binding.claimedRegisterId}.`;
  return (
    `${how} ${claim} No on-chain link exists between an ERC-8415 register and a ` +
    'watchtower feed \u2014 the two contracts do not know about each other \u2014 so this ' +
    'pairing is an assertion by whoever configured it, not a fact the wallet checked.'
  );
}
