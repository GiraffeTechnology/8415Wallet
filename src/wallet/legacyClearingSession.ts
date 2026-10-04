import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { RpcEscrowReader } from '../adapters/rpc/escrowRpcReader.ts';
import type { CallTransport } from '../adapters/rpc/transport.ts';
import { encodeCall, encodeWords, decodeResult, type StaticType, type AbiValue } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { controlHex, controlRpc, controlPendingNonce, hashControlBytes, requireControlAdapter as check, isControlProviderRejection } from '../controls/authorization.ts';
import { isAddressInput } from '../xiongan/address.ts';
import type { Address, Bytes32 } from '../sdk/types.ts';
import { buildEscrowView } from './escrowView.ts';

/** Fixed, owner-reviewed legacy ProjectionEscrow actions. This is independent of
 * responsibility controls; it neither admits entries nor chooses trade remedies. */
export type LegacyClearingDeployment = { schema: '8415-legacy-clearing/1'; chainId: string;
  escrow: { address: string; runtimeCodeHash: string }; projection: { address: string; runtimeCodeHash: string };
  registerId: string; verificationProfile: string | null };
type Action = 'approve' | 'open' | 'fund' | 'release' | 'refund' | 'abandon';
type Request = { kind: Action; tradeKey?: string; localId?: string; tokenId?: string; buyer?: string;
  priceWei?: string; admissionDeadline?: string; maxEffectiveAt?: string };
type Transaction = { from: string; to: string; chainId: string; value: string; data: string; nonce: string };
export type LegacyClearingReview = { requestText: string; action: Action; tradeKey: string; expiresAt: string;
  deployment: LegacyClearingDeployment; transaction: Transaction; facts: string; digest: string };
export type LegacyClearingState = { schema: '8415-legacy-operation/1'; revision: number; chainId: string; actor: string;
  status: 'idle' | 'outcome-unknown' | 'submitted'; review: LegacyClearingReview | null; transactionHash: string | null };
export type LegacyClearingStore = { read(): Promise<LegacyClearingState | null>;
  compareAndSwap(expected: number | null, next: LegacyClearingState): Promise<boolean> };
