import { Eip1193Signer, type Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { RpcErc8415Reader } from '../adapters/rpc/rpcReader.ts';
import { Eip1193ReadTransport } from '../adapters/signing/eip1193ReadTransport.ts';
import { encodeWords } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { ControlAdapterError, isControlProviderRejection, controlHex, controlRpc, controlPendingNonce, hashControlBytes, requireControlAdapter as check,
  validateControlPin, verifyControlDeployment, type ControlDeploymentPin } from '../controls/authorization.ts';
import { actorSelected, proveSupersededNonce, rpcObject, rpcQuantity, wordAddress, wordUint } from '../controls/execution.ts';
import { sameDeployment } from '../controls/operationJournal.ts';
import { detectConformance } from '../sdk/conformance.ts';
import { type TransactionIntent, type TransactionRequest } from '../sdk/transactions.ts';
import { isAddressInput } from '../xiongan/address.ts';
import { WalletSession } from './session.ts';

const ZERO_HASH = `0x${'0'.repeat(64)}`;
const SIGNATURES = {
  beginSettlement: 'SettlementStarted(bytes32,uint256,address,address,bytes32,uint64)',
  finalizeSettlement: 'SettlementFinalized(bytes32,uint256,bytes32,uint64,uint64)',
  cancelSettlement: 'SettlementCancelled(bytes32,uint256,bytes32)',
} as const;
const json = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
const exact = (value: unknown, keys: readonly string[]) => {
  const r = rpcObject(value);
  check(Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k)), 'SETTLEMENT_JOURNAL_REFUSED'); return r;
};
const hash = (value: unknown) => { check(controlHex(value, 32), 'SETTLEMENT_HASH_REFUSED'); return value.toLowerCase(); };
const address = (value: unknown) => { check(controlHex(value, 20) && !/^0x0+$/i.test(value), 'SETTLEMENT_ADDRESS_REFUSED'); return value.toLowerCase(); };
const uint = (value: unknown, bits = 256n) => {
  check(typeof value === 'bigint' && value >= 0n && value < 1n << bits, 'SETTLEMENT_INTEGER_REFUSED'); return value;
};
const decimal = (value: unknown) => {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'SETTLEMENT_INTEGER_REFUSED'); return uint(BigInt(value));
};
export type SettlementSubmission = {
  readonly kind: TransactionIntent['kind']; readonly nonce: bigint; readonly calldataHash: string;
  readonly transactionHash: string | null; readonly indexed: readonly string[]; readonly dataHash: string | null;
  readonly effectiveAt: bigint | null;
};
export type SettlementState = {
  readonly schema: '8415-settlement-operation/1'; readonly revision: bigint; readonly deployment: ControlDeploymentPin;
  readonly actor: string; readonly status: 'idle' | 'outcome-unknown' | 'submitted';
  readonly requestDigest: string | null; readonly submission: SettlementSubmission | null;
};
export interface SettlementStore {
  read(): Promise<SettlementState | null>;
  compareAndSwap(expected: bigint | null, next: SettlementState): Promise<boolean>;
}
export function serializeSettlementState(state: SettlementState): string {
  return json({ schema: state.schema, revision: state.revision, deployment: { chainId: state.deployment.chainId,
    controller: state.deployment.controller, runtimeCodeHash: state.deployment.runtimeCodeHash }, actor: state.actor,
  status: state.status, requestDigest: state.requestDigest, submission: state.submission === null ? null : {
    kind: state.submission.kind, nonce: state.submission.nonce, calldataHash: state.submission.calldataHash,
    transactionHash: state.submission.transactionHash, indexed: [...state.submission.indexed],
    dataHash: state.submission.dataHash, effectiveAt: state.submission.effectiveAt } });
}
/** Public hashes and receipt bindings only. Proof bytes and signatures never enter storage. */
export function parseSettlementState(text: string): SettlementState {
  check(typeof text === 'string' && text.length <= 8192, 'SETTLEMENT_JOURNAL_REFUSED');
  let input: unknown; try { input = JSON.parse(text); } catch { throw new ControlAdapterError('SETTLEMENT_JOURNAL_REFUSED'); }
  const r = exact(input, ['schema', 'revision', 'deployment', 'actor', 'status', 'requestDigest', 'submission']);
  const d = exact(r.deployment, ['chainId', 'controller', 'runtimeCodeHash']);
  const deployment = { chainId: decimal(d.chainId), controller: address(d.controller), runtimeCodeHash: hash(d.runtimeCodeHash) };
  validateControlPin(deployment);
  check(r.schema === '8415-settlement-operation/1' && ['idle', 'outcome-unknown', 'submitted'].includes(r.status as string), 'SETTLEMENT_JOURNAL_REFUSED');
  let submission: SettlementSubmission | null = null;
  if (r.submission !== null) {
    const s = exact(r.submission, ['kind', 'nonce', 'calldataHash', 'transactionHash', 'indexed', 'dataHash', 'effectiveAt']);
    check(typeof s.kind === 'string' && Object.hasOwn(SIGNATURES, s.kind) && Array.isArray(s.indexed) && s.indexed.length === 3, 'SETTLEMENT_JOURNAL_REFUSED');
    const kind = s.kind as TransactionIntent['kind'];
    const dataHash = s.dataHash === null ? null : hash(s.dataHash);
    const effectiveAt = s.effectiveAt === null ? null : uint(decimal(s.effectiveAt), 64n);
    check(kind === 'finalizeSettlement' ? dataHash === null && effectiveAt !== null : dataHash !== null && effectiveAt === null, 'SETTLEMENT_JOURNAL_REFUSED');
    submission = { kind, nonce: decimal(s.nonce), calldataHash: hash(s.calldataHash), transactionHash: s.transactionHash === null ? null : hash(s.transactionHash),
      indexed: s.indexed.map(hash), dataHash, effectiveAt };
    check(submission.transactionHash !== ZERO_HASH, 'SETTLEMENT_HASH_REFUSED');
  }
  check(r.status === 'idle' ? r.requestDigest === null && submission === null : controlHex(r.requestDigest, 32) && submission !== null &&
    (r.status === 'submitted' ? submission.transactionHash !== null : submission.transactionHash === null), 'SETTLEMENT_JOURNAL_REFUSED');
  return { schema: '8415-settlement-operation/1', revision: decimal(r.revision), deployment, actor: address(r.actor),
    status: r.status as SettlementState['status'], requestDigest: r.requestDigest as string | null, submission };
}
export type SettlementReview = {
  readonly digest: string; readonly kind: TransactionIntent['kind']; readonly chainId: bigint; readonly token: string;
  readonly actor: string; readonly nonce: bigint; readonly parameters: Readonly<Record<string, unknown>>; readonly summary: string; readonly preflight: TransactionRequest['preflight'];
  readonly identity: { readonly registerId: string; readonly verificationProfile: string | undefined };
};
export type SettlementReceipt = { readonly state: 'pending' | 'confirming' | 'confirmed' | 'reverted' | 'reorged';
  readonly transactionHash: string; readonly confirmations: bigint; readonly executionEventObserved: boolean;
  readonly protocolFinality: 'not-evaluated' };

