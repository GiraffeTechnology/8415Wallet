import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MemoryErc8415Reader } from '../src/adapters/memory/memoryReader.ts';
import { MemoryRegisterContract } from '../src/adapters/memory/register.ts';
import {
  ALICE,
  DAVE,
  OPEN_GAP_ID,
  T,
  TOKEN,
  commitment,
  divergentToken,
  projectionOnlyToken,
} from '../src/adapters/memory/scenarios.ts';
import { detectConformance } from '../src/sdk/conformance.ts';
import { IdentityChangedError } from '../src/sdk/errors.ts';
import { ContractIdentityPin } from '../src/sdk/identity.ts';
import { ZERO_BYTES32 } from '../src/sdk/types.ts';

describe('contract identity', () => {
  test('is nonzero and carries the chain and address it came from', async () => {
    const { reader } = divergentToken();
    const identity = await new ContractIdentityPin(reader).read(await detectConformance(reader));

    assert.notEqual(identity.registerId, ZERO_BYTES32);
    assert.notEqual(identity.verificationProfile, ZERO_BYTES32);
    assert.equal(identity.chainId, reader.source.chainId);
    assert.equal(identity.address, reader.source.address);
  });

  test('is unchanged across admissions', async () => {
    const { contract, reader } = divergentToken();
    const pin = new ContractIdentityPin(reader);
    const conformance = await detectConformance(reader);
    const before = await pin.read(conformance);

    contract.finalizeSettlement(OPEN_GAP_ID, {
      recordCommitment: commitment('d'),
      registryReference: `0x${'fd'.repeat(32)}`,
      effectiveAt: T.asOf + 1n,
      proofData: '0x',
    });
    assert.equal(contract.currentEntry(TOKEN).holder, DAVE);

    assert.deepEqual(await pin.read(conformance), before);
  });

  test('omits the verification profile when there is no settlement interface', async () => {
    const { reader } = projectionOnlyToken();
    const identity = await new ContractIdentityPin(reader).read(await detectConformance(reader));

    assert.notEqual(identity.registerId, ZERO_BYTES32);
    assert.equal(identity.verificationProfile, undefined);
  });

  test('a changed registerId is rejected, not displayed', async () => {
    const { reader } = divergentToken();

    // A reader whose immutable identity drifts between reads. The ERC says
    // this cannot happen; if it does, the wallet is not talking to the
    // contract it pinned, and nothing it returns can be shown.
    let reads = 0;
    const drifting = {
      ...reader,
      source: reader.source,
      supportsInterface: (id: string) => reader.supportsInterface(id),
      verificationProfile: () => reader.verificationProfile(),
      registerId: async () => {
        reads += 1;
        return reads === 1 ? await reader.registerId() : `0x${'ab'.repeat(32)}`;
      },
    } as typeof reader;

    const pin = new ContractIdentityPin(drifting);
    const conformance = await detectConformance(drifting);
    await pin.read(conformance);

    await assert.rejects(() => pin.read(conformance), IdentityChangedError);
  });

  test('rejects a zero identifier', async () => {
    const contract = new MemoryRegisterContract({
      now: T.beforeFirstEntry,
      registerId: ZERO_BYTES32,
    });
    contract.mint(TOKEN, ALICE);
    const reader = new MemoryErc8415Reader(contract);
    const conformance = await detectConformance(reader);

    await assert.rejects(
      () => new ContractIdentityPin(reader).read(conformance),
      IdentityChangedError,
    );
  });
});
