import type { Address, TokenId } from '../projection/types.ts';

/**
 * Who may open a gap on a token.
 *
 * The standard leaves the policy to the verification profile and says only
 * that settlement authority is separate from token ownership. This port is
 * that separation made structural: nothing here can consult an owner, because
 * nothing here is given one.
 */
export interface SettlementAuthority {
  isSettlementAuthority(tokenId: TokenId, account: Address): boolean;
}

/** A fixed allow-list. The simplest policy that is still a real one. */
export class AllowListAuthority implements SettlementAuthority {
  readonly #accounts: ReadonlySet<Address>;

  constructor(accounts: Iterable<Address>) {
    this.#accounts = new Set([...accounts].map((account) => account.toLowerCase()));
  }

  isSettlementAuthority(_tokenId: TokenId, account: Address): boolean {
    return this.#accounts.has(account.toLowerCase());
  }
}
