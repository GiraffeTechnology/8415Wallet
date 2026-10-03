import { encodeCall, encodeWords } from "../codec/abi.js";
import { ResponsibilityControlClient, decodeControlWords } from "./client.js";
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as check, verifyControlDeployment, FORWARD_FIELDS, FORWARD_TUPLE, forwardConsentValues, validateForwardConsent } from "./authorization.js";
import { callWords, uint, wordAddress, submitFixed, receiptFixed, rpcObject, rpcQuantity } from "./execution.js";
const PAYMENT_STATES = ['unfunded', 'funded', 'settlement-due', 'refund-due', 'settled', 'refunded', 'reserved'];
const OUTCOME_NAMES = ['active', 'completed', 'returning', 'returned'];
/** Optional payment precondition for signed funded forwards, never authority for completion or return. */
export class NativeResponsibilityPaymentClient {
    #provider;
    #control;
    #pin;
    #beforeSend;
    constructor(provider, controller, payment, beforeSend) {
        this.#provider = provider;
        this.#control = new ResponsibilityControlClient(provider, controller);
        this.#pin = Object.freeze({ ...payment });
        this.#beforeSend = beforeSend;
        check(controller.chainId === payment.chainId, 'CONTROL_CHAIN_MISMATCH');
    }
    async #verify() {
        await verifyControlDeployment(this.#provider, this.#control.deployment);
        await verifyControlDeployment(this.#provider, this.#pin);
        const controller = decodeControlWords(['address'], await callWords(this.#provider, this.#pin.controller, encodeCall('controller()', [], [])))[0];
        check(controller === this.#control.deployment.controller.toLowerCase(), 'CONTROL_PAYMENT_CONTROLLER_REFUSED');
        const canonical = decodeControlWords(['address'], await callWords(this.#provider, this.#control.deployment.controller, encodeCall('nativePayments()', [], [])))[0];
        check(canonical === this.#pin.controller.toLowerCase(), 'CONTROL_PAYMENT_ADAPTER_REFUSED');
    }
    async read(sequenceId, legId) {
        check(controlHex(sequenceId, 32) && controlHex(legId, 32), 'CONTROL_PAYMENT_ID_REFUSED');
        await this.#verify();
        const r = decodeControlWords(['address', 'address', 'uint256', 'uint8'], await callWords(this.#provider, this.#pin.controller, encodeCall('payment(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId])));
        const state = PAYMENT_STATES[Number(r[3])];
        check(state !== undefined, 'CONTROL_PAYMENT_STATE_REFUSED');
        return { sequenceId, legId, payer: r[0], payee: r[1], amount: r[2], state };
    }
    /** Read a reservation or detached leg's payment without requiring a live leg record.
     * Every returned fact is pinned to one canonical block; this never submits,
     * signs, allocates or infers commercial/protocol completion from payment state.
     */
    async observe(sequenceId, legId) {
        check(controlHex(sequenceId, 32) && controlHex(legId, 32), 'CONTROL_PAYMENT_ID_REFUSED');
        await this.#verify();
        const header = rpcObject(await controlRpc(this.#provider, 'eth_getBlockByNumber', ['latest', false]));
        check(controlHex(header.hash, 32), 'CONTROL_BLOCK_HASH_REFUSED');
        const blockHash = header.hash.toLowerCase();
        const blockNumber = rpcQuantity(header.number), timestamp = rpcQuantity(header.timestamp);
        const payment = await this.readAt(sequenceId, legId, blockHash);
        const current = rpcObject(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]));
        check(typeof current.hash === 'string' && current.hash.toLowerCase() === blockHash, 'CONTROL_SNAPSHOT_REORGED');
        await this.#verify();
        // Deployment verification performs latest-state RPCs. A reorg during those
        // reads must invalidate the observation too; canonicality is the final RPC.
        const finalHeader = rpcObject(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]));
        check(typeof finalHeader.hash === 'string' && finalHeader.hash.toLowerCase() === blockHash, 'CONTROL_SNAPSHOT_REORGED');
        return { blockNumber, blockHash, timestamp, payment, readOnly: true, protocolFinality: 'not-evaluated' };
    }
    /**
     * How the leg ended, asked of the controller by id.
     *
     * Not read from the leg: a completed leg has detached from the chain by the
     * time its payment settles, so there is no leg left to read. The controller
     * keeps the terminal fact for exactly this reason.
     */
    async #outcomeOf(sequenceId, legId) {
        const r = decodeControlWords(['uint8'], await callWords(this.#provider, this.#control.deployment.controller, encodeCall('legTerminalOutcome(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId])));
        const name = OUTCOME_NAMES[Number(r[0])];
        check(name !== undefined, 'CONTROL_PAYMENT_OUTCOME_REFUSED');
        return name;
    }
    /** A combined UI must use the same canonical block as the responsibility view. */
    async readAt(sequenceId, legId, blockHash) {
        check(controlHex(sequenceId, 32) && controlHex(legId, 32) && controlHex(blockHash, 32), 'CONTROL_PAYMENT_ID_REFUSED');
        await this.#verify();
        const block = { blockHash, requireCanonical: true };
        for (const pin of [this.#pin, this.#control.deployment]) {
            const code = await controlRpc(this.#provider, 'eth_getCode', [pin.controller, block]);
            check(controlHex(code) && hashControlBytes(code) === pin.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
        }
        const r = decodeControlWords(['address', 'address', 'uint256', 'uint8'], await callWords(this.#provider, this.#pin.controller, encodeCall('payment(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), block));
        const state = PAYMENT_STATES[Number(r[3])];
        check(state !== undefined, 'CONTROL_PAYMENT_STATE_REFUSED');
        return { sequenceId, legId, payer: r[0], payee: r[1], amount: r[2], state };
    }
    async termsHash(token, tokenId, from, to, amount) {
        await this.#verify();
        uint(amount, true);
        return decodeControlWords(['bytes32'], await callWords(this.#provider, this.#pin.controller, encodeCall('termsHash(address,uint256,address,address,uint256)', ['address', 'uint256', 'address', 'address', 'uint256'], [token, tokenId, from, to, amount])))[0];
    }
    async reserve(input, payer) {
        const c = Object.freeze({ ...input });
        validateForwardConsent(c);
        await this.#verify();
        check(c.paymentAdapter.toLowerCase() === this.#pin.controller.toLowerCase() && c.paymentAmount > 0n, 'CONTROL_PAYMENT_PROFILE_REFUSED');
        const snapshot = await this.#control.snapshot(c.sequenceId);
        check(!snapshot.sequence.closed && snapshot.sequence.revision === c.expectedRevision &&
            snapshot.sequence.currentAccount === c.fromAccount.toLowerCase() && snapshot.inheritedHash === c.inheritedHash.toLowerCase() &&
            snapshot.timestamp <= c.deadline, 'CONTROL_PAYMENT_CONSENT_STALE');
        const owner = async (account) => decodeControlWords(['address'], await callWords(this.#provider, account, encodeCall('owner()', [], [])))[0];
        const [expectedPayer, payee] = await Promise.all([owner(c.toAccount), owner(c.fromAccount)]);
        check(expectedPayer === payer.toLowerCase(), 'CONTROL_PAYMENT_PAYER_REFUSED');
        check(await this.termsHash(c.token, c.tokenId, c.fromAccount, c.toAccount, c.paymentAmount) === c.termsHash.toLowerCase(), 'CONTROL_PAYMENT_TERMS_REFUSED');
        return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor: payer,
            data: encodeCall(`reserve(${FORWARD_TUPLE})`, FORWARD_FIELDS.map(f => f.type), forwardConsentValues(c)), value: c.paymentAmount,
            event: { address: this.#pin.controller, signature: 'Reserved(bytes32,bytes32,address,address,uint256)',
                indexed: [c.sequenceId, c.legId, wordAddress(payer)], dataHash: hashControlBytes(encodeWords(['address', 'uint256'], [payee, c.paymentAmount])) } }, this.#beforeSend);
    }
    async cancelReservation(sequenceId, legId, actor) {
        const p = await this.read(sequenceId, legId);
        check(p.state === 'reserved' && p.payer === actor.toLowerCase(), 'CONTROL_PAYMENT_RESERVATION_REFUSED');
        return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor,
            data: encodeCall('cancelReservation(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), value: 0n,
            event: { address: this.#pin.controller, signature: 'ReservationCancelled(bytes32,bytes32,address,uint256)',
                indexed: [sequenceId, legId, wordAddress(actor)], dataHash: hashControlBytes(encodeWords(['uint256'], [p.amount])) } }, this.#beforeSend);
    }
    /**
     * Allocate by leg id, not position. A completed leg detaches from the chain
     * before its payment settles, so the position may no longer resolve; the
     * controller still answers how the leg ended.
     */
    async allocate(sequenceId, legId, actor) {
        check(controlHex(sequenceId, 32) && controlHex(legId, 32), 'CONTROL_PAYMENT_ID_REFUSED');
        await this.#verify();
        const p = await this.read(sequenceId, legId);
        const outcome = await this.#outcomeOf(sequenceId, legId);
        check(p.state === 'funded' && (outcome === 'completed' || outcome === 'returned'), 'CONTROL_PAYMENT_OUTCOME_REFUSED');
        const settled = outcome === 'completed';
        const leg = { id: legId.toLowerCase() };
        return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor,
            data: encodeCall('allocate(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), value: 0n,
            event: { address: this.#pin.controller, signature: 'Allocated(bytes32,bytes32,address,uint256,uint8)',
                indexed: [sequenceId, leg.id, wordAddress(settled ? p.payee : p.payer)],
                dataHash: hashControlBytes(encodeWords(['uint256', 'uint8'], [p.amount, settled ? 2n : 3n])) } }, this.#beforeSend);
    }
    async withdraw(sequenceId, legId, actor) {
        const p = await this.read(sequenceId, legId);
        check(p.state === 'settlement-due' || p.state === 'refund-due', 'CONTROL_PAYMENT_NOT_DUE');
        const settled = p.state === 'settlement-due';
        check(actor.toLowerCase() === (settled ? p.payee : p.payer), 'CONTROL_PAYMENT_RECIPIENT_REFUSED');
        return submitFixed(this.#provider, { pin: this.#pin, guards: [this.#control.deployment], actor,
            data: encodeCall('withdraw(bytes32,bytes32)', ['bytes32', 'bytes32'], [sequenceId, legId]), value: 0n,
            event: { address: this.#pin.controller, signature: 'Withdrawn(bytes32,bytes32,address,uint256,uint8)',
                indexed: [sequenceId, legId, wordAddress(actor)],
                dataHash: hashControlBytes(encodeWords(['uint256', 'uint8'], [p.amount, settled ? 4n : 5n])) } }, this.#beforeSend);
    }
    receipt(record, minimumConfirmations = 1n) {
        check(record.pin.chainId === this.#pin.chainId && record.pin.controller.toLowerCase() === this.#pin.controller.toLowerCase() &&
            record.pin.runtimeCodeHash.toLowerCase() === this.#pin.runtimeCodeHash.toLowerCase(), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
        return receiptFixed(this.#provider, record, minimumConfirmations);
    }
}
