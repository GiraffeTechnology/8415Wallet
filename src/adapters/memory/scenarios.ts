import type { Address, Bytes32, Instant, TokenId } from '../../sdk/types.ts';
import { MemoryErc8415Reader } from './memoryReader.ts';
import { MemoryRegisterContract, type MemoryRegisterOptions } from './register.ts';

/**
 * Scenarios covering the cases AGENTS.md requires as explicit negative tests,
 * plus the contrasting positives that give them meaning.
 *
 * The instants match the worked example in PRD §4.2, so the specification and
 * the fixtures describe the same token rather than two similar ones.
 */

export const ALICE: Address = '0xa11ce10000000000000000000000000000000000';
export const CAROL: Address = '0xca20130000000000000000000000000000000000';
export const DAVE: Address = '0xd00d400000000000000000000000000000000000';
export const ERIN: Address = '0xe21e500000000000000000000000000000000000';
export const FRANK: Address = '0xf2a4c60000000000000000000000000000000000';
export const REGISTRAR: Address = '0x2e61572a20000000000000000000000000000000';
export const STRANGER: Address = '0x572a4e2000000000000000000000000000000000';

export const TOKEN: TokenId = 1234n;

/** Instants used across the scenarios, in seconds since the Unix epoch. */
export const T = {
  /** 2025-06-01 — precedes every projection here. */
  beforeFirstEntry: 1_748_736_000n,
  /** 2025-09-01 — entry v1 takes effect. */
  v1: 1_756_684_800n,
  /** 2025-10-01 */
  earlyOctober: 1_759_276_800n,
  /** 2025-10-10 11:00 */
  gapOpened: 1_760_094_000n,
  /** 2025-10-15 — entry v2 takes effect. */
  v2: 1_760_486_400n,
  /** 2025-10-20 11:00 — that gap's deadline. */
  gapDeadline: 1_760_958_000n,
  /** 2025-10-21 — after the deadline, when cancellation becomes possible. */
  afterGapDeadline: 1_761_004_800n,
  /** 2025-11-30 — covered by v2, strictly before v3: final. */
  finalInstant: 1_764_460_800n,
  /** 2025-12-04 09:12 — entry v3 takes effect. */
  v3: 1_764_839_520n,
  /** 2025-12-18 — the tradeable position moves. */
  positionTransferred: 1_766_016_000n,
  /** 2025-12-20 11:02 — the open gap's `openedAt`. */
  openGapOpened: 1_766_228_520n,
  /** 2026-01-01 — the instant PRD §4.2 asks about. */
  asOf: 1_767_225_600n,
  /** 2026-01-19 11:02 — the open gap's deadline. */
  openGapDeadline: 1_768_820_520n,
  /** 2026-02-15 */
  later: 1_771_113_600n,
} as const;

/** Distinct 32-byte shapes per role, so a mix-up in a fixture is visible. */
const commitment = (seed: string): Bytes32 => `0x${seed.repeat(64).slice(0, 64)}`;
const reference = (seed: string): Bytes32 => `0x${`f${seed}`.repeat(32).slice(0, 64)}`;
const settlementId = (seed: string): Bytes32 => `0x${`e${seed}`.repeat(32).slice(0, 64)}`;

export type Scenario = {
  readonly contract: MemoryRegisterContract;
  readonly reader: MemoryErc8415Reader;
  readonly tokenId: TokenId;
};

function newContract(options: MemoryRegisterOptions = {}): MemoryRegisterContract {
  return new MemoryRegisterContract({ now: T.beforeFirstEntry, ...options });
}

/**
 * Admit one entry through the full settlement path.
 *
 * Scenarios go through `beginSettlement` / `finalizeSettlement` rather than
 * writing entries directly, so the fixtures exercise the same ordering the ERC
 * requires: no entry can be admitted while no gap is open.
 */
function admit(
  contract: MemoryRegisterContract,
  tokenId: TokenId,
  holder: Address,
  effectiveAt: Instant,
  seed: string,
  openAt: Instant,
): void {
  contract.advanceTo(openAt);
  const id = settlementId(seed);
  contract.beginSettlement(
    REGISTRAR,
    tokenId,
    id,
    holder,
    commitment('5'),
    openAt + 7n * 24n * 60n * 60n,
  );
  contract.finalizeSettlement(id, {
    recordCommitment: commitment(seed),
    registryReference: reference(seed),
    effectiveAt,
    proofData: '0x',
  });
}

