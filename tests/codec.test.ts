import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decodeResult, encodeCall, REGISTER_ENTRY_TYPES } from '../src/codec/abi.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';
import {
  INTERFACE_ID_PROJECTION_SETTLEMENT,
  INTERFACE_ID_REGISTER_PROJECTION,
  PROJECTION_SETTLEMENT_SIGNATURES,
  REGISTER_PROJECTION_SIGNATURES,
  foldInterfaceId,
  selectorOf,
} from '../src/sdk/interfaceIds.ts';
import { ValueOutOfRangeError } from '../src/sdk/errors.ts';

describe('keccak-256', () => {
  test('matches published digests', () => {
    assert.equal(
      keccak256Utf8(''),
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
    assert.equal(
      keccak256Utf8('abc'),
      '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    );
  });

  test('is Keccak, not SHA3-256', () => {
    // SHA3-256('') is a different digest. Using Node's crypto here would be a
    // silent, undetectable break in every selector the wallet derives.
    const sha3Empty = '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a';
    assert.notEqual(keccak256Utf8(''), sha3Empty);
  });

  test('reproduces well-known Ethereum selectors', () => {
    assert.equal(selectorOf('ownerOf(uint256)'), '0x6352211e');
    assert.equal(selectorOf('supportsInterface(bytes4)'), '0x01ffc9a7');
    assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
  });
});

describe('ERC-165 interface identifiers', () => {
  // The strongest check available on the codec: these are frozen constants of
  // the ERC, and reproducing both from derived selectors exercises keccak, the
  // selector derivation and the signature lists end to end.
  test('IRegisterProjection folds to 0x6309e170', () => {
    assert.equal(foldInterfaceId(REGISTER_PROJECTION_SIGNATURES), INTERFACE_ID_REGISTER_PROJECTION);
  });

  test('IProjectionSettlement folds to 0xf4a7d71b', () => {
    assert.equal(
      foldInterfaceId(PROJECTION_SETTLEMENT_SIGNATURES),
      INTERFACE_ID_PROJECTION_SETTLEMENT,
    );
  });

  test('the fold excludes supportsInterface, as the ERC specifies', () => {
    const withInherited = [...REGISTER_PROJECTION_SIGNATURES, 'supportsInterface(bytes4)'];
    assert.notEqual(foldInterfaceId(withInherited), INTERFACE_ID_REGISTER_PROJECTION);
  });
});

describe('ABI codec', () => {
  test('encodes a call as selector plus one word per argument', () => {
    const data = encodeCall(
      'holderAsOf(uint256,uint64)',
      ['uint256', 'uint64'],
      [1234n, 1_767_225_600n],
    );
    assert.equal(data.slice(0, 10), selectorOf('holderAsOf(uint256,uint64)'));
    assert.equal(data.length, 2 + 8 + 64 * 2);
    assert.ok(data.endsWith((1_767_225_600n).toString(16).padStart(64, '0')));
  });

  test('left-aligns bytes4 and right-aligns numbers and addresses', () => {
    const selector = encodeCall('supportsInterface(bytes4)', ['bytes4'], ['0x6309e170']);
    assert.ok(selector.endsWith(`6309e170${'0'.repeat(56)}`));

    const owner = encodeCall('ownerOf(uint256)', ['uint256'], [1n]);
    assert.ok(owner.endsWith(`${'0'.repeat(63)}1`));
  });

  test('round-trips a RegisterEntry tuple', () => {
    const words = [
      'aa'.repeat(32),
      'bb'.repeat(32),
      'cc'.repeat(32),
      `${'0'.repeat(24)}${'dd'.repeat(20)}`,
      (3n).toString(16).padStart(64, '0'),
      (1_764_839_520n).toString(16).padStart(64, '0'),
      (0n).toString(16).padStart(64, '0'),
    ].join('');

    const fields = decodeResult(REGISTER_ENTRY_TYPES, `0x${words}`);
    assert.equal(fields[0], `0x${'aa'.repeat(32)}`);
    assert.equal(fields[3], `0x${'dd'.repeat(20)}`);
    assert.equal(fields[4], 3n);
    assert.equal(fields[5], 1_764_839_520n);
    assert.equal(fields[6], 0n);
  });

  test('rejects a truncated return payload rather than zero-filling it', () => {
    assert.throws(
      () => decodeResult(REGISTER_ENTRY_TYPES, `0x${'00'.repeat(32)}`),
      ValueOutOfRangeError,
    );
  });

  test('rejects a uint64 argument that does not fit', () => {
    assert.throws(
      () => encodeCall('isFinalAsOf(uint256,uint64)', ['uint256', 'uint64'], [1n, 1n << 64n]),
      ValueOutOfRangeError,
    );
  });

  test('preserves uint64 instants beyond Number.MAX_SAFE_INTEGER', () => {
    // A far-future effectiveAt is a state the wallet must report accurately;
    // narrowing to a double would round it into a different instant.
    const farFuture = (1n << 63n) + 12_345n;
    const [decoded] = decodeResult(['uint64'], `0x${farFuture.toString(16).padStart(64, '0')}`);
    assert.equal(decoded, farFuture);
    assert.notEqual(Number(farFuture).toString(), farFuture.toString());
  });
});
