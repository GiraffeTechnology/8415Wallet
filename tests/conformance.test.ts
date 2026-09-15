import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import { ALICE, T, TOKEN, divergentToken, projectionOnlyToken } from '../src/adapters/memory/scenarios.ts';
import {
  detectConformance,
  requireProjectionConformance,
  requireSettlementConformance,
} from '../src/sdk/conformance.ts';
import { NonConformantContractError } from '../src/sdk/errors.ts';

describe('conformance discovery', () => {
  test('reports both levels for a settlement-conforming contract', async () => {
    const { reader } = divergentToken();
    assert.deepEqual(await detectConformance(reader), {
      erc165: true,
      projection: true,
      settlement: true,
    });
  });

  test('discovers the two levels separately', async () => {
    const { reader } = projectionOnlyToken();
    assert.deepEqual(await detectConformance(reader), {
      erc165: true,
      projection: true,
      settlement: false,
    });
  });

  test('a contract that does not answer ERC-165 reports every level false', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      conformance: { erc165: false },
    });
    contract.mint(TOKEN, ALICE);
    const reader = new MemoryErc8415Reader(contract);

    assert.deepEqual(await detectConformance(reader), {
      erc165: false,
      projection: false,
      settlement: false,
    });
  });
});

describe('conformance gates the display', () => {
  test('projection data is refused for a non-advertising contract', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      conformance: { projection: false },
    });
    contract.mint(TOKEN, ALICE);
    contract.seedEntries(TOKEN, [{ holder: ALICE, effectiveAt: T.v1, seed: 'a' }]);
    const reader = new MemoryErc8415Reader(contract);

    const conformance = await detectConformance(reader);
    assert.equal(conformance.projection, false);

    // The contract would happily answer. The wallet still must not present it:
    // a contract that never claimed a projection has not got one.
    assert.equal(await reader.holderAsOf(TOKEN, T.v1), ALICE);
    assert.throws(
      () => requireProjectionConformance(reader, conformance),
      NonConformantContractError,
    );
  });

  test('settlement reads are gated independently of projection reads', async () => {
    const { reader } = projectionOnlyToken();
    const conformance = await detectConformance(reader);

    requireProjectionConformance(reader, conformance);
    assert.throws(
      () => requireSettlementConformance(reader, conformance),
      NonConformantContractError,
    );
  });

  test('the error names the contract and the identifier it lacks', async () => {
    const { reader } = projectionOnlyToken();
    const conformance = await detectConformance(reader);
    try {
      requireSettlementConformance(reader, conformance);
      assert.fail('expected a NonConformantContractError');
    } catch (error) {
      assert.ok(error instanceof NonConformantContractError);
      assert.equal(error.interfaceId, '0xf4a7d71b');
      assert.equal(error.address, reader.source.address);
    }
  });
});
