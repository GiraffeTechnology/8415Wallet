export interface JsonRpcRequest {
  readonly method: string;
  readonly params: readonly unknown[];
}

/** Anything that can answer a JSON-RPC call. Injected so tests need no node. */
export interface JsonRpcTransport {
  send(request: JsonRpcRequest): Promise<unknown>;
}

export class JsonRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

/** HTTP transport. No dependencies: Node's own fetch. */
export class HttpTransport implements JsonRpcTransport {
  #id = 0;
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async send(request: JsonRpcRequest): Promise<unknown> {
    this.#id += 1;
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#id, ...request }),
    });
    if (!response.ok) {
      throw new JsonRpcError(response.status, `rpc transport returned ${response.status}`);
    }
    const payload = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
    if (payload.error !== undefined) {
      throw new JsonRpcError(payload.error.code, payload.error.message);
    }
    return payload.result;
  }
}