/** Independent of responsibility controls, payment adapters and tenant integrations. */
export class StandaloneSettlementSession {
  readonly #provider: Eip1193Provider; readonly #pin: ControlDeploymentPin; readonly #actor: string;
  readonly #store: SettlementStore; readonly #wallet: WalletSession; readonly #guard: () => void;
  readonly #reviews = new WeakMap<SettlementReview, TransactionRequest>();
  #busy = false;
  constructor(provider: Eip1193Provider, pin: ControlDeploymentPin, actor: string, store: SettlementStore,
    guard: () => void = () => {}, wallet?: WalletSession) {
    validateControlPin(pin); this.#pin = structuredClone(pin); this.#actor = address(actor);
    this.#provider = provider; this.#store = store; this.#guard = guard;
    this.#wallet = wallet ?? new WalletSession(new RpcErc8415Reader(new Eip1193ReadTransport(provider, pin.chainId),
      pin.chainId, pin.controller), { account: this.#actor });
    check(this.#wallet.reader.source.chainId === pin.chainId && this.#wallet.reader.source.address.toLowerCase() === pin.controller.toLowerCase(), 'SETTLEMENT_SOURCE_MISMATCH');
  }
  async #identity() {
    this.#guard(); await verifyControlDeployment(this.#provider, this.#pin);
    await actorSelected(this.#provider, this.#actor); this.#guard();
  }
  async status(): Promise<SettlementState> {
    let state = await this.#store.read();
    if (state === null) {
      state = { schema: '8415-settlement-operation/1', revision: 0n, deployment: this.#pin, actor: this.#actor,
        status: 'idle', requestDigest: null, submission: null };
      check(await this.#store.compareAndSwap(null, state), 'SETTLEMENT_OPERATION_CONCURRENT');
    }
    state = parseSettlementState(serializeSettlementState(state));
    check(sameDeployment(state.deployment, this.#pin) && state.actor === this.#actor, 'SETTLEMENT_JOURNAL_BINDING_REFUSED'); return state;
  }
  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    check(!this.#busy, 'SETTLEMENT_OPERATION_BUSY'); this.#busy = true;
    try { return await fn(); } finally { this.#busy = false; }
  }
  async prepare(input: TransactionIntent): Promise<SettlementReview> {
    let intent = structuredClone(input); const params = intent.params;
    hash(params.settlementId);
    if (intent.kind === 'beginSettlement') {
      uint(intent.params.tokenId); uint(intent.params.deadline, 64n); hash(intent.params.snapshotHash);
      check(isAddressInput(intent.params.expectedHolder), 'SETTLEMENT_ADDRESS_REFUSED');
      intent = { ...intent, params: { ...intent.params, expectedHolder: intent.params.expectedHolder.toLowerCase() } };
    } else if (intent.kind === 'finalizeSettlement') {
      hash(intent.params.recordCommitment); hash(intent.params.registryReference); uint(intent.params.effectiveAt, 64n);
      check(controlHex(intent.params.proofData) && intent.params.proofData.length <= 131074, 'SETTLEMENT_PROOF_REFUSED');
    } else if (intent.kind === 'cancelSettlement') hash(intent.params.reasonHash);
    else throw new ControlAdapterError('SETTLEMENT_ACTION_REFUSED');
    await this.#identity();
    check((await this.status()).status === 'idle', 'SETTLEMENT_RECONCILIATION_REQUIRED');
    const identity = await this.#wallet.identity.read(await detectConformance(this.#wallet.reader));
    let request: TransactionRequest;
    switch (intent.kind) {
      case 'beginSettlement': request = await this.#wallet.transactions.beginSettlement(intent.params); break;
      case 'finalizeSettlement': request = await this.#wallet.transactions.finalizeSettlement(intent.params); break;
      case 'cancelSettlement': request = await this.#wallet.transactions.cancelSettlement(intent.params); break;
    }
    const nonce = controlPendingNonce(await controlRpc(this.#provider, 'eth_getTransactionCount', [this.#actor, 'pending']));
    check(controlHex(await controlRpc(this.#provider, 'eth_call', [{ from: request.from, to: request.to, data: request.data,
      value: '0x0', chainId: `0x${request.chainId.toString(16)}` }, 'latest'])), 'SETTLEMENT_SIMULATION_REFUSED');
    await this.#identity();
    const digest = keccak256Utf8(json({ intent: request.intent, to: request.to, from: request.from, data: request.data, chainId: request.chainId,
      nonce, identity, checks: request.preflight.checks.map(c => [c.name, c.outcome]), consequences: request.preflight.consequences }));
    const review: SettlementReview = Object.freeze({ digest, kind: intent.kind, chainId: request.chainId, token: request.to, actor: request.from,
      nonce, parameters: Object.freeze(intent.kind === 'finalizeSettlement' ? { settlementId: intent.params.settlementId,
        recordCommitment: intent.params.recordCommitment, registryReference: intent.params.registryReference, effectiveAt: intent.params.effectiveAt,
        proofHash: hashControlBytes(intent.params.proofData), proofBytes: (intent.params.proofData.length - 2) / 2 } : { ...intent.params }), summary: request.summary, preflight: structuredClone(request.preflight), identity: {
        registerId: identity.registerId, verificationProfile: identity.verificationProfile } });
    this.#reviews.set(review, request); return review;
  }
  async #template(request: TransactionRequest, nonce: bigint): Promise<SettlementSubmission> {
    const i = request.intent; let tokenId: bigint, indexed: string[], dataHash: string | null, effectiveAt: bigint | null = null;
    if (i.kind === 'beginSettlement') {
      tokenId = i.params.tokenId; indexed = [i.params.settlementId, wordUint(tokenId), wordAddress(this.#actor)];
      dataHash = hashControlBytes(encodeWords(['address', 'bytes32', 'uint64'], [i.params.expectedHolder, i.params.snapshotHash, i.params.deadline]));
    } else {
      const settlement = await this.#wallet.reader.settlement!(i.params.settlementId); tokenId = settlement.tokenId;
      indexed = [i.params.settlementId, wordUint(tokenId), i.kind === 'finalizeSettlement' ? i.params.recordCommitment : i.params.reasonHash];
      dataHash = i.kind === 'cancelSettlement' ? hashControlBytes('0x') : null;
      if (i.kind === 'finalizeSettlement') effectiveAt = i.params.effectiveAt;
    }
    return { kind: i.kind, nonce, calldataHash: hashControlBytes(request.data), transactionHash: null,
      indexed: indexed.map(v => v.toLowerCase()), dataHash, effectiveAt };
  }
  /** Only an explicit reviewed action calls the signer. Every ambiguous send remains locked across reloads. */
  async submit(review: SettlementReview, acknowledgedDigest: string): Promise<string> {
    return this.#exclusive(async () => {
      const original = this.#reviews.get(review); this.#reviews.delete(review);
      check(original !== undefined && acknowledgedDigest === review.digest, 'SETTLEMENT_REVIEW_REQUIRED');
      const current = await this.status(); check(current.status === 'idle', 'SETTLEMENT_RECONCILIATION_REQUIRED');
      const fresh = await this.prepare(original.intent), request = this.#reviews.get(fresh)!; this.#reviews.delete(fresh);
      check(fresh.digest === review.digest, 'SETTLEMENT_REVIEW_CHANGED');
      const submission = await this.#template(request, fresh.nonce);
      const reserved: SettlementState = { ...current, revision: current.revision + 1n, status: 'outcome-unknown', requestDigest: fresh.digest, submission };
      check(await this.#store.compareAndSwap(current.revision, reserved), 'SETTLEMENT_OPERATION_CONCURRENT');
      let invoked = false;
      try {
        await this.#identity();
        const guarded: Eip1193Provider = { request: args => {
          this.#guard();
          if (args.method !== 'eth_sendTransaction') return controlRpc(this.#provider, args.method, args.params ?? []);
          const wire = rpcObject(args.params?.[0]);
          check(wire.from === request.from && wire.to === request.to && wire.data === request.data && wire.value === '0x0' &&
            wire.chainId === `0x${request.chainId.toString(16)}`, 'SETTLEMENT_SIGNER_INTENT_REFUSED');
          return controlRpc({ request: send => { this.#guard(); invoked = true; return this.#provider.request(send); } }, args.method,
            [{ ...wire, nonce: `0x${fresh.nonce.toString(16)}` }]);
        } };
        const transactionHash = hash(await this.#wallet.send(request, new Eip1193Signer(guarded, this.#actor)));
        check(transactionHash !== ZERO_HASH, 'SETTLEMENT_HASH_REFUSED');
        check(await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1n,
          status: 'submitted', submission: { ...submission, transactionHash } }), 'SETTLEMENT_PERSISTENCE_UNCERTAIN');
        return transactionHash;
      } catch (error) {
        if (!invoked || isControlProviderRejection(error, 'eth_sendTransaction')) {
          check(await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1n,
            status: 'idle', requestDigest: null, submission: null }), 'SETTLEMENT_PERSISTENCE_UNCERTAIN');
        }
        throw error;
      }
    });
  }
  async #receipt(state: SettlementState, transactionHash: string, minimumConfirmations: bigint): Promise<SettlementReceipt> {
    check(minimumConfirmations >= 1n && minimumConfirmations <= 1024n, 'SETTLEMENT_CONFIRMATIONS_REFUSED');
    await this.#identity(); const s = state.submission!;
    const output = (status: SettlementReceipt['state'], confirmations = 0n, event = false): SettlementReceipt => ({ state: status,
      transactionHash, confirmations, executionEventObserved: event, protocolFinality: 'not-evaluated' });
    const raw = await controlRpc(this.#provider, 'eth_getTransactionReceipt', [transactionHash]); if (raw === null) return output('pending');
    const r = rpcObject(raw), tx = rpcObject(await controlRpc(this.#provider, 'eth_getTransactionByHash', [transactionHash]));
    const blockHash = hash(r.blockHash), number = rpcQuantity(r.blockNumber), index = rpcQuantity(r.transactionIndex);
    check(hash(r.transactionHash) === transactionHash && hash(tx.hash) === transactionHash && hash(tx.blockHash) === blockHash &&
      rpcQuantity(tx.blockNumber) === number && rpcQuantity(tx.transactionIndex) === index && address(r.from) === this.#actor &&
      address(r.to) === this.#pin.controller.toLowerCase() && address(tx.from) === this.#actor && address(tx.to) === this.#pin.controller.toLowerCase() &&
      rpcQuantity(tx.chainId) === this.#pin.chainId && rpcQuantity(tx.nonce) === s.nonce && rpcQuantity(tx.value) === 0n &&
      controlHex(tx.input) && hashControlBytes(tx.input) === s.calldataHash, 'SETTLEMENT_RECEIPT_BINDING_REFUSED');
    const canonical = async () => {
      this.#guard(); const block = await controlRpc(this.#provider, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
      return block !== null && hash(rpcObject(block).hash) === blockHash;
    };
    if (!await canonical()) return output('reorged');
    const code = await controlRpc(this.#provider, 'eth_getCode', [this.#pin.controller, { blockHash, requireCanonical: true }]);
    check(controlHex(code) && hashControlBytes(code) === this.#pin.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
    const head = rpcQuantity(await controlRpc(this.#provider, 'eth_blockNumber', [])); if (head < number) return output('reorged');
    const depth = head - number + 1n, status = rpcQuantity(r.status); check(status === 0n || status === 1n, 'SETTLEMENT_RECEIPT_STATUS_REFUSED');
    let event = false;
    if (status === 1n) {
      check(Array.isArray(r.logs), 'SETTLEMENT_EVENT_REQUIRED');
      const matches = r.logs.filter((rawLog: unknown) => {
        const log = rpcObject(rawLog);
        if (typeof log.address !== 'string' || log.address.toLowerCase() !== this.#pin.controller.toLowerCase() || !Array.isArray(log.topics) ||
          log.topics[0] !== keccak256Utf8(SIGNATURES[s.kind])) return false;
        const topics = log.topics as unknown[];
        check(log.removed === false && hash(log.blockHash) === blockHash && hash(log.transactionHash) === transactionHash &&
          rpcQuantity(log.blockNumber) === number && rpcQuantity(log.transactionIndex) === index && log.topics.length === 4 &&
          s.indexed.every((v, i) => hash(topics[i + 1]) === v) && controlHex(log.data), 'SETTLEMENT_EVENT_BINDING_REFUSED');
        if (s.dataHash !== null) check(hashControlBytes(log.data) === s.dataHash, 'SETTLEMENT_EVENT_BINDING_REFUSED');
        else check(log.data.length === 130 && BigInt(`0x${log.data.slice(2, 66)}`) > 0n &&
          BigInt(`0x${log.data.slice(2, 66)}`) < 1n << 64n && BigInt(`0x${log.data.slice(66)}`) === s.effectiveAt, 'SETTLEMENT_EVENT_BINDING_REFUSED');
        return true;
      });
      check(matches.length === 1, 'SETTLEMENT_EVENT_REQUIRED'); event = true;
    }
    await this.#identity(); if (!await canonical()) return output('reorged');
    return output(depth < minimumConfirmations ? 'confirming' : status === 0n ? 'reverted' : 'confirmed', depth, event);
  }
  async reconcile(minimumConfirmations = 2n): Promise<SettlementReceipt> {
    const state = await this.status(); check(state.status === 'submitted' && state.submission?.transactionHash !== null && state.submission !== null, 'SETTLEMENT_KNOWN_HASH_REQUIRED');
    return this.#receipt(state, state.submission.transactionHash!, minimumConfirmations);
  }
  async recover(transactionHash: string, minimumConfirmations = 2n): Promise<SettlementReceipt> {
    return this.#exclusive(async () => {
      const state = await this.status(); check(state.status !== 'idle' && state.submission !== null, 'SETTLEMENT_SAVED_INTENT_REQUIRED');
      const h = hash(transactionHash); check(h !== ZERO_HASH, 'SETTLEMENT_HASH_REFUSED');
      const receipt = await this.#receipt(state, h, minimumConfirmations);
      check(['confirming', 'confirmed', 'reverted'].includes(receipt.state), 'SETTLEMENT_RECOVERY_BINDING_UNOBSERVED');
      check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1n, status: 'submitted',
        submission: { ...state.submission, transactionHash: h } }), 'SETTLEMENT_OPERATION_CONCURRENT'); return receipt;
    });
  }
  async acknowledge(minimumConfirmations = 2n): Promise<void> {
    return this.#exclusive(async () => {
      const state = await this.status(); check(state.status === 'submitted' && state.submission?.transactionHash !== null && state.submission !== null, 'SETTLEMENT_KNOWN_HASH_REQUIRED');
      const receipt = await this.#receipt(state, state.submission.transactionHash!, minimumConfirmations);
      check(['confirmed', 'reverted'].includes(receipt.state), 'SETTLEMENT_TERMINAL_RECEIPT_REQUIRED');
      check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1n, status: 'idle', requestDigest: null, submission: null }), 'SETTLEMENT_OPERATION_CONCURRENT');
    });
  }
  async acknowledgeReplacement(transactionHash: string, minimumConfirmations = 2n) {
    return this.#exclusive(async () => {
      const state = await this.status(); check(state.status !== 'idle' && state.submission !== null, 'SETTLEMENT_SAVED_INTENT_REQUIRED');
      await this.#identity();
      const proof = await proveSupersededNonce(this.#provider, { pin: this.#pin, actor: this.#actor, nonce: state.submission.nonce,
        value: 0n, calldataHash: state.submission.calldataHash, transactionHash: state.submission.transactionHash ?? ZERO_HASH }, transactionHash, minimumConfirmations);
      this.#guard(); check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1n,
        status: 'idle', requestDigest: null, submission: null }), 'SETTLEMENT_OPERATION_CONCURRENT'); return proof;
    });
  }
}
