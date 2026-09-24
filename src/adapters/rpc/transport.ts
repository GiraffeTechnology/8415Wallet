import { ContractRevertError, TransportError } from '../../sdk/errors.ts';
import type { Address } from '../../sdk/types.ts';

/**
 * A minimal transport.
 *
 * `call` raises `ContractRevertError` when the contract reverted, and
 * `TransportError` when the node did not answer. Every other method raises
 * only `TransportError`: a revert is something a contract does, and nothing
 * but `eth_call` executes contract code.
 */
export type CallTransport = {
  call(to: Address, data: string): Promise<string>;
  /** `block.timestamp` of the latest block. */
  blockTimestamp(): Promise<bigint>;
  /** `eth_getLogs`, with the filter passed through as given. */
  getLogs(filter: Record<string, unknown>): Promise<unknown[]>;
  /** `block.timestamp` of one block, by number. */
  blockTimestampAt(blockNumber: bigint): Promise<bigint>;
  /** The latest block number, for bounding a log scan. */
  blockNumber(): Promise<bigint>;
  /** Deployed code at an address, at one block. `0x` where there is none. */
  codeAt(address: Address, blockNumber: bigint): Promise<string>;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string; data?: string };
};

/**
 * JSON-RPC transport over HTTP.
 *
 * Calls are made at `latest`. The wallet does not pin a historical block: an
 * ERC-8415 question is asked with an `instant` argument against current state,
 * not by rewinding the chain, and answering it from an old block would report
 * what the projection used to say rather than what it says about that instant.
 */
export class HttpCallTransport implements CallTransport {
  readonly #endpoint: string;
  #nextId = 1;

  constructor(endpoint: string) {
    this.#endpoint = endpoint;
  }

  async call(to: Address, data: string): Promise<string> {
    const result = await this.#request('eth_call', [{ to, data }, 'latest']);
    if (typeof result !== 'string') {
      throw new Error('eth_call returned no result');
    }
    return result;
  }

  async blockTimestamp(): Promise<bigint> {
    const block = await this.#request('eth_getBlockByNumber', ['latest', false]);
    const timestamp = (block as { timestamp?: string } | null)?.timestamp;
    if (typeof timestamp !== 'string') {
      throw new Error('eth_getBlockByNumber returned no timestamp');
    }
    return BigInt(timestamp);
  }

  async blockTimestampAt(blockNumber: bigint): Promise<bigint> {
    const block = await this.#request('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);
    const timestamp = (block as { timestamp?: string } | null)?.timestamp;
    if (typeof timestamp !== 'string') {
      throw new Error(`no timestamp for block ${blockNumber}`);
    }
    return BigInt(timestamp);
  }

  async getLogs(filter: Record<string, unknown>): Promise<unknown[]> {
    const result = await this.#request('eth_getLogs', [filter]);
    return Array.isArray(result) ? result : [];
  }

  async blockNumber(): Promise<bigint> {
    const result = await this.#request('eth_blockNumber', []);
    if (typeof result !== 'string') {
      throw new TransportError('eth_blockNumber', 'returned no block number');
    }
    return BigInt(result);
  }

  async codeAt(address: Address, blockNumber: bigint): Promise<string> {
    const result = await this.#request('eth_getCode', [
      address,
      `0x${blockNumber.toString(16)}`,
    ]);
    if (typeof result !== 'string') {
      throw new TransportError('eth_getCode', `returned no code for ${address}`);
    }
    return result;
  }

  async #request(method: string, params: unknown[]): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
      });
    } catch (error) {
      throw new TransportError(method, `did not complete: ${String(error)}`);
    }

    if (!response.ok) {
      throw new TransportError(method, `HTTP ${response.status}`);
    }

    let payload: JsonRpcResponse;
    try {
      payload = (await response.json()) as JsonRpcResponse;
    } catch (error) {
      throw new TransportError(method, `reply is not JSON: ${String(error)}`);
    }

    if (payload.error) {
      const { code, message, data } = payload.error;
      // A revert is something a contract does, and only `eth_call` executes
      // contract code. Every other method's error is the node declining to
      // answer — a rate limit, an over-wide range, an outage — and reporting
      // one as a revert states something about the contract that the contract
      // never said.
      if (method === 'eth_call' && isExecutionRevert(code, message, data)) {
        throw new ContractRevertError(message ?? 'execution reverted', data);
      }
      throw new TransportError(method, message ?? `error ${code ?? 'unknown'}`, code);
    }
    return payload.result;
  }
}

/**
 * Whether an `eth_call` error is the contract reverting.
 *
 * Geth signals a revert with code 3 and carries the ABI-encoded error in
 * `data`; the reference implementation's seventeen custom errors all arrive
 * that way. Nodes that omit the code still say so in the message. Anything
 * else on `eth_call` — a rate limit, a timeout, an invalid-params complaint —
 * is the node, not the contract.
 *
 * Erring towards `TransportError` is the safe direction: a revert misread as a
 * transport fault fails loudly, while a transport fault misread as a revert is
 * silently absorbed by every caller that treats a revert as an answer.
 */
function isExecutionRevert(
  code: number | undefined,
  message: string | undefined,
  data: string | undefined,
): boolean {
  if (code === 3) return true;
  if (typeof data === 'string' && data.startsWith('0x') && data.length > 2) return true;
  return /execution reverted|revert/i.test(message ?? '');
}
