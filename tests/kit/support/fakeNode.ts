import { SELECTOR, encodeCall, word } from '../../../src/kit/adapters/ethereum/abi.ts';
import { JsonRpcError, type JsonRpcRequest, type JsonRpcTransport } from '../../../src/kit/adapters/ethereum/transport.ts';
import type { ProjectionEntry } from '../../../src/kit/engine/projection/types.ts';

export interface FakeState {
  readonly registerId: string;
  readonly entries: readonly ProjectionEntry[];
  readonly openGap: string;
  readonly supports: readonly string[];
  readonly finalized: { number: bigint; stateRoot: string };
  readonly applicationRoot?: string;
}

const encodeEntry = (entry: ProjectionEntry): string =>
  '0x' + [
    word(entry.recordCommitment),
    word(entry.previousCommitment),
    word(entry.registryReference),
    word(entry.holder),
    word(entry.version),
    word(entry.effectiveAt),
    word(entry.supersededAt),
  ].join('');

/**
 * A JSON-RPC node that answers the frozen interfaces, so adapter behaviour is
 * exercised without a chain. It decodes the same calldata the adapter encodes,
 * which is what makes the codec itself part of what is under test.
 */
export class FakeNode implements JsonRpcTransport {
  readonly calls: JsonRpcRequest[] = [];
  #state: FakeState;

  constructor(state: FakeState) {
    this.#state = state;
  }

  set(state: Partial<FakeState>): void {
    this.#state = { ...this.#state, ...state };
  }

  async send(request: JsonRpcRequest): Promise<unknown> {
    this.calls.push(request);

    if (request.method === 'eth_getBlockByNumber') {
      const { number, stateRoot } = this.#state.finalized;
      return { number: `0x${number.toString(16)}`, stateRoot, hash: `0x${number.toString(16).padStart(64, '0')}` };
    }

    if (request.method !== 'eth_call') throw new JsonRpcError(-32601, `unexpected method ${request.method}`);

    const call = request.params[0] as { data: string };
    const selector = call.data.slice(0, 10);
    const args = call.data.slice(10);
    const arg = (i: number): bigint => BigInt(`0x${args.slice(i * 64, (i + 1) * 64)}`);
    const bool = (value: boolean): string => `0x${word(value ? 1n : 0n)}`;

    const entries = this.#state.entries;
    const first = entries[0];
    const latest = entries.at(-1);

    switch (selector) {
      case '0x12345678':
        return this.#state.applicationRoot;
      case SELECTOR.registerId:
        return `0x${word(this.#state.registerId)}`;
      case SELECTOR.entryCount:
        return `0x${word(BigInt(entries.length))}`;
      case SELECTOR.openGapOf:
        return `0x${word(this.#state.openGap)}`;
      case SELECTOR.supportsInterface: {
        const id = `0x${args.slice(0, 8)}`;
        return bool(this.#state.supports.includes(id));
      }
      case SELECTOR.currentEntry:
        if (latest === undefined) throw new JsonRpcError(3, 'execution reverted: no entries');
        return encodeEntry(latest);
      case SELECTOR.entryAt: {
        const found = entries.find((entry) => entry.version === arg(1));
        if (found === undefined) throw new JsonRpcError(3, 'execution reverted: unknown version');
        return encodeEntry(found);
      }
      case SELECTOR.entryAsOf:
      case SELECTOR.holderAsOf: {
        const instant = arg(1);
        if (first === undefined || instant < first.effectiveAt) {
          throw new JsonRpcError(3, 'execution reverted: instant not covered');
        }
        const found = [...entries].reverse().find((entry) => entry.effectiveAt <= instant) as ProjectionEntry;
        return selector === SELECTOR.entryAsOf ? encodeEntry(found) : `0x${word(found.holder)}`;
      }
      case SELECTOR.isFinalAsOf: {
        const instant = arg(1);
        if (first === undefined || latest === undefined) return bool(false);
        return bool(instant >= first.effectiveAt && instant < latest.effectiveAt);
      }
      default:
        throw new JsonRpcError(-32000, `fake node has no answer for ${selector}`);
    }
  }
}

export const callData = encodeCall;
