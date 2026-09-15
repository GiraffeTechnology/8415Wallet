import { ContractRevertError } from '../../sdk/errors.ts';
import type { Address } from '../../sdk/types.ts';

/** A minimal `eth_call` transport. Throws `ContractRevertError` on revert. */
export type CallTransport = {
  call(to: Address, data: string): Promise<string>;
};

type JsonRpcResponse = {
  result?: string;
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
    const response = await fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.#nextId++,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });

    if (!response.ok) {
      throw new Error(`eth_call transport failed: HTTP ${response.status}`);
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
    if (typeof payload.result !== 'string') {
      throw new Error('eth_call returned no result');
    }
    return payload.result;
  }
}
