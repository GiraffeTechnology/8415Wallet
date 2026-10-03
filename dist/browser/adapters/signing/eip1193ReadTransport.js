import { ContractRevertError, TransportError } from "../../sdk/errors.js";
/** Read-only original-wallet transport through a genuine selected provider. */
export class Eip1193ReadTransport {
    #provider;
    #chainId;
    constructor(provider, chainId) { this.#provider = provider; this.#chainId = chainId; }
    async #request(method, params) {
        let timer;
        const work = async () => {
            const chain = await this.#provider.request({ method: 'eth_chainId', params: [] });
            if (typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== this.#chainId)
                throw new TransportError(method, 'chain mismatch');
            try {
                return await this.#provider.request({ method, params });
            }
            catch (error) {
                // Only the structured EIP-1474 execution-reverted code; never classify from message substrings.
                if (method === 'eth_call' && error !== null && typeof error === 'object' &&
                    error.code === 3)
                    throw new ContractRevertError('eth_call');
                throw new TransportError(method, 'provider refused');
            }
        };
        try {
            return await Promise.race([work(), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new TransportError(method, 'bounded request expired')), 30000);
                })]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    #quantity(value) {
        if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value))
            throw new TransportError('quantity', 'invalid response');
        return BigInt(value);
    }
    async call(to, data) {
        const value = await this.#request('eth_call', [{ to, data }, 'latest']);
        if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value))
            throw new TransportError('eth_call', 'invalid response');
        return value;
    }
    async #timestamp(block) {
        const value = await this.#request('eth_getBlockByNumber', [block, false]);
        if (value === null || typeof value !== 'object')
            throw new TransportError('block', 'missing response');
        return this.#quantity(value.timestamp);
    }
    blockTimestamp() { return this.#timestamp('latest'); }
    blockTimestampAt(block) { return this.#timestamp(`0x${block.toString(16)}`); }
    async blockNumber() { return this.#quantity(await this.#request('eth_blockNumber', [])); }
    async getLogs(filter) {
        const value = await this.#request('eth_getLogs', [filter]);
        if (!Array.isArray(value))
            throw new TransportError('eth_getLogs', 'invalid response');
        return value;
    }
    async codeAt(address, block) {
        const value = await this.#request('eth_getCode', [address, `0x${block.toString(16)}`]);
        if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value))
            throw new TransportError('eth_getCode', 'invalid response');
        return value;
    }
}
