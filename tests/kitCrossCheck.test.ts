import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  INTERFACE_ID_ERC165,
  INTERFACE_ID_PROJECTION_SETTLEMENT,
  INTERFACE_ID_REGISTER_PROJECTION,
  PROJECTION_SETTLEMENT_SIGNATURES,
  REGISTER_PROJECTION_SIGNATURES,
  foldInterfaceId,
  selectorOf,
} from '../src/sdk/interfaceIds.ts';

/**
 * Cross-check against a second, independent implementation.
 *
 * The wallet derives every selector by hashing a signature it holds as text.
 * That is self-consistent by construction: if the signature were wrong, the
 * derivation would be wrong in exactly the matching way and nothing here would
 * notice. Recomputing a value from the same source that produced it proves
 * arithmetic, not agreement.
 *
 * The Native Infrastructure Kit's Ethereum adapter writes the same selectors
 * down as literals, arrived at independently — it recomputes them from the
 * compiled Solidity ABI rather than from a signature string. Comparing the two
 * is therefore a real check: a signature drifting in either codebase breaks
 * this, and the failure names which call.
 *
 * The table below is a recorded copy, taken from
 * `erc8415-kit/adapters/ethereum/abi.ts`. It is deliberately a copy: this
 * repository does not depend on the Kit, and the value of the check is that
 * the two were written apart. What it pins is the agreement as of that
 * reading; a later Kit change is caught by the Kit's own `contracts.test.ts`
 * against the compiled ABI, and by re-recording this table.
 */
const KIT_SELECTOR: Readonly<Record<string, string>> = {
  'currentEntry(uint256)': '0xab041ef4',
  'entryAt(uint256,uint64)': '0xf6752412',
  'entryAsOf(uint256,uint64)': '0x7fc43f3a',
  'holderAsOf(uint256,uint64)': '0x013c5d9c',
  'isFinalAsOf(uint256,uint64)': '0xe6591ac9',
  'entryCount(uint256)': '0x1d1b039c',
  'registerId()': '0xbbc2a065',
  'openGapOf(uint256)': '0x819dc64f',
  'verificationProfile()': '0x43396e0a',
  'settlementPeriod()': '0x0f1071be',
  'isSettlementAuthority(uint256,address)': '0xdb966382',
  'supportsInterface(bytes4)': '0x01ffc9a7',
};

describe('the wallet and the Kit agree on the wire', () => {
  for (const [signature, expected] of Object.entries(KIT_SELECTOR)) {
    test(`${signature} hashes to the selector the Kit calls`, () => {
      assert.equal(selectorOf(signature), expected);
    });
  }

  test('every signature the wallet folds into an interface id is covered, or knowingly not', () => {
    // The Kit reads a projection; it does not send the three settlement
    // transactions, so it has no selector for them. Listing them here keeps
    // that a stated boundary rather than an unnoticed gap in the check.
    const notCalledByTheKit = new Set([
      'beginSettlement(uint256,bytes32,address,bytes32,uint64)',
      'finalizeSettlement(bytes32,bytes32,bytes32,uint64,bytes)',
      'cancelSettlement(bytes32,bytes32)',
      'settlement(bytes32)',
    ]);

    const unchecked = [...REGISTER_PROJECTION_SIGNATURES, ...PROJECTION_SETTLEMENT_SIGNATURES]
      .filter((signature) => KIT_SELECTOR[signature] === undefined)
      .filter((signature) => !notCalledByTheKit.has(signature));

    assert.deepEqual(unchecked, []);
  });

  test('the ERC-165 selector is the one both sides inherit', () => {
    assert.equal(selectorOf('supportsInterface(bytes4)'), INTERFACE_ID_ERC165);
  });
});

describe('the frozen interface identifiers hold from both directions', () => {
  test('the projection id folds from the signatures the Kit calls', () => {
    assert.equal(foldInterfaceId(REGISTER_PROJECTION_SIGNATURES), INTERFACE_ID_REGISTER_PROJECTION);
    // The same value, folded from the Kit's literals rather than from the
    // wallet's hashing. If the wallet's keccak were wrong, this would still
    // reach 0x6309e170 and the test above would be the one to fail.
    const fromKitLiterals = REGISTER_PROJECTION_SIGNATURES.reduce(
      (accumulator, signature) => accumulator ^ Number.parseInt(KIT_SELECTOR[signature]!.slice(2), 16),
      0,
    );
    assert.equal(`0x${(fromKitLiterals >>> 0).toString(16).padStart(8, '0')}`, INTERFACE_ID_REGISTER_PROJECTION);
  });

  test('the settlement id folds to the frozen value', () => {
    assert.equal(
      foldInterfaceId(PROJECTION_SETTLEMENT_SIGNATURES),
      INTERFACE_ID_PROJECTION_SETTLEMENT,
    );
  });
});
