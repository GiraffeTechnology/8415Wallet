import { decodeResult, encodeCall } from "../codec/abi.js";
import { keccak256Utf8 } from "../codec/keccak.js";
import { controlHex, controlRpc, controlPendingNonce, encodeForward, forwardConsentDigest, hashControlBytes, requireControlAdapter as requireValue, validateControlPin, verifyControlDeployment, } from "./authorization.js";
const SEQUENCE_TYPES = ['address', 'uint256', 'address', 'address', 'address',
    'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'bool'];
const LEG_TYPES = ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'address', 'bytes32', 'uint8'];
const OUTCOMES = ['active', 'completed', 'returning', 'returned'];
const EVENTS = {
    'create-account': 'AccountCreated(address,address)',
    'open-sequence': 'SequenceOpened(bytes32,address,uint256,address,address)',
    forward: 'Forwarded(bytes32,bytes32,uint256,address,address,bytes32,uint256)',
    'bind-admission': 'AdmissionBound(bytes32,uint64,uint256,bytes32,uint256)',
    complete: 'PrefixCompleted(bytes32,uint256,uint64,uint256)',
    'begin-return': 'ReturnBegun(bytes32,bytes32,bytes32,bytes32,uint256)',
    'return-hop': 'ReturnHopCompleted(bytes32,bytes32,address,address,uint256)',
    'close-sequence': 'SequenceClosed(bytes32,uint256)',
    'invalidate-consent': 'RecipientNonceInvalidated(address,uint256)',
};
function object(value) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'CONTROL_RPC_SCHEMA_REFUSED');
    return value;
}
function quantity(value) {
    requireValue(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'CONTROL_RPC_QUANTITY_REFUSED');
    return BigInt(value);
}
export function decodeControlWords(types, value) {
    requireValue(controlHex(value, types.length * 32), 'CONTROL_ABI_LENGTH_REFUSED');
    const values = decodeResult(types, value);
    for (const [i, type] of types.entries()) {
        const word = value.slice(2 + i * 64, 2 + (i + 1) * 64);
        if (type === 'address')
            requireValue(/^0{24}/.test(word), 'CONTROL_ABI_PADDING_REFUSED');
        if (type === 'bool')
            requireValue(BigInt(`0x${word}`) <= 1n, 'CONTROL_ABI_BOOLEAN_REFUSED');
        if (type === 'uint8' || type === 'uint64')
            requireValue(BigInt(`0x${word}`) < 1n << (type === 'uint8' ? 8n : 64n), 'CONTROL_ABI_INTEGER_REFUSED');
    }
    return values;
}
const strictDecode = decodeControlWords;
function encodeAction(action) {
    const encode = (signature, types, values) => encodeCall(signature, types, values);
    switch (action.kind) {
        case 'create-account': return encode('createAccount()', [], []);
        case 'open-sequence': return encode('openSequence(address,uint256,address)', ['address', 'uint256', 'address'], [action.token, action.tokenId, action.evidenceAuthority]);
        case 'forward': return encodeForward(action.consent, action.recipientSignature);
        case 'bind-admission': return encode('bindAdmission(bytes32,uint256,uint64,uint256)', ['bytes32', 'uint256', 'uint64', 'uint256'], [action.sequenceId, action.occurrence, action.version, action.expectedRevision]);
        case 'complete': return encode('completeThrough(bytes32,bytes32,uint256)', ['bytes32', 'bytes32', 'uint256'], [action.sequenceId, action.throughLegId, action.expectedRevision]);
        case 'begin-return': return encode('beginReturn(bytes32,bytes32,bytes32,bytes32,uint256)', ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256'], [action.sequenceId, action.rootLegId, action.conditionHash, action.evidenceCommitment, action.expectedRevision]);
        case 'return-hop': return encode('returnHop(bytes32,bytes32,uint256)', ['bytes32', 'bytes32', 'uint256'], [action.sequenceId, action.legId, action.expectedRevision]);
        case 'close-sequence': return encode('closeSequence(bytes32,uint256)', ['bytes32', 'uint256'], [action.sequenceId, action.expectedRevision]);
        case 'invalidate-consent': return encode('invalidateRecipientNonce(uint256)', ['uint256'], [action.nextNonce]);
        default: throw new Error('CONTROL_ACTION_REFUSED');
    }
}
/** No raw-key support, automatic signing, transaction retries, or fallback to unpinned reads. */
export class ResponsibilityControlClient {
    deployment;
    #provider;
    #beforeSend;
    constructor(provider, deployment, beforeSend) {
        validateControlPin(deployment);
        this.#provider = provider;
        this.#beforeSend = beforeSend;
        this.deployment = Object.freeze({ ...deployment });
    }
    async snapshot(sequenceId) {
        requireValue(controlHex(sequenceId, 32), 'CONTROL_SEQUENCE_ID_REFUSED');
        await verifyControlDeployment(this.#provider, this.deployment);
        const header = object(await controlRpc(this.#provider, 'eth_getBlockByNumber', ['latest', false]));
        requireValue(controlHex(header.hash, 32), 'CONTROL_BLOCK_HASH_REFUSED');
        const blockHash = header.hash.toLowerCase();
        const blockNumber = quantity(header.number);
        const timestamp = quantity(header.timestamp);
        const block = { blockHash, requireCanonical: true };
        const read = async (signature, types, args, returns) => strictDecode(returns, await controlRpc(this.#provider, 'eth_call', [
            { to: this.deployment.controller, data: encodeCall(signature, types, args) }, block,
        ]));
        const code = await controlRpc(this.#provider, 'eth_getCode', [this.deployment.controller, block]);
        requireValue(controlHex(code) && hashControlBytes(code) === this.deployment.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
        const f = await read('sequence(bytes32)', ['bytes32'], [sequenceId], SEQUENCE_TYPES);
        const sequence = { token: f[0], tokenId: f[1],
            initialAccount: f[2], currentAccount: f[3], evidenceAuthority: f[4],
            registerId: f[5], verificationProfile: f[6], tokenCodeHash: f[7],
            revision: f[8], cursor: f[9], completedCount: f[10],
            callbackRootPlusOne: f[11], appended: f[12],
            detachedCommitment: f[13], closed: f[14] };
        const count = (await read('legCount(bytes32)', ['bytes32'], [sequenceId], ['uint256']))[0];
        // The window is bounded; retained history is not, because the chain does not
        // retain it. A detached prefix lives at the register.
        requireValue(sequence.cursor - sequence.completedCount <= 128n &&
            sequence.appended === count && sequence.completedCount <= sequence.cursor && sequence.cursor <= count &&
            (sequence.callbackRootPlusOne === 0n || (sequence.callbackRootPlusOne > sequence.completedCount &&
                sequence.callbackRootPlusOne <= sequence.cursor)) &&
            (!sequence.closed || (sequence.cursor === sequence.completedCount && sequence.callbackRootPlusOne === 0n)), 'CONTROL_SEQUENCE_SHAPE_REFUSED');
        const legs = [];
        const firstOccurrence = sequence.completedCount;
        for (let i = firstOccurrence; i < count; i++) {
            const l = await read('legAt(bytes32,uint256)', ['bytes32', 'uint256'], [sequenceId, i], LEG_TYPES);
            const outcome = OUTCOMES[Number(l[7])];
            requireValue(outcome !== undefined, 'CONTROL_OUTCOME_REFUSED');
            legs.push({ id: l[0], fromAccount: l[1], toAccount: l[2],
                termsHash: l[3], acceptanceHash: l[4], returnAuthority: l[5],
                returnConditionHash: l[6], outcome });
        }
        const inheritedHash = (await read('inheritedHash(bytes32)', ['bytes32'], [sequenceId], ['bytes32']))[0];
        const ids = new Set();
        for (const [i, leg] of legs.entries()) {
            // Continuity is checked across the window. The leg before `legs[0]` has
            // detached, so its account is not on chain to chain back to; when nothing
            // has detached, the window still starts at the sequence's initial account.
            const predecessor = i === 0
                ? (firstOccurrence === 0n ? sequence.initialAccount : leg.fromAccount)
                : legs[i - 1].toAccount;
            requireValue(!ids.has(leg.id) && leg.fromAccount === predecessor, 'CONTROL_LEG_CONTINUITY_REFUSED');
            ids.add(leg.id);
            const n = firstOccurrence + BigInt(i);
            const expected = n < sequence.completedCount ? 'completed' : n >= sequence.cursor ? 'returned' :
                sequence.callbackRootPlusOne !== 0n && n >= sequence.callbackRootPlusOne - 1n ? 'returning' : 'active';
            requireValue(leg.outcome === expected, 'CONTROL_LEG_STATE_REFUSED');
        }
        requireValue(sequence.currentAccount === (sequence.cursor === firstOccurrence
            ? (firstOccurrence === 0n ? sequence.initialAccount : sequence.currentAccount)
            : legs[Number(sequence.cursor - firstOccurrence - 1n)].toAccount), 'CONTROL_CURSOR_ACCOUNT_REFUSED');
        const end = object(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]));
        requireValue(typeof end.hash === 'string' && end.hash.toLowerCase() === blockHash, 'CONTROL_SNAPSHOT_REORGED');
        return { sequenceId, blockNumber, blockHash, timestamp, sequence, legs, firstOccurrence, inheritedHash };
    }
    /** Explicit transaction submission; a returned hash is only pending, never completion. */
    async submit(action, actor) {
        const fixed = structuredClone(action);
        const data = encodeAction(fixed);
        requireValue(controlHex(actor, 20), 'CONTROL_ACTOR_REFUSED');
        const accounts = async () => {
            const result = await controlRpc(this.#provider, 'eth_accounts', []);
            requireValue(Array.isArray(result) && typeof result[0] === 'string' && result[0].toLowerCase() === actor.toLowerCase(), 'CONTROL_SIGNER_MISMATCH');
        };
        await verifyControlDeployment(this.#provider, this.deployment);
        await accounts();
        const tx = { from: actor, to: this.deployment.controller, data, value: '0x0', chainId: `0x${this.deployment.chainId.toString(16)}` };
        const simulated = await controlRpc(this.#provider, 'eth_call', [tx, 'latest']);
        requireValue(controlHex(simulated), 'CONTROL_PREFLIGHT_RESPONSE_REFUSED');
        await verifyControlDeployment(this.#provider, this.deployment);
        await accounts();
        const nonce = controlPendingNonce(await controlRpc(this.#provider, 'eth_getTransactionCount', [actor, 'pending']));
        const template = { schema: '8415-control-submission/1', deployment: { ...this.deployment }, kind: fixed.kind,
            transactionHash: `0x${'0'.repeat(64)}`, actor: actor.toLowerCase(), nonce, calldataHash: hashControlBytes(data),
            sequenceId: fixed.kind === 'forward' ? fixed.consent.sequenceId : 'sequenceId' in fixed ? fixed.sequenceId : null,
            legId: fixed.kind === 'forward' ? fixed.consent.legId : fixed.kind === 'return-hop' ? fixed.legId : fixed.kind === 'begin-return' ? fixed.rootLegId : null,
            expectedRevision: fixed.kind === 'forward' ? fixed.consent.expectedRevision : 'expectedRevision' in fixed ? fixed.expectedRevision : null,
            acceptanceHash: fixed.kind === 'forward' ? forwardConsentDigest(this.deployment, fixed.consent) : null };
        if (this.#beforeSend)
            await this.#beforeSend(structuredClone(template));
        const hash = await controlRpc(this.#provider, 'eth_sendTransaction', [{ ...tx, nonce: `0x${nonce.toString(16)}` }]);
        requireValue(controlHex(hash, 32), 'CONTROL_TRANSACTION_HASH_REFUSED');
        return { ...template, transactionHash: hash.toLowerCase() };
    }
    /** One bounded observation; no automatic resubmission when pending, failed or reorged. */
    async receipt(record, minimumConfirmations = 1n) {
        record = parseControlSubmission(serializeControlSubmission(record));
        requireValue(record.schema === '8415-control-submission/1' && Object.hasOwn(EVENTS, record.kind) &&
            controlHex(record.transactionHash, 32) && controlHex(record.calldataHash, 32) &&
            record.deployment.chainId === this.deployment.chainId &&
            record.deployment.controller.toLowerCase() === this.deployment.controller.toLowerCase() &&
            record.deployment.runtimeCodeHash.toLowerCase() === this.deployment.runtimeCodeHash.toLowerCase(), 'CONTROL_SUBMISSION_BINDING_REFUSED');
        requireValue(typeof minimumConfirmations === 'bigint' && minimumConfirmations >= 1n && minimumConfirmations <= 1024n, 'CONTROL_CONFIRMATION_POLICY_REFUSED');
        await verifyControlDeployment(this.#provider, this.deployment);
        const raw = await controlRpc(this.#provider, 'eth_getTransactionReceipt', [record.transactionHash]);
        const base = { transactionHash: record.transactionHash, protocolFinality: 'not-evaluated' };
        if (raw === null)
            return { ...base, state: 'pending', blockNumber: null, blockHash: null, confirmations: 0n, executionEventObserved: false };
        const receipt = object(raw);
        requireValue(typeof receipt.transactionHash === 'string' && receipt.transactionHash.toLowerCase() === record.transactionHash &&
            typeof receipt.to === 'string' && receipt.to.toLowerCase() === this.deployment.controller.toLowerCase() &&
            typeof receipt.from === 'string' && receipt.from.toLowerCase() === record.actor && controlHex(receipt.blockHash, 32), 'CONTROL_RECEIPT_BINDING_REFUSED');
        const number = quantity(receipt.blockNumber);
        const blockHash = receipt.blockHash.toLowerCase();
        const at = { ...base, blockNumber: number, blockHash };
        const header = object(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));
        if (typeof header.hash !== 'string' || header.hash.toLowerCase() !== blockHash)
            return { ...at, state: 'reorged', confirmations: 0n, executionEventObserved: false };
        const transaction = object(await controlRpc(this.#provider, 'eth_getTransactionByHash', [record.transactionHash]));
        requireValue(controlHex(transaction.input) && hashControlBytes(transaction.input) === record.calldataHash &&
            typeof transaction.hash === 'string' && transaction.hash.toLowerCase() === record.transactionHash &&
            typeof transaction.blockHash === 'string' && transaction.blockHash.toLowerCase() === blockHash &&
            quantity(transaction.blockNumber) === number && quantity(transaction.chainId) === this.deployment.chainId &&
            quantity(transaction.value) === 0n && quantity(transaction.nonce) === record.nonce &&
            typeof transaction.from === 'string' && transaction.from.toLowerCase() === record.actor &&
            typeof transaction.to === 'string' && transaction.to.toLowerCase() === this.deployment.controller.toLowerCase(), 'CONTROL_TRANSACTION_BINDING_REFUSED');
        const head = quantity(await controlRpc(this.#provider, 'eth_blockNumber', []));
        requireValue(head >= number, 'CONTROL_HEAD_BEHIND_RECEIPT');
        const confirmations = head - number + 1n;
        const status = quantity(receipt.status);
        requireValue(status === 0n || status === 1n, 'CONTROL_RECEIPT_STATUS_REFUSED');
        const canonical = async () => {
            const finalHeader = object(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, false]));
            const chain = quantity(await controlRpc(this.#provider, 'eth_chainId', []));
            requireValue(chain === this.deployment.chainId, 'CONTROL_CHAIN_MISMATCH');
            return typeof finalHeader.hash === 'string' && finalHeader.hash.toLowerCase() === blockHash;
        };
        if (status === 0n)
            return { ...at, state: await canonical() ?
                    (confirmations >= minimumConfirmations ? 'reverted' : 'confirming') : 'reorged', confirmations, executionEventObserved: false };
        requireValue(Array.isArray(receipt.logs), 'CONTROL_RECEIPT_LOGS_REFUSED');
        const topic = keccak256Utf8(EVENTS[record.kind]);
        const events = receipt.logs.map(object).filter(log => typeof log.address === 'string' &&
            log.address.toLowerCase() === this.deployment.controller.toLowerCase() && Array.isArray(log.topics) && log.topics[0] === topic);
        requireValue(events.length === 1, 'CONTROL_EXECUTION_EVENT_MISSING');
        const event = events[0];
        const topics = event.topics;
        const topicCount = record.kind === 'open-sequence' || record.kind === 'forward' || record.kind === 'bind-admission' ? 4 :
            record.kind === 'create-account' || record.kind === 'begin-return' || record.kind === 'return-hop' ? 3 : 2;
        requireValue(topics.length === topicCount && topics.every(t => controlHex(t, 32)) && event.removed !== true &&
            typeof event.transactionHash === 'string' && event.transactionHash.toLowerCase() === record.transactionHash &&
            typeof event.blockHash === 'string' && event.blockHash.toLowerCase() === blockHash, 'CONTROL_EVENT_SHAPE_REFUSED');
        if (record.sequenceId !== null)
            requireValue(topics[1] === record.sequenceId, 'CONTROL_EVENT_SEQUENCE_MISMATCH');
        if (record.legId !== null)
            requireValue(topics[2] === record.legId, 'CONTROL_EVENT_LEG_MISMATCH');
        if (record.expectedRevision !== null) {
            const words = record.kind === 'forward' ? ['address', 'address', 'bytes32', 'uint256'] :
                record.kind === 'bind-admission' ? ['bytes32', 'uint256'] :
                    record.kind === 'complete' ? ['uint256', 'uint64', 'uint256'] :
                        record.kind === 'begin-return' ? ['bytes32', 'bytes32', 'uint256'] :
                            record.kind === 'return-hop' ? ['address', 'address', 'uint256'] : ['uint256'];
            const values = strictDecode(words, event.data);
            requireValue(values.at(-1) === record.expectedRevision + 1n, 'CONTROL_EVENT_REVISION_MISMATCH');
            if (record.kind === 'forward')
                requireValue(values[2] === record.acceptanceHash, 'CONTROL_EVENT_ACCEPTANCE_MISMATCH');
        }
        else if (record.kind === 'create-account') {
            strictDecode([], event.data);
            requireValue(strictDecode(['address'], topics[1])[0] === record.actor, 'CONTROL_EVENT_ACTOR_MISMATCH');
            strictDecode(['address'], topics[2]);
        }
        else if (record.kind === 'open-sequence') {
            strictDecode(['address', 'address'], event.data);
            strictDecode(['address'], topics[2]);
        }
        else if (record.kind === 'invalidate-consent') {
            strictDecode(['uint256'], event.data);
            requireValue(strictDecode(['address'], topics[1])[0] === record.actor, 'CONTROL_EVENT_ACTOR_MISMATCH');
        }
        if (!await canonical())
            return { ...at, state: 'reorged', confirmations: 0n, executionEventObserved: false };
        return { ...at, state: confirmations >= minimumConfirmations ? 'confirmed' : 'confirming', confirmations, executionEventObserved: true };
    }
}
/** Safe recovery journal only. Consumers must still re-read canonical receipts after restart. */
export function serializeControlSubmission(record) {
    return JSON.stringify({ schema: record.schema, deployment: { chainId: record.deployment.chainId.toString(),
            controller: record.deployment.controller, runtimeCodeHash: record.deployment.runtimeCodeHash },
        kind: record.kind, transactionHash: record.transactionHash, actor: record.actor, nonce: record.nonce.toString(), calldataHash: record.calldataHash,
        sequenceId: record.sequenceId, legId: record.legId,
        expectedRevision: record.expectedRevision?.toString() ?? null, acceptanceHash: record.acceptanceHash });
}
/** Strict, bounded recovery input. A journal is not authority: receipt() rechecks the chain. */
export function parseControlSubmission(json) {
    requireValue(typeof json === 'string' && json.length <= 4096, 'CONTROL_JOURNAL_SIZE_REFUSED');
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        throw new Error('CONTROL_JOURNAL_JSON_REFUSED');
    }
    const r = object(parsed);
    const keys = ['schema', 'deployment', 'kind', 'transactionHash', 'actor', 'nonce', 'calldataHash',
        'sequenceId', 'legId', 'expectedRevision', 'acceptanceHash'];
    requireValue(Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k)) &&
        r.schema === '8415-control-submission/1' && typeof r.kind === 'string' && Object.hasOwn(EVENTS, r.kind), 'CONTROL_JOURNAL_SCHEMA_REFUSED');
    const d = object(r.deployment);
    requireValue(Object.keys(d).length === 3 && ['chainId', 'controller', 'runtimeCodeHash'].every(k => Object.hasOwn(d, k)), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
    const decimal = (value) => {
        requireValue(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n, 'CONTROL_JOURNAL_INTEGER_REFUSED');
        return BigInt(value);
    };
    const hex = (value, bytes) => {
        requireValue(controlHex(value, bytes), 'CONTROL_JOURNAL_HEX_REFUSED');
        return value.toLowerCase();
    };
    const deployment = { chainId: decimal(d.chainId), controller: hex(d.controller, 20), runtimeCodeHash: hex(d.runtimeCodeHash, 32) };
    validateControlPin(deployment);
    const kind = r.kind;
    const sequenced = ['forward', 'bind-admission', 'complete', 'begin-return', 'return-hop', 'close-sequence'].includes(kind);
    const legged = ['forward', 'begin-return', 'return-hop'].includes(kind);
    requireValue((r.sequenceId !== null) === sequenced && (r.expectedRevision !== null) === sequenced &&
        (r.legId !== null) === legged && (r.acceptanceHash !== null) === (kind === 'forward'), 'CONTROL_JOURNAL_ACTION_REFUSED');
    return Object.freeze({ schema: '8415-control-submission/1', deployment: Object.freeze(deployment), kind,
        transactionHash: hex(r.transactionHash, 32), actor: hex(r.actor, 20), nonce: decimal(r.nonce), calldataHash: hex(r.calldataHash, 32),
        sequenceId: sequenced ? hex(r.sequenceId, 32) : null, expectedRevision: sequenced ? decimal(r.expectedRevision) : null,
        legId: legged ? hex(r.legId, 32) : null, acceptanceHash: kind === 'forward' ? hex(r.acceptanceHash, 32) : null });
}
