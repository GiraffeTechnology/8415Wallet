import { ContractIdentityPin } from '../sdk/identity.ts';
import type { Erc8415Reader } from '../sdk/port.ts';
import {
  buildBeginSettlement,
  buildCancelSettlement,
  buildFinalizeSettlement,
  type BeginSettlementParams,
  type CancelSettlementParams,
  type FinalizeSettlementParams,
  type TransactionRequest,
  type TransactionSigner,
} from '../sdk/transactions.ts';
import type { Address, Instant, TokenId } from '../sdk/types.ts';
import type { WatchtowerBinding } from '../sdk/watchtower.ts';
import { buildAssetView, type AssetView } from './assetView.ts';
import { exportAuditTrail, type AuditTrail } from './auditTrail.ts';
import { buildFreshnessView, noWatchtower, type FreshnessView } from './freshness.ts';
import { buildHistoryView, type HistoryView } from './history.ts';
import { buildRiskSurfaces, type RiskSurfaceView } from './riskSurfaces.ts';
import { buildSettlementLog, type SettlementLogView } from './settlementLog.ts';
import { buildTemporalView, type TemporalView } from './temporalQuery.ts';

/**
 * A wallet bound to one contract.
 *
 * Two things this exists for beyond convenience.
 *
 * It holds a single `ContractIdentityPin` and passes it to every view, so
 * `registerId` and `verificationProfile` are compared across every read in the
 * session. Both are specified immutable; a change means the wallet is not
 * talking to the contract it pinned, and that is only detectable if the reads
 * share a pin. Views constructing their own would each compare a value against
 * itself and find nothing.
 *
 * And it is the surface an application integrates against. The `Erc8415Reader`
 * port is the seam for backends; this is the seam for consumers.
 */
export class WalletSession {
  readonly reader: Erc8415Reader;
  readonly identity: ContractIdentityPin;

  readonly #account: Address | undefined;
  readonly #watchtower: WatchtowerBinding | undefined;

  constructor(
    reader: Erc8415Reader,
    options: {
      /** The account views report authority for, and transactions are built from. */
      readonly account?: Address;
      /** The watchtower feed this projection is read alongside, if any. */
      readonly watchtower?: WatchtowerBinding;
    } = {},
  ) {
    this.reader = reader;
    this.identity = new ContractIdentityPin(reader);
    this.#account = options.account;
    this.#watchtower = options.watchtower;
  }

  /** The account, or `undefined` for a watch-only session. */
  get account(): Address | undefined {
    return this.#account;
  }

  assetView(tokenId: TokenId): Promise<AssetView> {
    return buildAssetView(this.reader, tokenId, {
      identityPin: this.identity,
      ...(this.#account === undefined ? {} : { account: this.#account }),
    });
  }

  temporalQuery(tokenId: TokenId, instant: Instant): Promise<TemporalView> {
    return buildTemporalView(this.reader, tokenId, instant, { identityPin: this.identity });
  }

  history(tokenId: TokenId): Promise<HistoryView> {
    return buildHistoryView(this.reader, tokenId, { identityPin: this.identity });
  }

  settlementLog(tokenId: TokenId): Promise<SettlementLogView> {
    return buildSettlementLog(this.reader, tokenId);
  }

  riskSurfaces(tokenId: TokenId): Promise<RiskSurfaceView> {
    return buildRiskSurfaces(
      this.reader,
      tokenId,
      this.#account === undefined ? {} : { account: this.#account },
    );
  }

  /**
   * Freshness for the configured feed.
   *
   * Returns the not-configured view when no binding was supplied, rather than
   * failing: a projection reads perfectly well without a watchtower.
   */
  freshness(): Promise<FreshnessView> {
    return this.#watchtower === undefined
      ? Promise.resolve(noWatchtower())
      : buildFreshnessView(this.#watchtower);
  }

  auditTrail(tokenId: TokenId): Promise<AuditTrail> {
    return exportAuditTrail(this.reader, tokenId, { identityPin: this.identity });
  }

  /**
   * Build the three settlement operations, and no others.
   *
   * Building requires an account, because every check that matters — who may
   * open a gap, who may cancel one — is about a specific sender.
   */
  get transactions(): {
    beginSettlement(params: BeginSettlementParams): Promise<TransactionRequest>;
    finalizeSettlement(params: FinalizeSettlementParams): Promise<TransactionRequest>;
    cancelSettlement(params: CancelSettlementParams): Promise<TransactionRequest>;
  } {
    const from = this.#requireAccount();
    return {
      beginSettlement: (params) => buildBeginSettlement(this.reader, from, params),
      finalizeSettlement: (params) => buildFinalizeSettlement(this.reader, from, params),
      cancelSettlement: (params) => buildCancelSettlement(this.reader, from, params),
    };
  }

  /**
   * Hand a built request to a signer.
   *
   * The wallet never signs. It refuses to hand a request to a signer for a
   * different account rather than letting a mismatch reach a hardware prompt
   * that a user would have to notice.
   */
  async send(request: TransactionRequest, signer: TransactionSigner): Promise<string> {
    if (signer.account !== request.from) {
      throw new Error(
        `this request is built for ${request.from}; the signer holds ${signer.account}`,
      );
    }
    return signer.sendTransaction(request);
  }

  #requireAccount(): Address {
    if (this.#account === undefined) {
      throw new Error(
        'this session is watch-only: no account was supplied, so no transaction can be built',
      );
    }
    return this.#account;
  }
}
