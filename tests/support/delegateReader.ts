import type { Erc8415Reader } from '../../src/sdk/port.ts';

/**
 * A reader that forwards to another, with selected calls replaced.
 *
 * Used to model a contract that misbehaves in a way a conforming one cannot —
 * a broken commitment chain, a revert the wallet cannot attribute, a finality
 * answer that contradicts the rule. The wallet has to cope with those, and the
 * in-memory contract will not produce them because it conforms.
 *
 * Spreading a class instance would not do: its methods live on the prototype,
 * so the copy would arrive with none of them.
 */
export function delegateReader(
  base: Erc8415Reader,
  overrides: Partial<Erc8415Reader>,
): Erc8415Reader {
  const forwarded: Erc8415Reader = {
    source: base.source,
    chainInstant: () => base.chainInstant(),
    supportsInterface: (id) => base.supportsInterface(id),
    ownerOf: (id) => base.ownerOf(id),
    currentEntry: (id) => base.currentEntry(id),
    entryAt: (id, version) => base.entryAt(id, version),
    entryAsOf: (id, instant) => base.entryAsOf(id, instant),
    holderAsOf: (id, instant) => base.holderAsOf(id, instant),
    isFinalAsOf: (id, instant) => base.isFinalAsOf(id, instant),
    entryCount: (id) => base.entryCount(id),
    registerId: () => base.registerId(),
    ...(base.settlement === undefined ? {} : { settlement: (id: string) => base.settlement!(id) }),
    ...(base.openGapOf === undefined ? {} : { openGapOf: (id: bigint) => base.openGapOf!(id) }),
    ...(base.settlementPeriod === undefined
      ? {}
      : { settlementPeriod: () => base.settlementPeriod!() }),
    ...(base.verificationProfile === undefined
      ? {}
      : { verificationProfile: () => base.verificationProfile!() }),
    ...(base.isSettlementAuthority === undefined
      ? {}
      : {
          isSettlementAuthority: (id: bigint, account: string) =>
            base.isSettlementAuthority!(id, account),
        }),
  };
  return { ...forwarded, ...overrides };
}
