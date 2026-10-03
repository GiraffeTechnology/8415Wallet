import { encodeWords } from "../codec/abi.js";
import { keccak256Utf8 } from "../codec/keccak.js";
import { ResponsibilityControlClient } from "./client.js";
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as check, verifyControlDeployment } from "./authorization.js";
import { rpcObject } from "./execution.js";
const ZERO = `0x${'0'.repeat(64)}`;
const SEED = keccak256Utf8('8415Wallet/DetachedResponsibilities/v1');
const RECORD_KEYS = ['occurrence', 'legId', 'fromAccount', 'toAccount', 'termsHash',
    'acceptanceHash', 'returnAuthority', 'returnConditionHash', 'detachedCommitment'];
const DOCUMENT_KEYS = ['schema', 'chainId', 'controller', 'sequenceId', 'records'];
const exact = (value, keys) => {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'CONTROL_ARCHIVE_SCHEMA_REFUSED');
    const r = value;
    check(Object.keys(r).sort().join(',') === [...keys].sort().join(','), 'CONTROL_ARCHIVE_SCHEMA_REFUSED');
    return r;
};
const decimal = (v) => {
    check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v), 'CONTROL_ARCHIVE_INTEGER_REFUSED');
    const n = BigInt(v);
    check(n < 1n << 256n, 'CONTROL_ARCHIVE_INTEGER_REFUSED');
    return n;
};
const hex = (v, size) => {
    check(controlHex(v, size), 'CONTROL_ARCHIVE_FIELD_REFUSED');
    return v.toLowerCase();
};
/** Verifies public register copies of LegDetached records, never resolves a
 * registryReference or trusts a register's complete/verified flag. No signing.
 * A full prefix from occurrence zero is required: a suffix has no trusted anchor.
 */
export class DetachedResponsibilityHistoryClient {
    #provider;
    #client;
    constructor(provider, pin) {
        this.#provider = provider;
        this.#client = new ResponsibilityControlClient(provider, pin);
    }
    async observe(sequenceId, document) {
        const d = exact(document, DOCUMENT_KEYS), pin = this.#client.deployment;
        check(controlHex(sequenceId, 32) && d.schema === '8415-detached-history/1' &&
            decimal(d.chainId) === pin.chainId && hex(d.controller, 20) === pin.controller.toLowerCase() &&
            hex(d.sequenceId, 32) === sequenceId.toLowerCase(), 'CONTROL_ARCHIVE_BINDING_REFUSED');
        const input = d.records;
        check(Array.isArray(input), 'CONTROL_ARCHIVE_SCHEMA_REFUSED');
        // Copy and validate before yielding: a caller cannot change the document while
        // chain reads are in flight. No untrusted extra property reaches the result.
        // Never dispatch caller-owned map/iterator/species hooks. Require actual
        // indexed records, not sparse holes or inherited array entries.
        const copied = [], count = input.length;
        for (let i = 0; i < count; i++) {
            check(Object.prototype.hasOwnProperty.call(input, i), 'CONTROL_ARCHIVE_SCHEMA_REFUSED');
            const r = exact(input[i], RECORD_KEYS);
            copied.push(Object.freeze({ occurrence: decimal(r.occurrence), legId: hex(r.legId, 32),
                fromAccount: hex(r.fromAccount, 20), toAccount: hex(r.toAccount, 20), termsHash: hex(r.termsHash, 32),
                acceptanceHash: hex(r.acceptanceHash, 32), returnAuthority: hex(r.returnAuthority, 20),
                returnConditionHash: hex(r.returnConditionHash, 32), detachedCommitment: hex(r.detachedCommitment, 32) }));
        }
        const records = Object.freeze(copied);
        const snapshot = await this.#client.snapshot(sequenceId);
        const s = snapshot.sequence;
        check(BigInt(records.length) === s.completedCount, 'CONTROL_ARCHIVE_COUNT_REFUSED');
        let commitment = hashControlBytes(encodeWords(['bytes32', 'bytes32'], [SEED, sequenceId]));
        let predecessor = s.initialAccount;
        for (const [i, r] of records.entries()) {
            check(r.occurrence === BigInt(i) && r.fromAccount === predecessor, 'CONTROL_ARCHIVE_ORDER_REFUSED');
            commitment = hashControlBytes(encodeWords(['bytes32', 'uint256', 'bytes32', 'address', 'address', 'bytes32', 'bytes32', 'address', 'bytes32'], [commitment, r.occurrence, r.legId, r.fromAccount, r.toAccount, r.termsHash,
                r.acceptanceHash, r.returnAuthority, r.returnConditionHash]));
            check(commitment === r.detachedCommitment, 'CONTROL_ARCHIVE_COMMITMENT_REFUSED');
            predecessor = r.toAccount;
        }
        check((records.length === 0 ? ZERO : commitment) === s.detachedCommitment, 'CONTROL_ARCHIVE_COMMITMENT_REFUSED');
        // The verified prefix must meet the active window, not an invented initial account.
        check(predecessor === (snapshot.legs[0]?.fromAccount ?? s.currentAccount), 'CONTROL_ARCHIVE_BOUNDARY_REFUSED');
        await verifyControlDeployment(this.#provider, pin);
        const end = rpcObject(await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${snapshot.blockNumber.toString(16)}`, false]));
        check(typeof end.hash === 'string' && end.hash.toLowerCase() === snapshot.blockHash, 'CONTROL_SNAPSHOT_REORGED');
        return Object.freeze({ kind: 'verified-detached-history', readOnly: true, protocolFinality: 'not-evaluated',
            chainId: pin.chainId, controller: pin.controller.toLowerCase(), sequenceId: sequenceId.toLowerCase(),
            token: s.token, tokenId: s.tokenId, revision: s.revision, blockNumber: snapshot.blockNumber,
            blockHash: snapshot.blockHash, detachedCount: s.completedCount, detachedCommitment: s.detachedCommitment, records });
    }
}
