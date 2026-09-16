import { detectConformance } from './conformance.ts';
import { ContractRevertError } from './errors.ts';
import type { Erc8415Reader } from './port.ts';
import { ZERO_BYTES32, type Instant, type TokenId } from './types.ts';

/**
 * A conformance harness for adapters.
 *
 * Any implementation of `Erc8415Reader` — the rpc adapter, the in-memory one,
 * a future Native Infrastructure Kit binding, or someone else's — must behave
 * the same way, because everything above the port is written against these
 * guarantees and nothing else. This runs the checks that matter and returns
 * findings rather than throwing, so a caller can report them all at once.
 *
 * It is not a conformance test of the *contract*: the ERC's own test cases
 * cover that and a wallet is in no position to certify a deployment. It
 * verifies that an adapter faithfully passes the contract's answers through,
 * including its reverts.
 */

export type ConformanceFinding = {
  readonly check: string;
  readonly detail: string;
};

export type ReaderConformanceReport = {
  readonly address: string;
  readonly findings: readonly ConformanceFinding[];
  readonly conforms: boolean;
};

export type ConformanceProbe = {
  readonly tokenId: TokenId;
  /** An instant the projection covers. */
  readonly coveredInstant: Instant;
  /** An instant preceding the token's first entry. */
  readonly instantBeforeFirstEntry: Instant;
};

export async function checkReaderConformance(
  reader: Erc8415Reader,
  probe: ConformanceProbe,
): Promise<ReaderConformanceReport> {
  const findings: ConformanceFinding[] = [];
  const fail = (check: string, detail: string) => findings.push({ check, detail });

  const conformance = await detectConformance(reader);
  if (!conformance.projection) {
    fail('erc165', 'the contract does not advertise 0x6309e170; nothing else was checked');
    return { address: reader.source.address, findings, conforms: false };
  }

  // Identity.
  if ((await reader.registerId()) === ZERO_BYTES32) {
    fail('registerId', 'must be nonzero');
  }

  // The entry walk.
  const count = await reader.entryCount(probe.tokenId);
  if (count === 0n) {
    fail('entryCount', 'the probe token has no entries; the rest could not be checked');
    return { address: reader.source.address, findings, conforms: findings.length === 0 };
  }

  const first = await reader.entryAt(probe.tokenId, 1n);
  if (first.version !== 1n) fail('entryAt(1).version', `expected 1, got ${first.version}`);
  if (first.previousCommitment !== ZERO_BYTES32) {
    fail('entryAt(1).previousCommitment', 'the first entry must link to zero');
  }

  const latest = await reader.currentEntry(probe.tokenId);
  if (latest.version !== count) {
    fail('currentEntry.version', `expected ${count}, got ${latest.version}`);
  }
  if (latest.supersededAt !== 0n) {
    fail('currentEntry.supersededAt', 'the latest entry must have an open interval');
  }

  // Strict monotonicity and commitment uniqueness across the walk.
  const commitments = new Set<string>();
  let previousEffectiveAt: Instant | undefined;
  for (let version = 1n; version <= count; version += 1n) {
    const entry = await reader.entryAt(probe.tokenId, version);
    if (previousEffectiveAt !== undefined && entry.effectiveAt <= previousEffectiveAt) {
      fail('effectiveAt', `v${entry.version} does not exceed its predecessor`);
    }
    if (commitments.has(entry.recordCommitment)) {
      fail('recordCommitment', `v${entry.version} repeats a commitment within the token`);
    }
    commitments.add(entry.recordCommitment);
    previousEffectiveAt = entry.effectiveAt;
  }

  // Resolution agrees with itself.
  const entry = await reader.entryAsOf(probe.tokenId, probe.coveredInstant);
  const holder = await reader.holderAsOf(probe.tokenId, probe.coveredInstant);
  if (holder !== entry.holder) {
    fail('holderAsOf', 'must agree with entryAsOf at the same instant');
  }
  if (entry.effectiveAt > probe.coveredInstant) {
    fail('entryAsOf', 'returned an entry that takes effect after the instant asked about');
  }

  // The finality rule, as the ERC states it.
  const shouldBeFinal =
    probe.coveredInstant >= first.effectiveAt && probe.coveredInstant < latest.effectiveAt;
  if ((await reader.isFinalAsOf(probe.tokenId, probe.coveredInstant)) !== shouldBeFinal) {
    fail('isFinalAsOf', `disagrees with the rule at ${probe.coveredInstant}`);
  }
  if (await reader.isFinalAsOf(probe.tokenId, latest.effectiveAt)) {
    fail('isFinalAsOf', "must be false at the latest entry's effective time");
  }

  // Before the first entry: the two reverting calls revert, and the one that
  // must not, does not.
  await expectRevert(reader, probe, 'entryAsOf', fail);
  await expectRevert(reader, probe, 'holderAsOf', fail);
  try {
    if (await reader.isFinalAsOf(probe.tokenId, probe.instantBeforeFirstEntry)) {
      fail('isFinalAsOf', 'must be false before the first entry');
    }
  } catch {
    fail('isFinalAsOf', 'must not revert before the first entry');
  }

  // The tradeable position is readable and separate.
  await reader.ownerOf(probe.tokenId);

  return { address: reader.source.address, findings, conforms: findings.length === 0 };
}

async function expectRevert(
  reader: Erc8415Reader,
  probe: ConformanceProbe,
  call: 'entryAsOf' | 'holderAsOf',
  fail: (check: string, detail: string) => void,
): Promise<void> {
  try {
    await reader[call](probe.tokenId, probe.instantBeforeFirstEntry);
    fail(call, 'must revert for an instant preceding the first entry');
  } catch (error) {
    if (!(error instanceof ContractRevertError)) {
      fail(call, `reverted with an unexpected error type: ${String(error)}`);
    }
  }
}
