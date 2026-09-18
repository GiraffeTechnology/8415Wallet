import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256Utf8 } from '../../src/codec/keccak.ts';
import { compileContracts, abiOf } from './support/solc.ts';

/**
 * Selectors here are derived twice from independent sources and compared.
 *
 * solc produces the ABI from the Solidity interface definitions in
 * `contracts/`; this file turns each ABI entry back into a canonical signature
 * and hashes it with the wallet's own Keccak-256, which is implemented in this
 * repository and validated separately against published digests. Neither
 * derivation can see the other's inputs, so agreement between them is evidence
 * and not arithmetic.
 *
 * Before the merge this used `ethereum-cryptography` for the hash. Using the
 * wallet's implementation instead is what makes the check cross-cutting: a
 * fault in the wallet's Keccak now fails here, against the compiler.
 */

interface AbiParam { type: string; components?: AbiParam[] }
interface AbiEntry { type: string; name?: string; inputs?: AbiParam[] }

const canonical = (param: AbiParam): string =>
  param.components === undefined
    ? param.type
    : `(${param.components.map(canonical).join(',')})${param.type.slice('tuple'.length)}`;

const signature = (entry: AbiEntry): string =>
  `${entry.name}(${(entry.inputs ?? []).map(canonical).join(',')})`;

const selector = (sig: string): number => Number.parseInt(keccak256Utf8(sig).slice(2, 10), 16);

/**
 * ERC-165 identifier: the XOR of an interface's function selectors, excluding
 * the inherited supportsInterface(bytes4).
 */
const interfaceId = (abi: unknown[]): string => {
  const functions = (abi as AbiEntry[])
    .filter((entry) => entry.type === 'function')
    .map(signature)
    .filter((sig) => sig !== 'supportsInterface(bytes4)');
  assert.ok(functions.length > 0, 'the interface declares no functions');
  const id = functions.reduce((acc, sig) => (acc ^ selector(sig)) >>> 0, 0);
  return `0x${id.toString(16).padStart(8, '0')}`;
};

const output = compileContracts();

test('the contracts compile', () => {
  assert.ok(Object.keys(output.contracts).length > 0);
});

test('the ERC-165 selector is the known constant', () => {
  // Anchors the selector computation itself, so a wrong hash cannot make the
  // interface identifiers below agree by accident.
  assert.equal(`0x${selector('supportsInterface(bytes4)').toString(16)}`, '0x1ffc9a7');
});

test('IRegisterProjection computes to the frozen 0x6309e170', () => {
  const abi = abiOf(output, 'IRegisterProjection.sol', 'IRegisterProjection');
  assert.equal(interfaceId(abi), '0x6309e170');
});

test('IProjectionSettlement computes to the frozen 0xf4a7d71b', () => {
  const abi = abiOf(output, 'IProjectionSettlement.sol', 'IProjectionSettlement');
  assert.equal(interfaceId(abi), '0xf4a7d71b');
});

test('the projection interface declares exactly the seven accessors', () => {
  const abi = abiOf(output, 'IRegisterProjection.sol', 'IRegisterProjection');
  const functions = (abi as AbiEntry[])
    .filter((entry) => entry.type === 'function')
    .map(signature)
    .sort();
  assert.deepEqual(functions, [
    'currentEntry(uint256)',
    'entryAsOf(uint256,uint64)',
    'entryAt(uint256,uint64)',
    'entryCount(uint256)',
    'holderAsOf(uint256,uint64)',
    'isFinalAsOf(uint256,uint64)',
    'registerId()',
    'supportsInterface(bytes4)',
  ]);
});

test('holderAsOf returns one value and isFinalAsOf is separate', () => {
  const abi = abiOf(output, 'IRegisterProjection.sol', 'IRegisterProjection') as {
    type: string; name?: string; outputs?: { type: string }[];
  }[];
  const holder = abi.find((entry) => entry.name === 'holderAsOf');
  assert.deepEqual(holder?.outputs?.map((o) => o.type), ['address']);

  const final = abi.find((entry) => entry.name === 'isFinalAsOf');
  assert.deepEqual(final?.outputs?.map((o) => o.type), ['bool']);
});

test('RegisterEntry carries supersededAt', () => {
  const abi = abiOf(output, 'IRegisterProjection.sol', 'IRegisterProjection') as {
    name?: string; outputs?: { components?: { name: string }[] }[];
  }[];
  const fields = abi.find((entry) => entry.name === 'currentEntry')?.outputs?.[0]?.components?.map((c) => c.name);
  assert.deepEqual(fields, [
    'recordCommitment', 'previousCommitment', 'registryReference',
    'holder', 'version', 'effectiveAt', 'supersededAt',
  ]);
});

test('the settlement interface has no freeze, revoke or override', () => {
  const abi = abiOf(output, 'IProjectionSettlement.sol', 'IProjectionSettlement');
  const names = (abi as AbiEntry[]).filter((e) => e.type === 'function').map((e) => e.name ?? '');
  for (const forbidden of ['freeze', 'revoke', 'override', 'rollback', 'setFinal', 'updateState']) {
    assert.ok(!names.some((name) => name.toLowerCase().includes(forbidden.toLowerCase())),
      `the settlement interface exposes ${forbidden}`);
  }
});
