# Bounded cross-token reuse observations

The following fenced blocks are verbatim excerpts from private source commit `de79227f0b886d86d674a70d67d5608576c8156c`. They show the source work budgets, enumeration and indexing only; they do not form a complete scanner. The adjacent Node file is a local-data adaptation.

### Exact excerpt: src/wallet/collisions.ts, lines 54–56

```typescript
/** Work limits for one interactive scan, not protocol or chain-lifetime limits. */
export const COLLISION_SCAN_MAX_TOKENS = 32;
export const COLLISION_SCAN_MAX_ENTRIES = 2048;
```

### Exact excerpt: src/wallet/collisions.ts, lines 112–127

```typescript
  for (const tokenId of tokens) {
    const count = await reader.entryCount(tokenId);
    if (typeof count !== 'bigint' || count < 0n || count >= 1n << 64n) {
      throw new CollisionScanError('COLLISION_ENTRY_COUNT_REFUSED');
    }
    if (count === 0n) throw new ProjectionNotInitialized(tokenId);
    if (count > BigInt(COLLISION_SCAN_MAX_ENTRIES - entriesExamined)) {
      throw new CollisionScanError('COLLISION_ENTRY_BUDGET_REFUSED');
    }
    for (let version = 1n; version <= count; version += 1n) {
      const entry = await reader.entryAt(tokenId, version);
      entriesExamined += 1;
      record(commitments, entry.recordCommitment, { tokenId, version });
      record(references, entry.registryReference, { tokenId, version });
    }
  }
```

### Exact excerpt: src/wallet/collisions.ts, lines 142–150

```typescript
function record(
  index: Map<Bytes32, CollisionOccurrence[]>,
  value: Bytes32,
  occurrence: CollisionOccurrence,
): void {
  const existing = index.get(value);
  if (existing === undefined) index.set(value, [occurrence]);
  else existing.push(occurrence);
}
```

The original scanner has additional input, conformance and identity checks; these fragments and the local fixture do not reproduce or test those protections. Only the selected token set is examined, and the source RPC reads are sequential, not atomic. A clear report cannot certify global uniqueness or authorize a transaction.

The adaptation reports cross-token duplicate values without the original reporter's same-token `registryReference` violation wording. Invariant 4 covers `recordCommitment` uniqueness within a token. A `registryReference` is an opaque, profile-defined locator; its repetition alone is not a protocol violation. This fixture is not a same-token conformance validator.
