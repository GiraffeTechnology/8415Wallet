import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { encodeCall, encodeCallWithTail } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { isAddressInput } from './address.ts';
import { controlHex, controlRpc, controlPendingNonce, hashControlBytes, requireControlAdapter as check } from '../controls/authorization.ts';

export const ASSET_CHAINS = Object.freeze({ '1': 'Ethereum', '8453': 'Base', '11155111': 'Sepolia', '84532': 'Base Sepolia' });
type PublicObject = Record<string, unknown>;
export type AssetTransaction = { from: string; to: string; chainId: string; value: string; data: string; nonce: string };
export type AssetReview = { requestText: string; requestId: string; claimedAgent: string; expiresAt: string;
  chain: string; asset: string; recipient: string; amount: string; tokenId: string | null;
  transaction: AssetTransaction; codeHash: string | null; digest: string };
export type AssetState = { schema: 'xiongan-asset-operation/1'; revision: number; chainId: string; actor: string;
  status: 'idle' | 'outcome-unknown' | 'submitted'; transaction: AssetTransaction | null; transactionHash: string | null; digest: string | null };
export type AssetStore = { read(): Promise<AssetState | null>; compareAndSwap(expected: number | null, next: AssetState): Promise<boolean> };
export type AssetReceipt = { state: 'pending' | 'reorged' | 'confirming' | 'confirmed' | 'reverted'; transactionHash: string; confirmations: string };
function obj(v: unknown, keys?: string[]): PublicObject {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'ASSET_SCHEMA_REFUSED');
  if (keys) check(Object.keys(v).sort().join(',') === keys.sort().join(','), 'ASSET_SCHEMA_REFUSED');
  return v as PublicObject;
}
function addr(v: unknown): string { check(controlHex(v, 20) && !/^0x0+$/i.test(v), 'ASSET_ADDRESS_REFUSED'); return v.toLowerCase(); }
function inputAddr(v: unknown): string { check(isAddressInput(v), 'ASSET_ADDRESS_REFUSED'); return v.toLowerCase(); }
function uint(v: unknown): bigint { check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n, 'ASSET_INTEGER_REFUSED'); return BigInt(v); }
/** Exact display conversion only; transaction inputs remain explicit integer wei. */
export function formatWeiAsEth(valueWei: string): string {
  const value = uint(valueWei), unit = 10n ** 18n;
  const fraction = (value % unit).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / unit}${fraction ? `.${fraction}` : ''}`;
}
function quantity(v: unknown): bigint { check(typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(v) && v.length <= 66, 'ASSET_QUANTITY_REFUSED'); return BigInt(v); }
const hex = (v: bigint) => `0x${v.toString(16)}`;
function chain(v: unknown): string { const n = uint(v).toString(); check(Object.hasOwn(ASSET_CHAINS, n), 'ASSET_CHAIN_UNSUPPORTED'); return n; }
function hash(v: unknown): string { check(controlHex(v, 32) && !/^0x0+$/.test(v), 'ASSET_HASH_REFUSED'); return v.toLowerCase(); }
function tx(v: unknown): AssetTransaction {
  const r = obj(v, ['from', 'to', 'chainId', 'value', 'data', 'nonce']);
  check(controlHex(r.data) && r.data.length <= 1026, 'ASSET_CALLDATA_REFUSED');
  chain(quantity(r.chainId).toString());
  return { from: addr(r.from), to: addr(r.to), chainId: hex(quantity(r.chainId)), value: hex(quantity(r.value)),
    data: r.data.toLowerCase(), nonce: hex(quantity(r.nonce)) };
}
export function parseAssetState(text: string): AssetState {
  check(text.length <= 8192, 'ASSET_JOURNAL_REFUSED');
  let raw: unknown; try { raw = JSON.parse(text); } catch { check(false, 'ASSET_JOURNAL_REFUSED'); }
  const r = obj(raw, ['schema', 'revision', 'chainId', 'actor', 'status', 'transaction', 'transactionHash', 'digest']);
  check(r.schema === 'xiongan-asset-operation/1' && Number.isSafeInteger(r.revision) && (r.revision as number) >= 0, 'ASSET_JOURNAL_REFUSED');
  check(['idle', 'outcome-unknown', 'submitted'].includes(r.status as string), 'ASSET_JOURNAL_REFUSED');
  const transaction = r.transaction === null ? null : tx(r.transaction), id = chain(r.chainId), actor = addr(r.actor);
  check(transaction === null || (quantity(transaction.chainId).toString() === id && transaction.from === actor), 'ASSET_JOURNAL_BINDING_REFUSED');
  const transactionHash = r.transactionHash === null ? null : hash(r.transactionHash), digest = r.digest === null ? null : hash(r.digest);
  check(r.status === 'idle' ? transaction === null && transactionHash === null && digest === null : transaction !== null && digest !== null &&
    (r.status === 'submitted' ? transactionHash !== null : transactionHash === null), 'ASSET_JOURNAL_REFUSED');
  return { schema: 'xiongan-asset-operation/1', revision: r.revision as number, chainId: id, actor, status: r.status as AssetState['status'], transaction, transactionHash, digest };
}
function parseRequest(text: string) {
  check(typeof text === 'string' && text.length > 0 && text.length <= 8192, 'ASSET_REQUEST_SIZE_REFUSED');
  let raw: unknown; try { raw = JSON.parse(text); } catch { check(false, 'ASSET_REQUEST_JSON_REFUSED'); }
  const r = obj(raw, ['schema', 'requestId', 'agent', 'chainId', 'actor', 'expiresAt', 'action']);
  check(r.schema === 'xiongan-asset-request/1', 'ASSET_REQUEST_SCHEMA_REFUSED');
  check(typeof r.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.requestId), 'ASSET_REQUEST_ID_REFUSED');
  check(typeof r.agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(r.agent), 'ASSET_REQUEST_AGENT_REFUSED');
  return { r, chainId: chain(r.chainId), actor: inputAddr(r.actor), expiresAt: uint(r.expiresAt), action: obj(r.action) };
}
/** External EOA custody only. No private keys, token allowances, delegated/session
 * authority, swaps, bridging or connection to the 8415 controlled account. */
export class ExternalAssetSession {
  readonly #provider: Eip1193Provider; readonly #store: AssetStore; readonly #connectionGuard: () => void;
  readonly actor: string; readonly chainId: string; #busy = false;
  constructor(provider: Eip1193Provider, chainId: string, actor: string, store: AssetStore, connectionGuard: () => void = () => {}) {
    this.#provider = provider; this.#store = store; this.#connectionGuard = connectionGuard; this.chainId = chain(chainId); this.actor = addr(actor);
  }
  async #rpc(method: string, params: readonly unknown[]) { this.#connectionGuard(); return controlRpc(this.#provider, method, params); }
  async #identity() {
    check(quantity(await this.#rpc('eth_chainId', [])).toString() === this.chainId, 'ASSET_CHAIN_CHANGED');
    const accounts = await this.#rpc('eth_accounts', []);
    check(Array.isArray(accounts) && addr(accounts[0]) === this.actor, 'ASSET_ACCOUNT_CHANGED');
    check(await this.#rpc('eth_getCode', [this.actor, 'latest']) === '0x', 'ASSET_EOA_REQUIRED');
  }
  async status(): Promise<AssetState> {
    let s = await this.#store.read();
    if (s === null) {
      s = { schema: 'xiongan-asset-operation/1', revision: 0, chainId: this.chainId, actor: this.actor,
        status: 'idle', transaction: null, transactionHash: null, digest: null };
      check(await this.#store.compareAndSwap(null, s), 'ASSET_OPERATION_CONCURRENT');
    }
    s = parseAssetState(JSON.stringify(s));
    check(s.chainId === this.chainId && s.actor === this.actor, 'ASSET_JOURNAL_BINDING_REFUSED'); return s;
  }
  async balance(): Promise<{ chainId: string; account: string; balanceWei: string; blockNumber: string; blockHash: string }> {
    await this.#identity(); const block = obj(await this.#rpc('eth_getBlockByNumber', ['latest', false]));
    const number = hex(quantity(block.number)), blockHash = hash(block.hash);
    const balanceWei = quantity(await this.#rpc('eth_getBalance', [this.actor, number])).toString();
    const again = obj(await this.#rpc('eth_getBlockByNumber', [number, false]));
    check(hash(again.hash) === blockHash, 'ASSET_SNAPSHOT_REORGED'); await this.#identity();
    return { chainId: this.chainId, account: this.actor, balanceWei, blockNumber: number, blockHash };
  }
  async prepare(text: string): Promise<AssetReview> {
    const { r, chainId, actor, expiresAt, action } = parseRequest(text);
    check(chainId === this.chainId && actor === this.actor, 'ASSET_REQUEST_BINDING_REFUSED');
    await this.#identity(); const header = obj(await this.#rpc('eth_getBlockByNumber', ['latest', false]));
    const now = quantity(header.timestamp), block = hex(quantity(header.number)), blockHash = hash(header.hash);
    check(expiresAt > now && expiresAt - now <= 900n, 'ASSET_REQUEST_EXPIRED');
    const nonce = controlPendingNonce(await this.#rpc('eth_getTransactionCount', [actor, 'pending']));
    const recipient = inputAddr(action.recipient); check(recipient !== actor, 'ASSET_SELF_TRANSFER_REFUSED');
    let to = recipient, value = 0n, data = '0x', codeHash: string | null = null, asset = 'ETH', amount: string, tokenId: string | null = null;
    if (action.kind === 'native-transfer') {
      obj(action, ['kind', 'recipient', 'valueWei']); value = uint(action.valueWei); check(value > 0n, 'ASSET_AMOUNT_REFUSED');
      check(quantity(await this.#rpc('eth_getBalance', [actor, block])) > value, 'ASSET_BALANCE_OR_GAS_INSUFFICIENT'); amount = value.toString();
      // No calldata and no hidden contract invocation from an alleged ETH transfer.
      check(await this.#rpc('eth_getCode', [recipient, block]) === '0x', 'ASSET_NATIVE_RECIPIENT_EOA_REQUIRED');
    } else {
      check(action.kind === 'erc721-transfer' || action.kind === 'erc1155-transfer', 'ASSET_ACTION_UNSUPPORTED');
      obj(action, action.kind === 'erc721-transfer' ? ['kind', 'recipient', 'contract', 'tokenId'] : ['kind', 'recipient', 'contract', 'tokenId', 'amount']);
      to = inputAddr(action.contract); const id = uint(action.tokenId); tokenId = id.toString();
      const code = await this.#rpc('eth_getCode', [to, block]); check(controlHex(code) && code.length > 2, 'ASSET_TOKEN_CODE_REQUIRED'); codeHash = hashControlBytes(code);
      const call = (input: string) => this.#rpc('eth_call', [{ to, data: input }, block]);
      // ERC-165 discovery includes its invalid-interface negative probe.
      for (const [iid, expected] of [['0x01ffc9a7', true], ['0xffffffff', false], [action.kind === 'erc721-transfer' ? '0x80ac58cd' : '0xd9b67a26', true]] as const) {
        check(await call(encodeCall('supportsInterface(bytes4)', ['bytes4'], [iid])) === `0x${'0'.repeat(63)}${expected ? '1' : '0'}`, 'ASSET_NFT_INTERFACE_REFUSED');
      }
      if (action.kind === 'erc721-transfer') {
        check(await call(encodeCall('ownerOf(uint256)', ['uint256'], [id])) === `0x${'0'.repeat(24)}${actor.slice(2)}`, 'ASSET_NFT_NOT_OWNED');
        data = encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [actor, recipient, id]); asset = 'ERC-721'; amount = '1';
      } else {
        const n = uint(action.amount); check(n > 0n, 'ASSET_AMOUNT_REFUSED');
        const balance = await call(encodeCall('balanceOf(address,uint256)', ['address', 'uint256'], [actor, id]));
        check(controlHex(balance, 32) && BigInt(balance) >= n, 'ASSET_NFT_BALANCE_INSUFFICIENT');
        data = encodeCallWithTail('safeTransferFrom(address,address,uint256,uint256,bytes)', ['address', 'address', 'uint256', 'uint256', 'bytes'], [actor, recipient, id, n, '0x']); asset = 'ERC-1155'; amount = n.toString();
      }
    }
    const transaction = { from: actor, to, chainId: hex(BigInt(chainId)), value: hex(value), data, nonce: hex(nonce) };
    // Simulation failure is unavailable, never authorization. Gas fees remain a wallet decision.
    quantity(await this.#rpc('eth_estimateGas', [transaction]));
    check(hash(obj(await this.#rpc('eth_getBlockByNumber', [block, false])).hash) === blockHash, 'ASSET_SNAPSHOT_REORGED');
    await this.#identity();
    const summary = { requestId: r.requestId as string, claimedAgent: r.agent as string, expiresAt: expiresAt.toString(),
      chain: ASSET_CHAINS[chainId as keyof typeof ASSET_CHAINS], asset, recipient, amount, tokenId, transaction, codeHash };
    Object.freeze(transaction);
    return Object.freeze({ ...summary, requestText: text, digest: keccak256Utf8(JSON.stringify(summary)) });
  }
  /** Called only by the owner's explicit UI action after review. The genuine wallet
   * retains the final signing/submission decision. Agent file import cannot call it. */
  async submit(review: AssetReview, acknowledgedDigest: string): Promise<string> {
    check(!this.#busy, 'ASSET_OPERATION_BUSY'); this.#busy = true;
    try {
      const original = structuredClone(review); check(acknowledgedDigest === original.digest, 'ASSET_OWNER_REVIEW_REQUIRED');
      const state = await this.status(); check(state.status === 'idle', 'ASSET_RECONCILIATION_REQUIRED');
      const fresh = await this.prepare(original.requestText); check(fresh.digest === original.digest && JSON.stringify(fresh) === JSON.stringify(original), 'ASSET_REVIEW_CHANGED');
      const reserved: AssetState = { ...state, revision: state.revision + 1, status: 'outcome-unknown', transaction: fresh.transaction, transactionHash: null, digest: fresh.digest };
      check(await this.#store.compareAndSwap(state.revision, reserved), 'ASSET_OPERATION_CONCURRENT');
      // Clear only if our own guard/reads fail BEFORE invoking the send boundary.
      // A provider rejection or timeout after invocation always remains unknown.
      let sendInvoked = false;
      let transactionHash: string;
      try {
        await this.#identity(); this.#connectionGuard();
        // controlRpc defers the provider call to a microtask; check the generation
        // at that exact boundary too, before marking the send as invoked.
        const guarded = { request: (args: { method: string; params?: readonly unknown[] }) => {
          this.#connectionGuard(); sendInvoked = true; return this.#provider.request(args);
        } };
        transactionHash = hash(await controlRpc(guarded, 'eth_sendTransaction', [fresh.transaction]));
      } catch (error) {
        if (!sendInvoked) await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1,
          status: 'idle', transaction: null, transactionHash: null, digest: null });
        throw error;
      }
      check(await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1, status: 'submitted', transactionHash }), 'ASSET_PERSISTENCE_UNCERTAIN');
      return transactionHash;
    } finally { this.#busy = false; }
  }
  async #receipt(state: AssetState, transactionHash: string, confirmations: bigint): Promise<AssetReceipt> {
    check(confirmations >= 1n, 'ASSET_CONFIRMATIONS_REFUSED'); await this.#identity();
    const output = (s: AssetReceipt['state'], count = 0n) => ({ state: s, transactionHash, confirmations: count.toString() });
    const raw = await this.#rpc('eth_getTransactionReceipt', [transactionHash]); if (raw === null) return output('pending');
    const receipt = obj(raw), blockNumber = quantity(receipt.blockNumber), blockHash = hash(receipt.blockHash);
    check(hash(receipt.transactionHash) === transactionHash, 'ASSET_RECEIPT_BINDING_REFUSED');
    const actual = obj(await this.#rpc('eth_getTransactionByHash', [transactionHash]));
    check(hash(actual.hash) === transactionHash && hash(actual.blockHash) === blockHash && quantity(actual.blockNumber) === blockNumber, 'ASSET_RECEIPT_BINDING_REFUSED');
    const expected = state.transaction!;
    check(addr(receipt.from) === expected.from && addr(receipt.to) === expected.to && quantity(receipt.transactionIndex) === quantity(actual.transactionIndex), 'ASSET_RECEIPT_BINDING_REFUSED');
    check(addr(actual.from) === expected.from && addr(actual.to) === expected.to && quantity(actual.nonce) === quantity(expected.nonce) &&
      quantity(actual.value) === quantity(expected.value) && typeof actual.input === 'string' && actual.input.toLowerCase() === expected.data, 'ASSET_TRANSACTION_BINDING_REFUSED');
    if (actual.chainId !== undefined) check(quantity(actual.chainId) === BigInt(this.chainId), 'ASSET_RECEIPT_BINDING_REFUSED');
    const canonical = await this.#rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
    if (canonical === null || hash(obj(canonical).hash) !== blockHash) return output('reorged');
    const head = quantity(await this.#rpc('eth_blockNumber', [])); if (head < blockNumber) return output('reorged');
    const count = head - blockNumber + 1n, status = quantity(receipt.status); check(status === 0n || status === 1n, 'ASSET_RECEIPT_STATUS_REFUSED');
    if (count < confirmations) return output('confirming', count);
    if (status === 1n && expected.data !== '0x') {
      check(Array.isArray(receipt.logs), 'ASSET_NFT_EFFECT_UNOBSERVED');
      const from = `0x${'0'.repeat(24)}${expected.from.slice(2)}`, recipient = `0x${expected.data.slice(74, 138)}`;
      const id = expected.data.slice(138, 202), is721 = expected.data.startsWith('0x42842e0e');
      const signature = keccak256Utf8(is721 ? 'Transfer(address,address,uint256)' : 'TransferSingle(address,address,address,uint256,uint256)');
      const effect = receipt.logs.some((raw: unknown) => {
        const log = obj(raw);
        if (log.transactionHash !== transactionHash || log.blockHash !== blockHash || quantity(log.blockNumber) !== blockNumber ||
          quantity(log.transactionIndex) !== quantity(receipt.transactionIndex) || log.removed !== false) return false;
        if (typeof log.address !== 'string' || log.address.toLowerCase() !== expected.to || !Array.isArray(log.topics)) return false;
        const topics = log.topics.map((t: unknown) => typeof t === 'string' ? t.toLowerCase() : '');
        return is721 ? topics.length === 4 && topics[0] === signature && topics[1] === from && topics[2] === recipient && topics[3] === `0x${id}` && log.data === '0x' :
          topics.length === 4 && topics[0] === signature && topics[1] === from && topics[2] === from && topics[3] === recipient &&
          log.data === `0x${id}${expected.data.slice(202, 266)}`;
      }); check(effect, 'ASSET_NFT_EFFECT_UNOBSERVED');
    }
    // A receipt is not ERC-8415 holder/finality evidence or economic finality.
    await this.#identity();
    const finalBlock = await this.#rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
    if (finalBlock === null || hash(obj(finalBlock).hash) !== blockHash) return output('reorged');
    return output(status === 0n ? 'reverted' : 'confirmed', count);
  }
  async reconcile(minimumConfirmations = 2n): Promise<AssetReceipt> {
    const s = await this.status(); check(s.status === 'submitted' && s.transactionHash !== null, 'ASSET_KNOWN_HASH_REQUIRED');
    return this.#receipt(s, s.transactionHash, minimumConfirmations);
  }
  async recover(transactionHash: string, minimumConfirmations = 2n): Promise<AssetReceipt> {
    const s = await this.status(); check(s.status !== 'idle' && s.transaction !== null, 'ASSET_ACTIVE_SUBMISSION_REQUIRED');
    const h = hash(transactionHash), receipt = await this.#receipt(s, h, minimumConfirmations);
    check(['confirmed', 'reverted', 'confirming'].includes(receipt.state), 'ASSET_RECOVERY_BINDING_UNOBSERVED');
    check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1, status: 'submitted', transactionHash: h }), 'ASSET_OPERATION_CONCURRENT');
    return receipt;
  }
  /** Explicit read-only proof that a DIFFERENT canonical transaction consumed the
   * saved nonce. Never calls the original intent successful and never resends. */
  async acknowledgeReplacement(transactionHash: string, minimumConfirmations = 2n): Promise<{ originalOutcome: 'superseded-not-successful'; replacementHash: string }> {
    check(minimumConfirmations >= 1n, 'ASSET_CONFIRMATIONS_REFUSED');
    const s = await this.status(); check(s.status !== 'idle' && s.transaction !== null, 'ASSET_ACTIVE_SUBMISSION_REQUIRED');
    const h = hash(transactionHash);
    check(s.transactionHash === null || h !== s.transactionHash, 'ASSET_SAVED_HASH_NOT_A_REPLACEMENT');
    await this.#identity();
    const r = obj(await this.#rpc('eth_getTransactionReceipt', [h])), replacement = obj(await this.#rpc('eth_getTransactionByHash', [h]));
    const number = quantity(r.blockNumber), blockHash = hash(r.blockHash);
    check(hash(r.transactionHash) === h && hash(replacement.hash) === h && hash(replacement.blockHash) === blockHash && quantity(replacement.blockNumber) === number,
      'ASSET_REPLACEMENT_BINDING_REFUSED');
    check(addr(r.from) === s.actor && r.to === replacement.to && quantity(r.transactionIndex) === quantity(replacement.transactionIndex), 'ASSET_REPLACEMENT_BINDING_REFUSED');
    check(addr(replacement.from) === s.actor && quantity(replacement.nonce) === quantity(s.transaction.nonce), 'ASSET_REPLACEMENT_NONCE_REFUSED');
    if (replacement.chainId !== undefined) check(quantity(replacement.chainId) === BigInt(s.chainId), 'ASSET_REPLACEMENT_BINDING_REFUSED');
    check(replacement.to === null || controlHex(replacement.to, 20), 'ASSET_REPLACEMENT_BINDING_REFUSED');
    check(controlHex(replacement.input), 'ASSET_REPLACEMENT_BINDING_REFUSED');
    check(replacement.to?.toLowerCase() !== s.transaction.to || quantity(replacement.value) !== quantity(s.transaction.value) || replacement.input.toLowerCase() !== s.transaction.data,
      'ASSET_MATCHING_INTENT_RECOVER_HASH');
    check([0n, 1n].includes(quantity(r.status)), 'ASSET_RECEIPT_STATUS_REFUSED');
    const canonical = await this.#rpc('eth_getBlockByNumber', [hex(number), false]);
    check(canonical !== null && hash(obj(canonical).hash) === blockHash, 'ASSET_REPLACEMENT_REORGED');
    const head = quantity(await this.#rpc('eth_blockNumber', []));
    check(head >= number && head - number + 1n >= minimumConfirmations, 'ASSET_REPLACEMENT_CONFIRMATIONS_REQUIRED');
    await this.#identity();
    check(hash(obj(await this.#rpc('eth_getBlockByNumber', [hex(number), false])).hash) === blockHash, 'ASSET_REPLACEMENT_REORGED');
    check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1, status: 'idle', transaction: null, transactionHash: null, digest: null }), 'ASSET_OPERATION_CONCURRENT');
    return { originalOutcome: 'superseded-not-successful', replacementHash: h };
  }
  async acknowledge(minimumConfirmations = 2n): Promise<void> {
    const s = await this.status(); check(s.status === 'submitted' && s.transactionHash !== null, 'ASSET_KNOWN_HASH_REQUIRED');
    const receipt = await this.#receipt(s, s.transactionHash, minimumConfirmations);
    check(receipt.state === 'confirmed' || receipt.state === 'reverted', 'ASSET_TERMINAL_RECEIPT_REQUIRED');
    check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1, status: 'idle', transaction: null, transactionHash: null, digest: null }), 'ASSET_OPERATION_CONCURRENT');
  }
}
