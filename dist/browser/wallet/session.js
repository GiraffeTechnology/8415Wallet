import { ContractIdentityPin } from "../sdk/identity.js";
import { buildBeginSettlement, buildCancelSettlement, buildFinalizeSettlement, revalidate as revalidateRequest, } from "../sdk/transactions.js";
import { describeAcquisition } from "./acquisition.js";
import { buildAssetView } from "./assetView.js";
import { detectCollisions } from "./collisions.js";
import { describePosture } from "./posture.js";
import { describeRegistration } from "./registration.js";
import { exportAuditTrail } from "./auditTrail.js";
import { buildFreshnessView, noWatchtower } from "./freshness.js";
import { buildHistoryView } from "./history.js";
import { buildOwnershipHistory } from "./ownershipHistory.js";
import { buildRiskSurfaces } from "./riskSurfaces.js";
import { buildSettlementLog } from "./settlementLog.js";
import { buildTemporalView } from "./temporalQuery.js";
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
    reader;
    identity;
    #account;
    #watchtower;
    constructor(reader, options = {}) {
        this.reader = reader;
        this.identity = new ContractIdentityPin(reader);
        this.#account = options.account;
        this.#watchtower = options.watchtower;
    }
    /** The account, or `undefined` for a watch-only session. */
    get account() {
        return this.#account;
    }
    assetView(tokenId) {
        return buildAssetView(this.reader, tokenId, {
            identityPin: this.identity,
            ...(this.#account === undefined ? {} : { account: this.#account }),
        });
    }
    /**
     * What a pending registration means for the holder.
     *
     * Derived from the asset view, so it costs no extra reads.
     */
    async registration(tokenId) {
        return describeRegistration(await this.assetView(tokenId));
    }
    /** The facts someone about to acquire this token should see first. */
    async acquisitionDisclosure(tokenId) {
        const view = await this.assetView(tokenId);
        return describeAcquisition(view, view.observedAt);
    }
    /**
     * The projection's answer and the feed's currency, together.
     *
     * Each is computed apart, as it must be. Showing them together is what stops
     * a stale feed being read as an ordinary pending change.
     */
    async posture(tokenId, instant) {
        const [temporal, freshness] = await Promise.all([
            this.temporalQuery(tokenId, instant),
            this.freshness(),
        ]);
        return describePosture(temporal.finality, freshness);
    }
    /**
     * Compare commitments and references across tokens.
     *
     * The protocol enforces uniqueness per token only, so this is the layer that
     * can see a register entry backing two assets. It compares what it is given
     * and says so.
     */
    collisions(tokenIds) {
        return detectCollisions(this.reader, tokenIds, { identityPin: this.identity });
    }
    /** Re-derive a built request and report what moved underneath it. */
    revalidate(request) {
        return revalidateRequest(this.reader, request);
    }
    temporalQuery(tokenId, instant) {
        return buildTemporalView(this.reader, tokenId, instant, { identityPin: this.identity });
    }
    /**
     * Both sequences on one timeline.
     *
     * `history` walks the projection alone; this walks the ERC-721 ownership
     * sequence alongside it, which is the other half of the record the ERC
     * describes.
     */
    ownershipHistory(tokenId) {
        return buildOwnershipHistory(this.reader, tokenId);
    }
    history(tokenId) {
        return buildHistoryView(this.reader, tokenId, { identityPin: this.identity });
    }
    settlementLog(tokenId) {
        return buildSettlementLog(this.reader, tokenId);
    }
    riskSurfaces(tokenId) {
        return buildRiskSurfaces(this.reader, tokenId, this.#account === undefined ? {} : { account: this.#account });
    }
    /**
     * Freshness for the configured feed.
     *
     * Returns the not-configured view when no binding was supplied, rather than
     * failing: a projection reads perfectly well without a watchtower.
     */
    freshness() {
        return this.#watchtower === undefined
            ? Promise.resolve(noWatchtower())
            : buildFreshnessView(this.#watchtower);
    }
    auditTrail(tokenId) {
        return exportAuditTrail(this.reader, tokenId, { identityPin: this.identity });
    }
    /**
     * Build the three settlement operations, and no others.
     *
     * Building requires an account, because every check that matters — who may
     * open a gap, who may cancel one — is about a specific sender.
     */
    get transactions() {
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
    async send(request, signer) {
        if (signer.account !== request.from) {
            throw new Error(`this request is built for ${request.from}; the signer holds ${signer.account}`);
        }
        return signer.sendTransaction(request);
    }
    #requireAccount() {
        if (this.#account === undefined) {
            throw new Error('this session is watch-only: no account was supplied, so no transaction can be built');
        }
        return this.#account;
    }
}
