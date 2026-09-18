import type { ProjectionStore } from '../engine/projection/store.ts';
import type { SettlementEngine } from '../engine/settlement/engine.ts';
import { ZERO_BYTES32, type Address, type Instant, type ProjectionEntry, type Settlement, type TokenId } from '../engine/projection/types.ts';

export interface TokenOverview {
  readonly tokenId: string;
  readonly registerId: string;
  readonly verificationProfile: string;
  /** From ERC-721. Absent when no owner source is wired; never inferred. */
  readonly tradeablePosition: string | null;
  /** From the projection at the queried instant. Absent when uncovered. */
  readonly confirmedHolder: string | null;
  readonly instant: string;
  /** Whether a later admission can still change the confirmed holder. */
  readonly final: boolean;
  readonly openGap: SettlementRow | null;
  readonly entryCount: number;
  /** Why the confirmed holder is absent, when it is. */
  readonly coverage: 'covered' | 'not-covered' | 'no-projection';
}

export interface SettlementRow {
  readonly settlementId: string;
  readonly status: string;
  readonly openedAt: string;
  readonly deadline: string;
  readonly expectedHolder: string;
  readonly expired: boolean;
}

export interface TimelineRow {
  readonly kind: 'entry' | 'settlement';
  readonly at: string;
  readonly summary: string;
  readonly detail: readonly (readonly [string, string])[];
}

export interface OverviewInput {
  readonly store: ProjectionStore;
  readonly settlement?: SettlementEngine;
  readonly tokenId: TokenId;
  readonly instant: Instant;
  /** ERC-721 owner, supplied by the caller. Never read from the projection. */
  readonly owner?: Address;
}

/**
 * The console's read of a token.
 *
 * Two facts sit side by side and are never merged: the tradeable position from
 * ERC-721, and the confirmed holder from the projection. When the projection
 * does not cover the instant the confirmed holder is null and `coverage` says
 * why — it is never filled in from the owner, because an owner is not a
 * register record.
 */
export const overview = (input: OverviewInput): TokenOverview => {
  const { store, tokenId, instant } = input;
  const hasProjection = store.entryCount(tokenId) > 0;

  let confirmedHolder: string | null = null;
  let coverage: TokenOverview['coverage'] = hasProjection ? 'covered' : 'no-projection';
  if (hasProjection) {
    try {
      confirmedHolder = store.holderAsOf(tokenId, instant);
    } catch {
      coverage = 'not-covered';
    }
  }

  const openId = store.openGapOf(tokenId);

  return {
    tokenId: tokenId.toString(),
    registerId: store.registerId,
    verificationProfile: store.verificationProfile,
    tradeablePosition: input.owner ?? null,
    confirmedHolder,
    instant: instant.toString(),
    // Read from the projection, never recomputed and never inferred from the
    // gap: a gap says what is expected, not what can still arrive.
    final: store.isFinalAsOf(tokenId, instant),
    openGap: openId === ZERO_BYTES32 ? null : settlementRow(store.settlement(openId), input.settlement),
    entryCount: store.entryCount(tokenId),
    coverage,
  };
};

const settlementRow = (record: Settlement, engine?: SettlementEngine): SettlementRow => ({
  settlementId: record.settlementId,
  status: record.status,
  openedAt: record.openedAt.toString(),
  deadline: record.deadline.toString(),
  expectedHolder: record.expectedHolder,
  expired: engine?.hasExpired(record.settlementId) ?? false,
});

/**
 * The audit timeline: admitted entries and gap transitions, in the order they
 * take effect.
 *
 * It carries the record commitment and the registry reference, which are a
 * hash and a locator. The register's contents are not here and cannot be:
 * reading the register needs entitlement the console does not have.
 */
export const timeline = (
  entries: readonly ProjectionEntry[],
  settlements: readonly Settlement[],
): readonly TimelineRow[] => {
  const rows: TimelineRow[] = entries.map((entry) => ({
    kind: 'entry' as const,
    at: entry.effectiveAt.toString(),
    summary: `version ${entry.version} admitted, holder ${entry.holder}`,
    detail: [
      ['version', entry.version.toString()],
      ['holder', entry.holder],
      ['effectiveAt', entry.effectiveAt.toString()],
      ['supersededAt', entry.supersededAt === 0n ? 'open' : entry.supersededAt.toString()],
      ['recordCommitment', entry.recordCommitment],
      ['registryReference', entry.registryReference],
    ] as const,
  }));

  for (const record of settlements) {
    rows.push({
      kind: 'settlement',
      at: record.openedAt.toString(),
      summary: `settlement ${short(record.settlementId)} ${record.status.toLowerCase()}`,
      detail: [
        ['settlementId', record.settlementId],
        ['status', record.status],
        ['openedAt', record.openedAt.toString()],
        ['deadline', record.deadline.toString()],
        ['expectedHolder', record.expectedHolder],
      ] as const,
    });
  }

  return rows.sort((a, b) => {
    const left = BigInt(a.at);
    const right = BigInt(b.at);
    if (left !== right) return left < right ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === 'entry' ? -1 : 1;
  });
};

const short = (value: string): string => `${value.slice(0, 10)}…`;