/**
 * The PRD §4.2 token: three admitted entries, a tradeable position that has
 * moved to a party the projection does not confirm, and an open gap that makes
 * 2026-01-01 contested as well as provisional.
 *
 * Covers: `ownerOf` diverging from the confirmed holder; an open gap; an
 * instant that is both provisional and contested; an instant before the first
 * entry; and a final instant to contrast against.
 */
export function divergentToken(): Scenario {
  const contract = newContract();
  contract.mint(TOKEN, ALICE);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);

  admit(contract, TOKEN, ALICE, T.v1, 'a', T.v1 - 60n);
  admit(contract, TOKEN, CAROL, T.v2, 'b', T.v2 - 60n);
  admit(contract, TOKEN, ALICE, T.v3, 'c', T.v3 - 60n);

  // The position trades while the register is behind. The projection does not
  // move with it.
  contract.advanceTo(T.positionTransferred);
  contract.transfer(TOKEN, DAVE);

  // A gap opens to admit that change; at 2026-01-01 it is still open.
  contract.advanceTo(T.openGapOpened);
  contract.beginSettlement(
    REGISTRAR,
    TOKEN,
    settlementId('7'),
    DAVE,
    commitment('5'),
    T.openGapDeadline,
  );
  contract.advanceTo(T.asOf);

  return { contract, reader: new MemoryErc8415Reader(contract), tokenId: TOKEN };
}

/** The open gap's identifier in `divergentToken`. */
export const OPEN_GAP_ID: Bytes32 = settlementId('7');

/**
 * A gap that closed by cancellation.
 *
 * The contest ends and nothing settles: the projection is unchanged, the
 * preceding entry stays in force, and instants at or after the latest entry's
 * effective time remain non-final. This is the fixture behind "a closed gap
 * over a non-final instant" and "a cancelled settlement".
 */
export function cancelledGapToken(): Scenario {
  const contract = newContract();
  contract.mint(TOKEN, ERIN);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);

  admit(contract, TOKEN, ERIN, T.v1, 'a', T.v1 - 60n);
  admit(contract, TOKEN, FRANK, T.v2, 'b', T.v2 - 60n);

  contract.advanceTo(T.gapOpened + 30n * 24n * 60n * 60n);
  contract.beginSettlement(
    REGISTRAR,
    TOKEN,
    settlementId('8'),
    ERIN,
    commitment('5'),
    contract.now + 60n,
  );
  contract.advanceTo(contract.now + 120n);
  contract.cancelSettlement(REGISTRAR, settlementId('8'), commitment('9'));

  return { contract, reader: new MemoryErc8415Reader(contract), tokenId: TOKEN };
}

/** The cancelled settlement's identifier in `cancelledGapToken`. */
export const CANCELLED_GAP_ID: Bytes32 = settlementId('8');

/**
 * A confirming entry: an admission naming the holder already confirmed.
 *
 * Not a no-op. It is the register saying "still this holder, as of here", and
 * it is what closes the preceding interval and makes those instants final.
 */
export function confirmingEntryToken(): Scenario {
  const contract = newContract();
  contract.mint(TOKEN, ALICE);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);

  admit(contract, TOKEN, ALICE, T.v1, 'a', T.v1 - 60n);
  admit(contract, TOKEN, ALICE, T.v3, 'c', T.v3 - 60n);

  contract.advanceTo(T.asOf);
  return { contract, reader: new MemoryErc8415Reader(contract), tokenId: TOKEN };
}

/**
 * A contract with projection conformance but no settlement interface.
 *
 * It has no gaps and no contested instants — a property of the contract, not
 * an observation that no gap happens to be open.
 */
export function projectionOnlyToken(): Scenario {
  const contract = new MemoryRegisterContract({
    now: T.beforeFirstEntry,
    conformance: { settlement: false },
  });
  contract.mint(TOKEN, ALICE);
  contract.grantSettlementAuthority(TOKEN, REGISTRAR);

  // Entries are placed directly: without a settlement interface there is no
  // gap to admit them into, which is exactly the shape this contract models.
  contract.seedEntries(TOKEN, [
    { holder: ALICE, effectiveAt: T.v1, seed: 'a' },
    { holder: CAROL, effectiveAt: T.v3, seed: 'c' },
  ]);
  contract.advanceTo(T.asOf);

  return { contract, reader: new MemoryErc8415Reader(contract), tokenId: TOKEN };
}

export { commitment, reference, settlementId };
