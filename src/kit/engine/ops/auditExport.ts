import type { ProjectionStore } from '../projection/store.ts';
import type { TokenId } from '../projection/types.ts';

export interface AuditRecord {
  readonly type: 'entry' | 'settlement';
  readonly tenantId: string;
  readonly registerId: string;
  readonly tokenId: string;
  readonly at: string;
  readonly detail: Readonly<Record<string, string>>;
}

/**
 * Export of everything the projection recorded, for an institution's own
 * archive.
 *
 * It exports the audit trail, which is commitments, references, versions,
 * holders and times. It cannot export the register's contents, because the
 * Kit never had them: the chain carries a hash and a locator.
 */
export const exportAudit = (tenantId: string, store: ProjectionStore, tokenIds?: readonly TokenId[]): readonly AuditRecord[] => {
  const tokens = tokenIds ?? store.tokens();
  const records: AuditRecord[] = [];

  for (const tokenId of tokens) {
    for (const entry of store.entries(tokenId)) {
      records.push({
        type: 'entry',
        tenantId,
        registerId: store.registerId,
        tokenId: tokenId.toString(),
        at: entry.effectiveAt.toString(),
        detail: {
          version: entry.version.toString(),
          holder: entry.holder,
          effectiveAt: entry.effectiveAt.toString(),
          supersededAt: entry.supersededAt.toString(),
          recordCommitment: entry.recordCommitment,
          previousCommitment: entry.previousCommitment,
          registryReference: entry.registryReference,
        },
      });
    }

    for (const record of store.settlementsFor(tokenId)) {
      records.push({
        type: 'settlement',
        tenantId,
        registerId: store.registerId,
        tokenId: tokenId.toString(),
        at: record.openedAt.toString(),
        detail: {
          settlementId: record.settlementId,
          status: record.status,
          initiator: record.initiator,
          expectedHolder: record.expectedHolder,
          snapshotHash: record.snapshotHash,
          openedAt: record.openedAt.toString(),
          deadline: record.deadline.toString(),
        },
      });
    }
  }

  return records.sort((a, b) => {
    if (a.tokenId !== b.tokenId) return BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1;
    const left = BigInt(a.at);
    const right = BigInt(b.at);
    if (left !== right) return left < right ? -1 : 1;
    return a.type.localeCompare(b.type);
  });
};

/** Newline-delimited JSON: streamable, and every uint64 stays a string. */
export const toNdjson = (records: readonly AuditRecord[]): string =>
  records.map((record) => JSON.stringify(record)).join('\n');
