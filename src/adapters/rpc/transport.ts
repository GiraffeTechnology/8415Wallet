import { ContractRevertError } from '../../sdk/errors.ts';
import type { Address } from '../../sdk/types.ts';

/** A minimal `eth_call` transport. Throws `ContractRevertError` on revert. */
export type CallTransport = {
  call(to: Address, data: string): Promise<string>;
  /** `block.timestamp` of the latest block. */
  blockTimestamp(): Promise<bigint>;
  /** `eth_getLogs`, with the filter passed through as given. */
  getLogs(filter: Record<string, unknown>): Promise<unknown[]>;
  /** `block.timestamp` of one block, by number. */
  blockTimestampAt(blockNumber: bigint): Promise<bigint>;
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

  async #request(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
    });

    if (!response.ok) {
      throw new Error(`${method} transport failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      // Execution reverted arrives as an error, not as a result. Surface it as
      // a revert so callers can distinguish it from a transport failure.
      throw new ContractRevertError(
        payload.error.message ?? 'execution reverted',
        payload.error.data,
      );
    }
    return payload.result;
  }
}