type Receipt = { state: 'pending' | 'reorged' | 'confirming' | 'confirmed' | 'reverted'; transactionHash: string; confirmations: string };
const ZERO = `0x${'0'.repeat(64)}`, ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const TRADE_TYPES: StaticType[] = ['address', 'uint256', 'address', 'address', 'uint256', 'uint64', 'uint64', 'uint64', 'uint8'];
const OBSERVE_TYPES: StaticType[] = ['uint8', 'bool', 'uint64', 'uint64', 'address', 'address', 'uint64'];
const json = (v: unknown) => JSON.stringify(v, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
function object(v: unknown, keys?: readonly string[]): Record<string, unknown> {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'CLEARING_SCHEMA_REFUSED');
  if (keys) check(Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'CLEARING_SCHEMA_REFUSED');
  return v as Record<string, unknown>;
}
function uint(v: unknown, bits = 256): bigint {
  check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << BigInt(bits), 'CLEARING_INTEGER_REFUSED');
  return BigInt(v);
}
function address(v: unknown): string { check(isAddressInput(v) && !/^0x0+$/i.test(v), 'CLEARING_ADDRESS_REFUSED'); return v.toLowerCase(); }
function rpcAddress(v: unknown): string { check(controlHex(v, 20) && !/^0x0+$/i.test(v), 'CLEARING_RPC_ADDRESS_REFUSED'); return v.toLowerCase(); }
function hash(v: unknown): string { check(controlHex(v, 32) && v !== ZERO, 'CLEARING_HASH_REFUSED'); return v.toLowerCase(); }
function quantity(v: unknown): bigint { check(typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) && v.length <= 66, 'CLEARING_RPC_QUANTITY_REFUSED'); return BigInt(v); }
const hex = (v: bigint) => `0x${v.toString(16)}`;
function decoded(types: readonly StaticType[], v: unknown): AbiValue[] {
  check(controlHex(v) && v.length === 2 + types.length * 64, 'CLEARING_RPC_ABI_REFUSED');
  const out = decodeResult(types, v);
  check(encodeWords(types, out) === v.toLowerCase(), 'CLEARING_RPC_ABI_REFUSED');
  return out;
}
export function parseLegacyClearingDeployment(raw: unknown): LegacyClearingDeployment {
  const d = object(raw, ['schema', 'chainId', 'escrow', 'projection', 'registerId', 'verificationProfile']);
  check(d.schema === '8415-legacy-clearing/1', 'CLEARING_DEPLOYMENT_SCHEMA_REFUSED');
  const chainId = uint(d.chainId).toString();
  check(['11155111', '560048', '31337'].includes(chainId), 'CLEARING_TESTNET_REQUIRED');
  const pin = (v: unknown) => { const p = object(v, ['address', 'runtimeCodeHash']); return { address: address(p.address), runtimeCodeHash: hash(p.runtimeCodeHash) }; };
  const escrow = pin(d.escrow), projection = pin(d.projection);
  check(escrow.address !== projection.address, 'CLEARING_DEPLOYMENT_PIN_REFUSED');
  return { schema: '8415-legacy-clearing/1', chainId, escrow, projection, registerId: hash(d.registerId),
    verificationProfile: d.verificationProfile === null ? null : hash(d.verificationProfile) };
}
function request(text: string): Request {
  check(typeof text === 'string' && text.length > 0 && text.length <= 4096, 'CLEARING_REQUEST_REFUSED');
  let raw: unknown; try { raw = JSON.parse(text); } catch { check(false, 'CLEARING_REQUEST_REFUSED'); }
  const r = object(raw);
  if (r.kind === 'open' || r.kind === 'approve') {
    object(r, ['kind', 'localId', 'tokenId', 'buyer', 'priceWei', 'admissionDeadline', 'maxEffectiveAt']);
    const localId = hash(r.localId), tokenId = uint(r.tokenId).toString(), buyer = address(r.buyer), priceWei = uint(r.priceWei).toString();
    const admissionDeadline = uint(r.admissionDeadline, 64).toString(), maxEffectiveAt = uint(r.maxEffectiveAt, 64).toString();
    check(maxEffectiveAt !== '0', 'CLEARING_TERMS_REFUSED');
    return { kind: r.kind, localId, tokenId, buyer, priceWei, admissionDeadline, maxEffectiveAt };
  }
  object(r, ['kind', 'tradeKey']);
  check(['fund', 'release', 'refund', 'abandon'].includes(r.kind as string), 'CLEARING_ACTION_REFUSED');
  return { kind: r.kind as Action, tradeKey: hash(r.tradeKey) };
}
function reviewDigest(r: Omit<LegacyClearingReview, 'digest'>): string { return keccak256Utf8(json(r)); }
export function parseLegacyClearingState(text: string): LegacyClearingState {
  check(typeof text === 'string' && text.length <= 32768, 'CLEARING_JOURNAL_REFUSED');
  let raw: unknown; try { raw = JSON.parse(text); } catch { check(false, 'CLEARING_JOURNAL_REFUSED'); }
  const s = object(raw, ['schema', 'revision', 'chainId', 'actor', 'status', 'review', 'transactionHash']);
  check(s.schema === '8415-legacy-operation/1' && Number.isSafeInteger(s.revision) && (s.revision as number) >= 0, 'CLEARING_JOURNAL_REFUSED');
  const chainId = uint(s.chainId).toString(), actor = address(s.actor);
  check(['idle', 'outcome-unknown', 'submitted'].includes(s.status as string), 'CLEARING_JOURNAL_REFUSED');
  let review: LegacyClearingReview | null = null;
  if (s.review !== null) {
    const r = object(s.review, ['requestText', 'action', 'tradeKey', 'expiresAt', 'deployment', 'transaction', 'facts', 'digest']);
    const req = request(r.requestText as string), deployment = parseLegacyClearingDeployment(r.deployment);
    const t = object(r.transaction, ['from', 'to', 'chainId', 'value', 'data', 'nonce']);
    const transaction = { from: address(t.from), to: address(t.to), chainId: hex(quantity(t.chainId)), value: hex(quantity(t.value)),
      data: t.data as string, nonce: hex(quantity(t.nonce)) };
    check(controlHex(t.data) && t.data.length <= 458 && actor === transaction.from && chainId === deployment.chainId &&
      BigInt(chainId) === quantity(transaction.chainId), 'CLEARING_JOURNAL_BINDING_REFUSED');
    check(typeof r.facts === 'string' && r.facts.length <= 16384 && req.kind === r.action, 'CLEARING_JOURNAL_REFUSED');
    review = { requestText: r.requestText as string, action: req.kind, tradeKey: hash(r.tradeKey), expiresAt: uint(r.expiresAt, 64).toString(),
      deployment, transaction, facts: r.facts, digest: hash(r.digest) };
    const { digest, ...unsigned } = review;
    check(reviewDigest(unsigned) === digest, 'CLEARING_JOURNAL_DIGEST_REFUSED');
    check(transaction.to === (req.kind === 'approve' ? deployment.projection.address : deployment.escrow.address), 'CLEARING_JOURNAL_BINDING_REFUSED');
    check(req.kind === 'open' || req.kind === 'approve' ? review.tradeKey === legacyTradeKey(actor, req.localId!) : review.tradeKey === req.tradeKey,
      'CLEARING_JOURNAL_BINDING_REFUSED');
    const expected = encodeRequest(req, deployment, review.tradeKey);
    check(transaction.data === expected.data && (req.kind === 'fund' || transaction.value === '0x0'), 'CLEARING_JOURNAL_CALLDATA_REFUSED');
  }
  const transactionHash = s.transactionHash === null ? null : hash(s.transactionHash);
  check(s.status === 'idle' ? review === null && transactionHash === null : review !== null &&
    (s.status === 'submitted' ? transactionHash !== null : transactionHash === null), 'CLEARING_JOURNAL_REFUSED');
  return { schema: '8415-legacy-operation/1', revision: s.revision as number, chainId, actor, status: s.status as LegacyClearingState['status'], review, transactionHash };
}
export function legacyTradeKey(opener: string, localId: string): string {
  return hashControlBytes(encodeWords(['address', 'bytes32'], [address(opener), hash(localId)]));
}
function encodeRequest(r: Request, d: LegacyClearingDeployment, key: string): { data: string } {
  if (r.kind === 'approve') return { data: encodeCall('approve(address,uint256)', ['address', 'uint256'], [d.escrow.address, BigInt(r.tokenId!)]) };
  if (r.kind === 'open') return { data: encodeCall('open(bytes32,address,uint256,address,uint256,uint64,uint64)',
    ['bytes32', 'address', 'uint256', 'address', 'uint256', 'uint64', 'uint64'],
    [r.localId!, d.projection.address, BigInt(r.tokenId!), r.buyer!, BigInt(r.priceWei!), BigInt(r.admissionDeadline!), BigInt(r.maxEffectiveAt!)]) };
  return { data: encodeCall(`${r.kind}(bytes32)`, ['bytes32'], [key]) };
}
export class LegacyClearingSession {
  readonly #provider: Eip1193Provider; readonly #store: LegacyClearingStore; readonly #guard: () => void;
  readonly #deployment: LegacyClearingDeployment; readonly actor: string; #busy = false;
  constructor(provider: Eip1193Provider, deployment: LegacyClearingDeployment, actor: string, store: LegacyClearingStore, guard: () => void = () => {}) {
    this.#provider = provider; this.#deployment = parseLegacyClearingDeployment(deployment); this.actor = rpcAddress(actor); this.#store = store; this.#guard = guard;
  }
  async #rpc(method: string, params: readonly unknown[]) { this.#guard(); return controlRpc(this.#provider, method, params); }
  async #identity() {
    check(quantity(await this.#rpc('eth_chainId', [])).toString() === this.#deployment.chainId, 'CLEARING_CHAIN_CHANGED');
    const accounts = await this.#rpc('eth_accounts', []);
    check(Array.isArray(accounts) && rpcAddress(accounts[0]) === this.actor, 'CLEARING_ACCOUNT_CHANGED');
    check(await this.#rpc('eth_getCode', [this.actor, 'latest']) === '0x', 'CLEARING_EOA_REQUIRED');
  }
  async #call(to: string, block: string, signature: string, types: StaticType[], args: AbiValue[], returns: StaticType[]) {
    return decoded(returns, await this.#rpc('eth_call', [{ to, data: encodeCall(signature, types, args) }, block]));
  }
  async #snapshot() {
    await this.#identity(); const b = object(await this.#rpc('eth_getBlockByNumber', ['latest', false]));
    const block = hex(quantity(b.number)), blockHash = hash(b.hash), now = quantity(b.timestamp), d = this.#deployment;
    for (const pin of [d.escrow, d.projection]) {
      const code = await this.#rpc('eth_getCode', [pin.address, block]);
      check(controlHex(code) && code.length > 2 && hashControlBytes(code) === pin.runtimeCodeHash, 'CLEARING_RUNTIME_PIN_MISMATCH');
    }
    const call = (signature: string, types: StaticType[], args: AbiValue[], returns: StaticType[]) => this.#call(d.projection.address, block, signature, types, args, returns);
    for (const [iid, expected] of [['0x01ffc9a7', true], ['0xffffffff', false], ['0x80ac58cd', true], ['0x6309e170', true]] as const)
      check((await call('supportsInterface(bytes4)', ['bytes4'], [iid], ['bool']))[0] === expected, 'CLEARING_PROJECTION_INTERFACE_REFUSED');
    check((await call('registerId()', [], [], ['bytes32']))[0] === d.registerId, 'CLEARING_REGISTER_CHANGED');
    const settlement = (await call('supportsInterface(bytes4)', ['bytes4'], ['0xf4a7d71b'], ['bool']))[0] as boolean;
    check(settlement === (d.verificationProfile !== null), 'CLEARING_PROFILE_INTERFACE_CHANGED');
    if (settlement) check((await call('verificationProfile()', [], [], ['bytes32']))[0] === d.verificationProfile, 'CLEARING_PROFILE_CHANGED');
    const transport = { call: async (to: Address, data: string) => {
      const raw = await this.#rpc('eth_call', [{ to, data }, block]);
      decoded(data.startsWith(encodeCall('tradeOf(bytes32)', ['bytes32'], [ZERO]).slice(0, 10)) ? TRADE_TYPES : OBSERVE_TYPES, raw);
      return raw as string;
    } } as CallTransport;
    return { block, blockHash, now, settlement, call, reader: new RpcEscrowReader(transport, BigInt(d.chainId), d.escrow.address as Address) };
  }
  async #finish(block: string, blockHash: string) {
    check(hash(object(await this.#rpc('eth_getBlockByNumber', [block, false])).hash) === blockHash, 'CLEARING_SNAPSHOT_REORGED');
    await this.#identity(); this.#guard();
  }
  async verify(): Promise<void> {
    const snapshot = await this.#snapshot(); await this.#finish(snapshot.block, snapshot.blockHash);
  }
  async status(): Promise<LegacyClearingState> {
    let s = await this.#store.read();
    if (s === null) {
      s = { schema: '8415-legacy-operation/1', revision: 0, chainId: this.#deployment.chainId, actor: this.actor, status: 'idle', review: null, transactionHash: null };
      check(await this.#store.compareAndSwap(null, s), 'CLEARING_OPERATION_CONCURRENT');
    }
    const result = parseLegacyClearingState(json(s));
    check(result.chainId === this.#deployment.chainId && result.actor === this.actor, 'CLEARING_JOURNAL_BINDING_REFUSED');
    if (result.review) check(json(result.review.deployment) === json(this.#deployment), 'CLEARING_SAVED_DEPLOYMENT_REQUIRED');
    return result;
  }
  async observe(tradeKey: string) {
    const key = hash(tradeKey), snapshot = await this.#snapshot(), trade = await snapshot.reader.tradeOf(key as Bytes32);
    check(trade.state !== 'NONE', 'CLEARING_TRADE_NOT_FOUND');
    check(trade.projection === this.#deployment.projection.address, 'CLEARING_TRADE_PROJECTION_REFUSED');
    const observation = await snapshot.reader.observe(key as Bytes32);
    check(observation.state === trade.state, 'CLEARING_OBSERVATION_MISMATCH');
    await this.#finish(snapshot.block, snapshot.blockHash);
    return { tradeKey: key, chainId: this.#deployment.chainId, escrow: this.#deployment.escrow.address,
      projection: this.#deployment.projection.address, registerId: this.#deployment.registerId, verificationProfile: this.#deployment.verificationProfile,
      blockNumber: snapshot.block, blockHash: snapshot.blockHash, now: snapshot.now.toString(), trade, observation,
      view: buildEscrowView(trade, observation, snapshot.now), notes: CLEARING_NOTES };
  }
  async prepare(requestText: string, expiresAt?: string): Promise<LegacyClearingReview> {
    const r = request(requestText), d = this.#deployment, s = await this.#snapshot();
    const expiry = expiresAt === undefined ? s.now + 300n : uint(expiresAt, 64);
    check(expiry > s.now && expiry - s.now <= 900n, 'CLEARING_REVIEW_EXPIRED');
    const key = r.tradeKey ?? legacyTradeKey(this.actor, r.localId!), trade = await s.reader.tradeOf(key as Bytes32);
    let value = 0n, facts: unknown;
    if (r.kind === 'open' || r.kind === 'approve') {
      check(trade.state === 'NONE', 'CLEARING_TRADE_ALREADY_EXISTS');
      check(r.buyer !== this.actor && BigInt(r.admissionDeadline!) > s.now, 'CLEARING_TERMS_REFUSED');
      check((await s.call('ownerOf(uint256)', ['uint256'], [BigInt(r.tokenId!)], ['address']))[0] === this.actor, 'CLEARING_SELLER_NOT_OWNER');
      const approved = (await s.call('getApproved(uint256)', ['uint256'], [BigInt(r.tokenId!)], ['address']))[0];
      const operator = (await s.call('isApprovedForAll(address,address)', ['address', 'address'], [this.actor, d.escrow.address], ['bool']))[0];
      check(r.kind === 'approve' ? approved !== d.escrow.address && !operator : approved === d.escrow.address || operator === true,
        r.kind === 'approve' ? 'CLEARING_APPROVAL_ALREADY_AVAILABLE' : 'CLEARING_TOKEN_APPROVAL_REQUIRED');
      facts = { seller: this.actor, buyer: r.buyer, projection: d.projection.address, tokenId: r.tokenId, priceWei: r.priceWei,
        admissionDeadline: r.admissionDeadline, maxEffectiveAt: r.maxEffectiveAt, approved, operator,
        approval: r.kind === 'approve' ? 'Exact ERC-721 token approval to the pinned escrow only. No approval-for-all. Opening needs a separate review and send.' : null };
    } else {
      check(trade.state !== 'NONE' && trade.projection === d.projection.address, 'CLEARING_TRADE_PROJECTION_REFUSED');
      const observation = await s.reader.observe(key as Bytes32);
      check(observation.state === trade.state, 'CLEARING_OBSERVATION_MISMATCH');
      if (r.kind === 'fund') { check(trade.state === 'AWAITING_PAYMENT' && trade.buyer === this.actor, 'CLEARING_BUYER_OR_STATE_REFUSED'); value = trade.price; }
      if (r.kind === 'abandon') check(trade.state === 'AWAITING_PAYMENT' && trade.seller === this.actor, 'CLEARING_SELLER_OR_STATE_REFUSED');
      if (r.kind === 'release') check(trade.state === 'FUNDED' && observation.confirmed, 'CLEARING_RELEASE_UNAVAILABLE');
      if (r.kind === 'refund') check(trade.state === 'FUNDED' && !observation.confirmed && s.now > trade.admissionDeadline, 'CLEARING_REFUND_UNAVAILABLE');
      facts = { trade, observation, deadlinePassed: s.now > trade.admissionDeadline, condition: 'The contract re-reads the projection atomically. A late qualifying admission prevents refund, including after the deadline.',
        holderRead: observation.confirmedHolder === ZERO_ADDRESS ? 'Unavailable or no admitted entry; never inferred from the position.' : 'Returned by escrow observation; independent from the position.' };
    }
    const nonce = controlPendingNonce(await this.#rpc('eth_getTransactionCount', [this.actor, 'pending']));
    const transaction = { from: this.actor, to: r.kind === 'approve' ? d.projection.address : d.escrow.address,
      chainId: hex(BigInt(d.chainId)), value: hex(value), data: encodeRequest(r, d, key).data, nonce: hex(nonce) };
    quantity(await this.#rpc('eth_estimateGas', [structuredClone(transaction)])); await this.#finish(s.block, s.blockHash);
    const unsigned = { requestText: json(r), action: r.kind, tradeKey: key, expiresAt: expiry.toString(), deployment: structuredClone(d), transaction,
      facts: json(facts) };
    return structuredClone({ ...unsigned, digest: reviewDigest(unsigned) });
  }
  async submit(review: LegacyClearingReview, acknowledgedDigest: string): Promise<string> {
    check(!this.#busy, 'CLEARING_OPERATION_BUSY'); this.#busy = true;
    try {
      const original = structuredClone(review); check(acknowledgedDigest === original.digest, 'CLEARING_OWNER_REVIEW_REQUIRED');
      const state = await this.status(); check(state.status === 'idle', 'CLEARING_RECONCILIATION_REQUIRED');
      const fresh = await this.prepare(original.requestText, original.expiresAt);
      check(json(fresh) === json(original), 'CLEARING_REVIEW_CHANGED');
      const reserved: LegacyClearingState = { ...state, revision: state.revision + 1, status: 'outcome-unknown', review: fresh, transactionHash: null };
      check(await this.#store.compareAndSwap(state.revision, reserved), 'CLEARING_OPERATION_CONCURRENT');
      let invoked = false, transactionHash: string;
      try {
        await this.#identity(); this.#guard();
        const guarded = { request: (args: { method: string; params?: readonly unknown[] }) => {
          this.#guard(); invoked = true; return this.#provider.request(args);
        } };
        transactionHash = hash(await controlRpc(guarded, 'eth_sendTransaction', [structuredClone(fresh.transaction)]));
      } catch (error) {
        if (!invoked || isControlProviderRejection(error, 'eth_sendTransaction')) {
          let reset = false;
          try { reset = await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1,
            status: 'idle', review: null, transactionHash: null }); } catch { /* Keep the durable reservation. */ }
          check(reset, 'CLEARING_REJECTION_PERSISTENCE_UNCERTAIN');
        }
        throw error;
      }
      check(await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1, status: 'submitted', transactionHash }), 'CLEARING_PERSISTENCE_UNCERTAIN');
      return transactionHash;
    } finally { this.#busy = false; }
  }
  async #receipt(state: LegacyClearingState, transactionHash: string, minimum: bigint): Promise<Receipt> {
    check(typeof minimum === 'bigint' && minimum >= 1n, 'CLEARING_CONFIRMATIONS_REFUSED'); await this.#identity();
    const result = (value: Receipt['state'], n = 0n): Receipt => ({ state: value, transactionHash, confirmations: n.toString() });
    const raw = await this.#rpc('eth_getTransactionReceipt', [transactionHash]); if (raw === null) return result('pending');
    const receipt = object(raw), number = quantity(receipt.blockNumber), blockHash = hash(receipt.blockHash);
    const actual = object(await this.#rpc('eth_getTransactionByHash', [transactionHash])), review = state.review!, expected = review.transaction;
    check(hash(receipt.transactionHash) === transactionHash && hash(actual.hash) === transactionHash && hash(actual.blockHash) === blockHash &&
      quantity(actual.blockNumber) === number && quantity(actual.transactionIndex) === quantity(receipt.transactionIndex), 'CLEARING_RECEIPT_BINDING_REFUSED');
    check(rpcAddress(receipt.from) === expected.from && rpcAddress(receipt.to) === expected.to && rpcAddress(actual.from) === expected.from && rpcAddress(actual.to) === expected.to &&
      quantity(actual.nonce) === quantity(expected.nonce) && quantity(actual.value) === quantity(expected.value) && typeof actual.input === 'string' && actual.input.toLowerCase() === expected.data, 'CLEARING_TRANSACTION_BINDING_REFUSED');
    if (actual.chainId !== undefined) check(quantity(actual.chainId) === BigInt(state.chainId), 'CLEARING_RECEIPT_BINDING_REFUSED');
    const canonical = await this.#rpc('eth_getBlockByNumber', [hex(number), false]);
    if (canonical === null || hash(object(canonical).hash) !== blockHash) return result('reorged');
    const head = quantity(await this.#rpc('eth_blockNumber', [])); if (head < number) return result('reorged');
    const count = head - number + 1n, status = quantity(receipt.status); check(status === 0n || status === 1n, 'CLEARING_RECEIPT_STATUS_REFUSED');
    if (count < minimum) return result('confirming', count);
    for (const pin of [this.#deployment.escrow, this.#deployment.projection]) {
      const code = await this.#rpc('eth_getCode', [pin.address, hex(number)]);
      check(controlHex(code) && hashControlBytes(code) === pin.runtimeCodeHash, 'CLEARING_RECEIPT_RUNTIME_MISMATCH');
    }
    if (status === 1n) check(this.#effect(receipt, review, transactionHash, blockHash, number), 'CLEARING_EFFECT_UNOBSERVED');
    await this.#identity();
    const again = await this.#rpc('eth_getBlockByNumber', [hex(number), false]);
    if (again === null || hash(object(again).hash) !== blockHash) return result('reorged');
    return result(status === 0n ? 'reverted' : 'confirmed', count);
  }
  #effect(receipt: Record<string, unknown>, review: LegacyClearingReview, transactionHash: string, blockHash: string, number: bigint): boolean {
    check(Array.isArray(receipt.logs), 'CLEARING_EFFECT_UNOBSERVED');
    const r = request(review.requestText), d = this.#deployment;
    const wordAddress = (value: string) => encodeWords(['address'], [value]);
    const events: Record<Action, string> = { approve: 'Approval(address,address,uint256)', open: 'TradeOpened(bytes32,bytes32,address,uint256,address,address,uint256,uint64,uint64)',
      fund: 'TradeFunded(bytes32,address,uint256,uint64)', release: 'TradeReleased(bytes32,address,uint64,uint64)', refund: 'TradeRefunded(bytes32,address,uint64)', abandon: 'TradeAbandoned(bytes32,address)' };
    return receipt.logs.some((raw: unknown) => {
      const log = object(raw);
      if (log.transactionHash !== transactionHash || log.blockHash !== blockHash || quantity(log.blockNumber) !== number ||
        quantity(log.transactionIndex) !== quantity(receipt.transactionIndex) || log.removed !== false || !Array.isArray(log.topics)) return false;
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== review.transaction.to || log.topics[0] !== keccak256Utf8(events[r.kind])) return false;
      if (r.kind === 'approve') return json(log.topics) === json([keccak256Utf8(events.approve), wordAddress(this.actor), wordAddress(d.escrow.address), encodeWords(['uint256'], [BigInt(r.tokenId!)])]) && log.data === '0x';
      if (log.topics[1] !== review.tradeKey) return false;
      if (r.kind === 'open') return json(log.topics) === json([keccak256Utf8(events.open), review.tradeKey, r.localId, wordAddress(d.projection.address)]) &&
        log.data === encodeWords(['uint256', 'address', 'address', 'uint256', 'uint64', 'uint64'], [BigInt(r.tokenId!), this.actor, r.buyer!, BigInt(r.priceWei!), BigInt(r.admissionDeadline!), BigInt(r.maxEffectiveAt!)]);
      const facts = object(JSON.parse(review.facts)), trade = object(facts.trade);
      const party = r.kind === 'abandon' ? trade.seller as string : trade.buyer as string;
      if (log.topics.length !== 3 || log.topics[2] !== wordAddress(party)) return false;
      if (r.kind === 'abandon') return log.data === '0x';
      const fields = decoded(r.kind === 'fund' ? ['uint256', 'uint64'] : r.kind === 'release' ? ['uint64', 'uint64'] : ['uint64'], log.data);
      if (r.kind === 'fund') return fields[0] === BigInt(trade.price as string);
      if (r.kind === 'release') return (fields[0] as bigint) > BigInt(trade.entryCountAtFunding as string) && (fields[1] as bigint) <= BigInt(trade.maxEffectiveAt as string);
      return true;
    });
  }
  async reconcile(minimum = 2n): Promise<Receipt> {
    const state = await this.status(); check(state.status === 'submitted' && state.transactionHash !== null, 'CLEARING_KNOWN_HASH_REQUIRED');
    return this.#receipt(state, state.transactionHash, minimum);
  }
  async recover(transactionHash: string, minimum = 2n): Promise<Receipt> {
    const state = await this.status(); check(state.status !== 'idle', 'CLEARING_ACTIVE_SUBMISSION_REQUIRED');
    const h = hash(transactionHash), result = await this.#receipt(state, h, minimum);
    check(['confirming', 'confirmed', 'reverted'].includes(result.state), 'CLEARING_RECOVERY_BINDING_UNOBSERVED');
    check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1, status: 'submitted', transactionHash: h }), 'CLEARING_OPERATION_CONCURRENT');
    return result;
  }
  /** Explicit evidence that a different canonical transaction consumed this
   * actor's saved nonce. The original action is superseded, never successful. */
  async acknowledgeReplacement(transactionHash: string, minimum = 2n): Promise<{ originalOutcome: 'superseded-not-successful'; replacementHash: string }> {
    check(typeof minimum === 'bigint' && minimum >= 1n, 'CLEARING_CONFIRMATIONS_REFUSED');
    const state = await this.status(); check(state.status !== 'idle' && state.review !== null, 'CLEARING_ACTIVE_SUBMISSION_REQUIRED');
    const h = hash(transactionHash), expected = state.review.transaction;
    check(state.transactionHash === null || h !== state.transactionHash, 'CLEARING_SAVED_HASH_NOT_REPLACEMENT');
    await this.#identity();
    const receipt = object(await this.#rpc('eth_getTransactionReceipt', [h])), actual = object(await this.#rpc('eth_getTransactionByHash', [h]));
    const number = quantity(receipt.blockNumber), blockHash = hash(receipt.blockHash);
    check(hash(receipt.transactionHash) === h && hash(actual.hash) === h && hash(actual.blockHash) === blockHash && quantity(actual.blockNumber) === number &&
      quantity(actual.transactionIndex) === quantity(receipt.transactionIndex), 'CLEARING_REPLACEMENT_BINDING_REFUSED');
    check(rpcAddress(receipt.from) === state.actor && rpcAddress(actual.from) === state.actor && quantity(actual.nonce) === quantity(expected.nonce), 'CLEARING_REPLACEMENT_NONCE_REFUSED');
    if (actual.chainId !== undefined) check(quantity(actual.chainId) === BigInt(state.chainId), 'CLEARING_REPLACEMENT_BINDING_REFUSED');
    const destination = actual.to === null ? null : rpcAddress(actual.to);
    check((receipt.to === null ? null : rpcAddress(receipt.to)) === destination && controlHex(actual.input), 'CLEARING_REPLACEMENT_BINDING_REFUSED');
    check(destination !== expected.to || quantity(actual.value) !== quantity(expected.value) || actual.input.toLowerCase() !== expected.data, 'CLEARING_MATCHING_INTENT_RECOVER_HASH');
    check([0n, 1n].includes(quantity(receipt.status)), 'CLEARING_RECEIPT_STATUS_REFUSED');
    const canonical = await this.#rpc('eth_getBlockByNumber', [hex(number), false]);
    check(canonical !== null && hash(object(canonical).hash) === blockHash, 'CLEARING_REPLACEMENT_REORGED');
    const head = quantity(await this.#rpc('eth_blockNumber', []));
    check(head >= number && head - number + 1n >= minimum, 'CLEARING_REPLACEMENT_CONFIRMATIONS_REQUIRED');
    await this.#identity();
    const again = await this.#rpc('eth_getBlockByNumber', [hex(number), false]);
    check(again !== null && hash(object(again).hash) === blockHash, 'CLEARING_REPLACEMENT_REORGED');
    check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1, status: 'idle', review: null, transactionHash: null }), 'CLEARING_OPERATION_CONCURRENT');
    return { originalOutcome: 'superseded-not-successful', replacementHash: h };
  }
  async acknowledge(minimum = 2n): Promise<void> {
    const state = await this.status(); check(state.status === 'submitted' && state.transactionHash !== null, 'CLEARING_KNOWN_HASH_REQUIRED');
    const result = await this.#receipt(state, state.transactionHash, minimum);
    check(result.state === 'confirmed' || result.state === 'reverted', 'CLEARING_TERMINAL_RECEIPT_REQUIRED');
    check(await this.#store.compareAndSwap(state.revision, { ...state, revision: state.revision + 1, status: 'idle', review: null, transactionHash: null }), 'CLEARING_OPERATION_CONCURRENT');
  }
}
export const CLEARING_NOTES = 'Legacy single-trade clearing is application state, not ERC gap state or linked responsibility completion. Release uses an admitted but provisional record and does not establish ERC temporal or legal finality. Agreement between position and confirmed holder does not verify legal identity. Reads are snapshots; release and refund re-read inside the transaction. Gap closure or cancellation alone authorizes neither release nor refund. Zero holders in escrow observations mean unavailable/no entry, never a substitute owner. No automatic resend; retain browser storage until a bound canonical receipt is reconciled.';
