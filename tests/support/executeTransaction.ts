import {
  decodeResult,
  type StaticType,
} from '../../src/codec/abi.ts';
import type { MemoryRegisterContract } from '../../src/adapters/memory/register.ts';
import { selectorOf } from '../../src/sdk/interfaceIds.ts';
import type { TransactionRequest } from '../../src/sdk/transactions.ts';
import type { Address, Bytes32 } from '../../src/sdk/types.ts';

/**
 * Apply a built transaction to the modelled contract.
 *
 * Decodes the calldata the wallet produced and calls the contract with it, so
 * a test proves the whole path: preflight, encoding, and the effect on the
 * projection. A transaction builder tested only against its own expected hex
 * is a builder nobody has executed.
 */
export function executeTransaction(
  contract: MemoryRegisterContract,
  request: TransactionRequest,
): void {
  const selector = request.data.slice(0, 10);
  const body = `0x${request.data.slice(10)}`;
  const head = (types: readonly StaticType[]) => decodeResult(types, body);

  switch (selector) {
    case selectorOf('beginSettlement(uint256,bytes32,address,bytes32,uint64)'): {
      const [tokenId, settlementId, expectedHolder, snapshotHash, deadline] = head([
        'uint256',
        'bytes32',
        'address',
        'bytes32',
        'uint64',
      ]);
      contract.beginSettlement(
        request.from,
        tokenId as bigint,
        settlementId as Bytes32,
        expectedHolder as Address,
        snapshotHash as Bytes32,
        deadline as bigint,
      );
      return;
    }
    case selectorOf('finalizeSettlement(bytes32,bytes32,bytes32,uint64,bytes)'): {
      const [settlementId, recordCommitment, registryReference, effectiveAt] = head([
        'bytes32',
        'bytes32',
        'bytes32',
        'uint64',
      ]);
      contract.finalizeSettlement(settlementId as Bytes32, {
        recordCommitment: recordCommitment as Bytes32,
        registryReference: registryReference as Bytes32,
        effectiveAt: effectiveAt as bigint,
        proofData: decodeTrailingBytes(body, 4),
      });
      return;
    }
    case selectorOf('cancelSettlement(bytes32,bytes32)'): {
      const [settlementId, reasonHash] = head(['bytes32', 'bytes32']);
      contract.cancelSettlement(request.from, settlementId as Bytes32, reasonHash as Bytes32);
      return;
    }
    default:
      throw new Error(`unknown selector ${selector}`);
  }
}

/** Read a dynamic `bytes` argument back out of the tail. */
function decodeTrailingBytes(body: string, headWordIndex: number): string {
  const hex = body.slice(2);
  const offset = Number(BigInt(`0x${hex.slice(headWordIndex * 64, (headWordIndex + 1) * 64)}`));
  const lengthAt = offset * 2;
  const length = Number(BigInt(`0x${hex.slice(lengthAt, lengthAt + 64)}`));
  return `0x${hex.slice(lengthAt + 64, lengthAt + 64 + length * 2)}`;
}
