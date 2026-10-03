/** The provider is on a different chain than the request was built for. */
export class ChainMismatchError extends Error {
    expected;
    actual;
    constructor(expected, actual) {
        super(`this request was built for chain ${expected} and the provider is on chain ${actual}; ` +
            'the same address is a different contract on a different chain');
        this.name = 'ChainMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}
/** The request names a sender this signer does not control. */
export class AccountMismatchError extends Error {
    constructor(expected, actual) {
        super(`this request is from ${expected} and this signer holds ${actual}; ` +
            'a provider asked to send it may substitute its own account silently');
        this.name = 'AccountMismatchError';
    }
}
/** The request carries preflight checks the wallet established would revert. */
export class RefusedFailingPreflightError extends Error {
    constructor(kind, detail) {
        super(`refusing to send ${kind}: ${detail}`);
        this.name = 'RefusedFailingPreflightError';
    }
}
export class Eip1193Signer {
    account;
    #provider;
    constructor(provider, account) {
        this.#provider = provider;
        this.account = account.toLowerCase();
    }
    /**
     * Take the provider's currently selected account.
     *
     * `eth_accounts` rather than `eth_requestAccounts`: connecting is the
     * application's decision and its prompt, not this library's to trigger.
     */
    static async connect(provider) {
        const accounts = await provider.request({ method: 'eth_accounts' });
        const first = Array.isArray(accounts) ? accounts[0] : undefined;
        if (typeof first !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
            throw new Error('the provider has no account available; connect it first');
        }
        return new Eip1193Signer(provider, first);
    }
    /**
     * Send a request the wallet built, unchanged.
     *
     * The three checks before it, in order of how quietly they go wrong:
     *
     *  1. **The chain.** A request carries the chain it was built for, and a
     *     provider can be switched between building and sending — by the user,
     *     or by the page. The same address is a different contract on a
     *     different chain, so sending there is not a failed transaction; it is a
     *     successful one against something else.
     *  2. **The account.** A provider handed a `from` it does not hold may
     *     substitute its own. A settlement sent from the wrong account is a
     *     different act by a different party.
     *  3. **Preflight.** The builders already refuse to produce a request whose
     *     preflight failed, so this only catches one assembled by hand. It costs
     *     nothing and the alternative is paying gas to be told what the wallet
     *     already knew.
     *
     * Unverifiable checks are not refusals. The wallet says what it could not
     * establish and the caller decides; treating "could not check" as "failed"
     * would make every contract without a settlement interface unusable.
     */
    async sendTransaction(request) {
        // Keep the reviewed wire fields stable across asynchronous provider reads.
        // TypeScript readonly is not a runtime boundary for JavaScript callers.
        const wire = { from: request.from, to: request.to, data: request.data,
            value: request.value, chainId: request.chainId };
        const blocking = request.preflight.blocking;
        if (blocking.length > 0) {
            throw new RefusedFailingPreflightError(request.kind, blocking.map((check) => `${check.name} — ${check.detail}`).join('; '));
        }
        const chainId = await this.#chainId();
        if (chainId !== wire.chainId) {
            throw new ChainMismatchError(wire.chainId, chainId);
        }
        if (wire.from.toLowerCase() !== this.account) {
            throw new AccountMismatchError(wire.from.toLowerCase(), this.account);
        }
        // A connected signer is not a permanent grant. Re-read the selected
        // account immediately before sending; retaining it elsewhere in the
        // exposed account list is not permission to act as the selected account.
        const selected = await Eip1193Signer.connect(this.#provider);
        if (selected.account !== this.account) {
            throw new AccountMismatchError(this.account, selected.account);
        }
        // Account discovery is asynchronous too. Detect a network change during
        // that read, and also bind the eventual provider prompt to the chain.
        const currentChainId = await this.#chainId();
        if (currentChainId !== wire.chainId) {
            throw new ChainMismatchError(wire.chainId, currentChainId);
        }
        // Preserve the captured intent and explicitly bind the chain. Gas/fee
        // fields remain the provider's responsibility and approval surface.
        const hash = await this.#provider.request({
            method: 'eth_sendTransaction',
            params: [
                {
                    from: wire.from,
                    to: wire.to,
                    data: wire.data,
                    value: wire.value,
                    chainId: `0x${wire.chainId.toString(16)}`,
                },
            ],
        });
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
            throw new Error(`the provider returned no transaction hash: ${String(hash)}`);
        }
        return hash.toLowerCase();
    }
    async #chainId() {
        const raw = await this.#provider.request({ method: 'eth_chainId' });
        if (typeof raw === 'string')
            return BigInt(raw);
        if (typeof raw === 'number' && Number.isSafeInteger(raw))
            return BigInt(raw);
        throw new Error(`the provider returned no chain id: ${String(raw)}`);
    }
}
