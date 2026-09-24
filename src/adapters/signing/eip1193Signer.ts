import type { TransactionRequest, TransactionSigner } from '../../sdk/transactions.ts';
import type { Address } from '../../sdk/types.ts';

/**
 * A signer backed by an EIP-1193 provider.
 *
 * This is the wallet's one shipped way of actually sending a settlement
 * transaction, and it holds no key material — the provider does. A browser
 * extension, a hardware wallet behind one, a custodian's signing service: all
 * of them expose `request({ method, params })`, and all of them keep the key
 * on their own side of that call. Nothing here reads, stores or transmits one,
 * because nothing here is ever given one.
 *
 * Signing with a raw private key deliberately lives outside the shipped
 * surface. Doing it properly means secp256k1 with deterministic nonces and
 * low-s normalisation, which is not something to hand-roll beside a wallet,
 * and the moment this library accepted a key it would stop being true that it
 * never holds one. Scripts that need it — a testnet run, a deployment — bring
 * their own signing library and satisfy the same `TransactionSigner` type.
 *
 * What this adds over calling `eth_sendTransaction` directly is three refusals.
 * Each is a mistake that is silent without it.
 */

/** The provider surface this uses, and nothing more. */
export type Eip1193Provider = {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
};

/** The provider is on a different chain than the request was built for. */
export class ChainMismatchError extends Error {
  readonly expected: bigint;
  readonly actual: bigint;

  constructor(expected: bigint, actual: bigint) {
    super(
      `this request was built for chain ${expected} and the provider is on chain ${actual}; ` +
        'the same address is a different contract on a different chain',
    );
    this.name = 'ChainMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** The request names a sender this signer does not control. */
export class AccountMismatchError extends Error {
  constructor(expected: Address, actual: Address) {
    super(
      `this request is from ${expected} and this signer holds ${actual}; ` +
        'a provider asked to send it may substitute its own account silently',
    );
    this.name = 'AccountMismatchError';
  }
}

/** The request carries preflight checks the wallet established would revert. */
export class RefusedFailingPreflightError extends Error {
  constructor(kind: string, detail: string) {
    super(`refusing to send ${kind}: ${detail}`);
    this.name = 'RefusedFailingPreflightError';
  }
}

export class Eip1193Signer implements TransactionSigner {
  readonly account: Address;
  readonly #provider: Eip1193Provider;

  constructor(provider: Eip1193Provider, account: Address) {
    this.#provider = provider;
    this.account = account.toLowerCase();
  }

  /**
   * Take the provider's currently selected account.
   *
   * `eth_accounts` rather than `eth_requestAccounts`: connecting is the
   * application's decision and its prompt, not this library's to trigger.
   */
  static async connect(provider: Eip1193Provider): Promise<Eip1193Signer> {
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
  async sendTransaction(request: TransactionRequest): Promise<string> {
    const blocking = request.preflight.blocking;
    if (blocking.length > 0) {
      throw new RefusedFailingPreflightError(
        request.kind,
        blocking.map((check) => `${check.name} — ${check.detail}`).join('; '),
      );
    }

    const chainId = await this.#chainId();
    if (chainId !== request.chainId) {
      throw new ChainMismatchError(request.chainId, chainId);
    }

    if (request.from.toLowerCase() !== this.account) {
      throw new AccountMismatchError(request.from.toLowerCase(), this.account);
    }

    // Passed through exactly as built. No gas estimate is added and no field
    // is rewritten: what the user was shown is what is sent, and the provider
    // is free to fill what it fills.
    const hash = await this.#provider.request({
      method: 'eth_sendTransaction',
      params: [
        {
          from: request.from,
          to: request.to,
          data: request.data,
          value: request.value,
        },
      ],
    });

    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(`the provider returned no transaction hash: ${String(hash)}`);
    }
    return hash.toLowerCase();
  }

  async #chainId(): Promise<bigint> {
    const raw = await this.#provider.request({ method: 'eth_chainId' });
    if (typeof raw === 'string') return BigInt(raw);
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) return BigInt(raw);
    throw new Error(`the provider returned no chain id: ${String(raw)}`);
  }
}
