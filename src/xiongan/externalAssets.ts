import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { encodeCall, encodeCallWithTail } from '../codec/abi.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { isAddressInput } from './address.ts';
import { controlHex, controlRpc, controlPendingNonce, hashControlBytes, isControlProviderRejection, requireControlAdapter as check } from '../controls/authorization.ts';

export const ASSET_CHAINS = Object.freeze({ '1': 'Ethereum', '8453': 'Base', '11155111': 'Sepolia', '84532': 'Base Sepolia' });
type PublicObject = Record<string, unknown>;
export type AssetTransaction = { from: string; to: string; chainId: string; value: string; data: string; nonce: string };
export type Erc20Metadata = { name: string | null; symbol: string | null; decimals: number | null };
export type Erc20Balance = { chainId: string; account: string; contract: string; balanceRaw: string;
  displayBalance: string | null; metadata: Erc20Metadata; codeHash: string; blockNumber: string; blockHash: string };
export type NftStandard = 'ERC-721' | 'ERC-1155';
export type NftHolding = { chainId: string; account: string; contract: string; tokenId: string;
  standard: NftStandard; owner: string | null; balanceRaw: string; codeHash: string; blockNumber: string; blockHash: string };
export type AssetReview = { requestText: string; requestId: string; claimedAgent: string; expiresAt: string;
  chain: string; asset: string; recipient: string; amount: string; tokenId: string | null;
  transaction: AssetTransaction; codeHash: string | null; tokenMetadata: Erc20Metadata | null;
  displayAmount: string | null; digest: string };
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
/** Exact display conversion only. Amount inputs always remain integer raw units. */
export function formatTokenUnits(amount: string, decimals: number): string {
  check(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, 'ASSET_DECIMALS_REFUSED');
  const value = uint(amount), unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / unit}${fraction ? `.${fraction}` : ''}`;
}
/** Optional display-only metadata. Reject malformed ABI, oversized text, control
 * characters and bidirectional spoofing; never use metadata as token identity. */
function metadataText(value: unknown): string | null {
  if (!controlHex(value) || value.length < 130 || value.length > 386) return null;
  const body = value.slice(2);
  if (BigInt(`0x${body.slice(0, 64)}`) !== 32n) return null;
  const length = BigInt(`0x${body.slice(64, 128)}`);
  if (length === 0n || length > 128n) return null;
  const size = Number(length), padded = Math.ceil(size / 32) * 64;
  if (body.length !== 128 + padded || !/^0*$/.test(body.slice(128 + size * 2))) return null;
  const bytes = Uint8Array.from(body.slice(128, 128 + size * 2).match(/../g)!, byte => Number.parseInt(byte, 16));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) || text.trim().length === 0) return null;
  return text;
}
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
export type AssetReceiptObservation = AssetReceipt & { readonly blockNumber: string | null; readonly blockHash: string | null;
  readonly executionEventObserved: boolean };
/** Shared exact-transaction/event/canonical-chain observer. Inputs are copied;
 * no store, wallet selection, signing or send is performed here. Session callers
 * retain their additional account/connection guards. Depth is not finality. */
export async function receiptAssetTransaction(provider: Eip1193Provider, input: AssetTransaction,
  transactionHash: string, confirmations: bigint, identityGuard?: () => Promise<void>): Promise<AssetReceiptObservation> {
  check(typeof confirmations === 'bigint' && confirmations >= 1n, 'ASSET_CONFIRMATIONS_REFUSED');
  const expected = Object.freeze(tx(input)); transactionHash = hash(transactionHash);
  const rpc = (method: string, params: readonly unknown[]) => controlRpc(provider, method, params);
  const identity = async () => {
    check(quantity(await rpc('eth_chainId', [])) === quantity(expected.chainId), 'ASSET_CHAIN_CHANGED');
    if (identityGuard) await identityGuard();
  };
  await identity();
  let observedBlockNumber: string | null = null, observedBlockHash: string | null = null;
  const output = (s: AssetReceipt['state'], count = 0n): AssetReceiptObservation => ({ state: s, transactionHash, confirmations: count.toString(),
    blockNumber: observedBlockNumber, blockHash: observedBlockHash, executionEventObserved: s === 'confirmed' });
  const raw = await rpc('eth_getTransactionReceipt', [transactionHash]); if (raw === null) return output('pending');
  const receipt = obj(raw), blockNumber = quantity(receipt.blockNumber), blockHash = hash(receipt.blockHash);
  observedBlockNumber = blockNumber.toString(); observedBlockHash = blockHash;
  check(hash(receipt.transactionHash) === transactionHash, 'ASSET_RECEIPT_BINDING_REFUSED');
  const actual = obj(await rpc('eth_getTransactionByHash', [transactionHash]));
  check(hash(actual.hash) === transactionHash && hash(actual.blockHash) === blockHash && quantity(actual.blockNumber) === blockNumber, 'ASSET_RECEIPT_BINDING_REFUSED');
  check(addr(receipt.from) === expected.from && addr(receipt.to) === expected.to && quantity(receipt.transactionIndex) === quantity(actual.transactionIndex), 'ASSET_RECEIPT_BINDING_REFUSED');
  check(addr(actual.from) === expected.from && addr(actual.to) === expected.to && quantity(actual.nonce) === quantity(expected.nonce) &&
    quantity(actual.value) === quantity(expected.value) && typeof actual.input === 'string' && actual.input.toLowerCase() === expected.data, 'ASSET_TRANSACTION_BINDING_REFUSED');
  if (actual.chainId !== undefined) check(quantity(actual.chainId) === quantity(expected.chainId), 'ASSET_RECEIPT_BINDING_REFUSED');
  const canonical = await rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
  if (canonical === null || hash(obj(canonical).hash) !== blockHash) return output('reorged');
  const head = quantity(await rpc('eth_blockNumber', [])); if (head < blockNumber) return output('reorged');
  const count = head - blockNumber + 1n, status = quantity(receipt.status); check(status === 0n || status === 1n, 'ASSET_RECEIPT_STATUS_REFUSED');
  if (count < confirmations) {
    await identity();
    const current = await rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
    return current === null || hash(obj(current).hash) !== blockHash ? output('reorged') : output('confirming', count);
  }
  if (status === 1n && expected.data.startsWith('0xa9059cbb')) {
    check(expected.data.length === 138 && Array.isArray(receipt.logs), 'ASSET_ERC20_EFFECT_UNOBSERVED');
    const from = `0x${'0'.repeat(24)}${expected.from.slice(2)}`;
    const recipient = `0x${expected.data.slice(10, 74)}`, amount = `0x${expected.data.slice(74, 138)}`;
    const signature = keccak256Utf8('Transfer(address,address,uint256)');
    const effect = receipt.logs.some((raw: unknown) => {
      const log = obj(raw);
      if (log.transactionHash !== transactionHash || log.blockHash !== blockHash || quantity(log.blockNumber) !== blockNumber ||
        quantity(log.transactionIndex) !== quantity(receipt.transactionIndex) || log.removed !== false) return false;
      if (typeof log.address !== 'string' || log.address.toLowerCase() !== expected.to || !Array.isArray(log.topics)) return false;
      const topics = log.topics.map((t: unknown) => typeof t === 'string' ? t.toLowerCase() : '');
      return topics.length === 3 && topics[0] === signature && topics[1] === from && topics[2] === recipient &&
        typeof log.data === 'string' && log.data.toLowerCase() === amount;
    });
    // An exact event is execution evidence, not a promise about future balances
    // or nonstandard fee/rebase economics. A mismatched event stays unresolved.
    check(effect, 'ASSET_ERC20_EFFECT_UNOBSERVED');
  } else if (status === 1n && expected.data !== '0x') {
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
  await identity();
  const finalBlock = await rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
  if (finalBlock === null || hash(obj(finalBlock).hash) !== blockHash) return output('reorged');
  return output(status === 0n ? 'reverted' : 'confirmed', count);
}

export type AssetReplacementObservation = { readonly originalOutcome: 'superseded-not-successful'; readonly replacementHash: string;
  readonly blockNumber: string; readonly blockHash: string; readonly confirmations: string };
/** Proof of a different intent consuming the same actor/chain/nonce, never proof
 * that the original task succeeded. Matching intent uses hash recovery instead. */
export async function proveAssetReplacement(provider: Eip1193Provider, input: AssetTransaction,
  originalTransactionHash: string | null, transactionHash: string, minimumConfirmations: bigint,
  identityGuard?: () => Promise<void>): Promise<AssetReplacementObservation> {
  check(typeof minimumConfirmations === 'bigint' && minimumConfirmations >= 1n, 'ASSET_CONFIRMATIONS_REFUSED');
  const expected = Object.freeze(tx(input)), chainId = quantity(expected.chainId).toString(), h = hash(transactionHash);
  check(originalTransactionHash === null || h !== hash(originalTransactionHash), 'ASSET_SAVED_HASH_NOT_A_REPLACEMENT');
  const rpc = (method: string, params: readonly unknown[]) => controlRpc(provider, method, params);
  const identity = async () => {
    check(quantity(await rpc('eth_chainId', [])) === BigInt(chainId), 'ASSET_CHAIN_CHANGED');
    if (identityGuard) await identityGuard();
  };
  await identity();
  const r = obj(await rpc('eth_getTransactionReceipt', [h])), replacement = obj(await rpc('eth_getTransactionByHash', [h]));
  const number = quantity(r.blockNumber), blockHash = hash(r.blockHash);
  check(hash(r.transactionHash) === h && hash(replacement.hash) === h && hash(replacement.blockHash) === blockHash && quantity(replacement.blockNumber) === number,
    'ASSET_REPLACEMENT_BINDING_REFUSED');
  check(addr(r.from) === expected.from && r.to === replacement.to && quantity(r.transactionIndex) === quantity(replacement.transactionIndex), 'ASSET_REPLACEMENT_BINDING_REFUSED');
  check(addr(replacement.from) === expected.from && quantity(replacement.nonce) === quantity(expected.nonce), 'ASSET_REPLACEMENT_NONCE_REFUSED');
  if (replacement.chainId !== undefined) check(quantity(replacement.chainId) === BigInt(chainId), 'ASSET_REPLACEMENT_BINDING_REFUSED');
  check(replacement.to === null || controlHex(replacement.to, 20), 'ASSET_REPLACEMENT_BINDING_REFUSED');
  check(controlHex(replacement.input), 'ASSET_REPLACEMENT_BINDING_REFUSED');
  check(replacement.to?.toLowerCase() !== expected.to || quantity(replacement.value) !== quantity(expected.value) || replacement.input.toLowerCase() !== expected.data,
    'ASSET_MATCHING_INTENT_RECOVER_HASH');
  check([0n, 1n].includes(quantity(r.status)), 'ASSET_RECEIPT_STATUS_REFUSED');
  const canonical = await rpc('eth_getBlockByNumber', [hex(number), false]);
  check(canonical !== null && hash(obj(canonical).hash) === blockHash, 'ASSET_REPLACEMENT_REORGED');
  const head = quantity(await rpc('eth_blockNumber', []));
  check(head >= number && head - number + 1n >= minimumConfirmations, 'ASSET_REPLACEMENT_CONFIRMATIONS_REQUIRED');
  await identity();
  const finalBlock = await rpc('eth_getBlockByNumber', [hex(number), false]);
  check(finalBlock !== null && hash(obj(finalBlock).hash) === blockHash, 'ASSET_REPLACEMENT_REORGED');
  return { originalOutcome: 'superseded-not-successful', replacementHash: h,
    blockNumber: number.toString(), blockHash, confirmations: (head - number + 1n).toString() };
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
  async #erc20Metadata(contract: string, block: string): Promise<Erc20Metadata> {
    const optional = async (signature: string) => {
      try { return await this.#rpc('eth_call', [{ to: contract, data: encodeCall(signature, [], []) }, block]); }
      catch { return null; }
    };
    const name = metadataText(await optional('name()')), symbol = metadataText(await optional('symbol()'));
    const raw = await optional('decimals()');
    const decimals = controlHex(raw, 32) && BigInt(raw) <= 255n ? Number(BigInt(raw)) : null;
    return Object.freeze({ name, symbol, decimals });
  }
  /** Explicit address on the selected chain; no ERC-165 claim or automatic
   * discovery. Missing optional metadata never invents a symbol or 18 decimals. */
  async erc20Balance(contractInput: string): Promise<Erc20Balance> {
    const contract = inputAddr(contractInput); await this.#identity();
    const header = obj(await this.#rpc('eth_getBlockByNumber', ['latest', false]));
    const blockNumber = hex(quantity(header.number)), blockHash = hash(header.hash);
    const code = await this.#rpc('eth_getCode', [contract, blockNumber]);
    check(controlHex(code) && code.length > 2, 'ASSET_TOKEN_CODE_REQUIRED');
    const balance = await this.#rpc('eth_call', [{ to: contract,
      data: encodeCall('balanceOf(address)', ['address'], [this.actor]) }, blockNumber]);
    check(controlHex(balance, 32), 'ASSET_ERC20_BALANCE_REFUSED');
    const balanceRaw = BigInt(balance).toString(), metadata = await this.#erc20Metadata(contract, blockNumber);
    check(hash(obj(await this.#rpc('eth_getBlockByNumber', [blockNumber, false])).hash) === blockHash, 'ASSET_SNAPSHOT_REORGED');
    await this.#identity();
    return Object.freeze({ chainId: this.chainId, account: this.actor, contract, balanceRaw,
      displayBalance: metadata.decimals === null ? null : formatTokenUnits(balanceRaw, metadata.decimals),
      metadata, codeHash: hashControlBytes(code), blockNumber, blockHash });
  }
  async #nftInterface(standard: NftStandard, contract: string, block: string): Promise<void> {
    // ERC-165 discovery includes its invalid-interface negative probe.
    for (const [iid, expected] of [['0x01ffc9a7', true], ['0xffffffff', false], [standard === 'ERC-721' ? '0x80ac58cd' : '0xd9b67a26', true]] as const) {
      const result = await this.#rpc('eth_call', [{ to: contract, data: encodeCall('supportsInterface(bytes4)', ['bytes4'], [iid]) }, block]);
      check(result === `0x${'0'.repeat(63)}${expected ? '1' : '0'}`, 'ASSET_NFT_INTERFACE_REFUSED');
    }
  }
  /** One explicit contract/token pair on the selected chain, without discovery,
   * metadata, transaction authority or journal access. ERC-721 owner is a separate
   * observation from this account's 0/1 holding; ERC-1155 has no singular owner.
   * This is a pinned chain snapshot, never a register or legal-title claim. */
  async nftHolding(standard: NftStandard, contractInput: string, tokenIdInput: string): Promise<NftHolding> {
    check(standard === 'ERC-721' || standard === 'ERC-1155', 'ASSET_NFT_STANDARD_REFUSED');
    const contract = inputAddr(contractInput), id = uint(tokenIdInput);
    await this.#identity();
    const header = obj(await this.#rpc('eth_getBlockByNumber', ['latest', false]));
    const blockNumber = hex(quantity(header.number)), blockHash = hash(header.hash);
    const code = await this.#rpc('eth_getCode', [contract, blockNumber]);
    check(controlHex(code) && code.length > 2, 'ASSET_TOKEN_CODE_REQUIRED');
    await this.#nftInterface(standard, contract, blockNumber);
    let owner: string | null = null, balanceRaw: string;
    if (standard === 'ERC-721') {
      const raw = await this.#rpc('eth_call', [{ to: contract, data: encodeCall('ownerOf(uint256)', ['uint256'], [id]) }, blockNumber]);
      check(controlHex(raw, 32) && /^0x0{24}/.test(raw) && !/^0x0+$/.test(raw), 'ASSET_NFT_OWNER_REFUSED');
      owner = addr(`0x${raw.slice(26)}`);
      balanceRaw = owner === this.actor ? '1' : '0';
    } else {
      const raw = await this.#rpc('eth_call', [{ to: contract,
        data: encodeCall('balanceOf(address,uint256)', ['address', 'uint256'], [this.actor, id]) }, blockNumber]);
      check(controlHex(raw, 32), 'ASSET_NFT_BALANCE_REFUSED');
      balanceRaw = BigInt(raw).toString();
    }
    const again = obj(await this.#rpc('eth_getBlockByNumber', [blockNumber, false]));
    check(hex(quantity(again.number)) === blockNumber && hash(again.hash) === blockHash, 'ASSET_SNAPSHOT_REORGED');
    await this.#identity(); this.#connectionGuard();
    return Object.freeze({ chainId: this.chainId, account: this.actor, contract, tokenId: id.toString(), standard,
      owner, balanceRaw, codeHash: hashControlBytes(code), blockNumber, blockHash });
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
    let tokenMetadata: Erc20Metadata | null = null, displayAmount: string | null = null;
    if (action.kind === 'native-transfer') {
      obj(action, ['kind', 'recipient', 'valueWei']); value = uint(action.valueWei); check(value > 0n, 'ASSET_AMOUNT_REFUSED');
      check(quantity(await this.#rpc('eth_getBalance', [actor, block])) > value, 'ASSET_BALANCE_OR_GAS_INSUFFICIENT'); amount = value.toString();
      // No calldata and no hidden contract invocation from an alleged ETH transfer.
      check(await this.#rpc('eth_getCode', [recipient, block]) === '0x', 'ASSET_NATIVE_RECIPIENT_EOA_REQUIRED');
    } else if (action.kind === 'erc20-transfer') {
      obj(action, ['kind', 'recipient', 'contract', 'amount']);
      to = inputAddr(action.contract); const n = uint(action.amount); check(n > 0n, 'ASSET_AMOUNT_REFUSED');
      const code = await this.#rpc('eth_getCode', [to, block]);
      check(controlHex(code) && code.length > 2, 'ASSET_TOKEN_CODE_REQUIRED'); codeHash = hashControlBytes(code);
      const balance = await this.#rpc('eth_call', [{ to, data: encodeCall('balanceOf(address)', ['address'], [actor]) }, block]);
      check(controlHex(balance, 32), 'ASSET_ERC20_BALANCE_REFUSED');
      check(BigInt(balance) >= n, 'ASSET_ERC20_BALANCE_INSUFFICIENT');
      tokenMetadata = await this.#erc20Metadata(to, block);
      data = encodeCall('transfer(address,uint256)', ['address', 'uint256'], [recipient, n]);
      asset = 'ERC-20'; amount = n.toString();
      displayAmount = tokenMetadata.decimals === null ? null : formatTokenUnits(amount, tokenMetadata.decimals);
    } else {
      check(action.kind === 'erc721-transfer' || action.kind === 'erc1155-transfer', 'ASSET_ACTION_UNSUPPORTED');
      obj(action, action.kind === 'erc721-transfer' ? ['kind', 'recipient', 'contract', 'tokenId'] : ['kind', 'recipient', 'contract', 'tokenId', 'amount']);
      to = inputAddr(action.contract); const id = uint(action.tokenId); tokenId = id.toString();
      const code = await this.#rpc('eth_getCode', [to, block]); check(controlHex(code) && code.length > 2, 'ASSET_TOKEN_CODE_REQUIRED'); codeHash = hashControlBytes(code);
      const call = (input: string) => this.#rpc('eth_call', [{ to, data: input }, block]);
      await this.#nftInterface(action.kind === 'erc721-transfer' ? 'ERC-721' : 'ERC-1155', to, block);
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
    if (asset === 'ERC-20') {
      // Some widely deployed legacy tokens return no value. Exact true or empty
      // may proceed; false, noncanonical booleans and malformed data never do.
      const result = await this.#rpc('eth_call', [structuredClone(transaction), block]);
      check(result === '0x' || (controlHex(result, 32) && BigInt(result) === 1n), 'ASSET_ERC20_TRANSFER_RETURN_REFUSED');
    }
    // Simulation failure is unavailable, never authorization. Gas fees remain a wallet decision.
    quantity(await this.#rpc('eth_estimateGas', [structuredClone(transaction)]));
    check(hash(obj(await this.#rpc('eth_getBlockByNumber', [block, false])).hash) === blockHash, 'ASSET_SNAPSHOT_REORGED');
    await this.#identity();
    const summary = { requestId: r.requestId as string, claimedAgent: r.agent as string, expiresAt: expiresAt.toString(),
      chain: ASSET_CHAINS[chainId as keyof typeof ASSET_CHAINS], asset, recipient, amount, tokenId, transaction, codeHash, tokenMetadata, displayAmount };
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
      // Clear only for a pre-send failure or a direct EIP-1193 user refusal.
      // Ambiguous provider/transport failures and timeouts remain unknown.
      let sendInvoked = false;
      let transactionHash: string;
      try {
        await this.#identity(); this.#connectionGuard();
        // controlRpc defers the provider call to a microtask; check the generation
        // at that exact boundary too, before marking the send as invoked.
        const guarded = { request: (args: { method: string; params?: readonly unknown[] }) => {
          this.#connectionGuard(); sendInvoked = true; return this.#provider.request(args);
        } };
        transactionHash = hash(await controlRpc(guarded, 'eth_sendTransaction', [structuredClone(fresh.transaction)]));
      } catch (error) {
        const rejected = isControlProviderRejection(error, 'eth_sendTransaction');
        if (!sendInvoked || rejected) {
          let cleared = false;
          try { cleared = await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1,
            status: 'idle', transaction: null, transactionHash: null, digest: null }); }
          catch { /* Preserve an unresolved journal if cancellation was not durably saved. */ }
          check(cleared, rejected ? 'ASSET_REJECTION_PERSISTENCE_UNCERTAIN' : 'ASSET_OPERATION_PERSISTENCE_UNCERTAIN');
        }
        throw error;
      }
      check(await this.#store.compareAndSwap(reserved.revision, { ...reserved, revision: reserved.revision + 1, status: 'submitted', transactionHash }), 'ASSET_PERSISTENCE_UNCERTAIN');
      return transactionHash;
    } finally { this.#busy = false; }
  }
  async #receipt(state: AssetState, transactionHash: string, confirmations: bigint): Promise<AssetReceipt> {
    const provider: Eip1193Provider = { request: ({ method, params }) => this.#rpc(method, params ?? []) };
    const observed = await receiptAssetTransaction(provider, state.transaction!, transactionHash, confirmations, () => this.#identity());
    return { state: observed.state, transactionHash: observed.transactionHash, confirmations: observed.confirmations };
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
    const s = await this.status(); check(s.status !== 'idle' && s.transaction !== null, 'ASSET_ACTIVE_SUBMISSION_REQUIRED');
    const provider: Eip1193Provider = { request: ({ method, params }) => this.#rpc(method, params ?? []) };
    const proof = await proveAssetReplacement(provider, s.transaction, s.transactionHash, transactionHash, minimumConfirmations, () => this.#identity());
    check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1, status: 'idle', transaction: null, transactionHash: null, digest: null }), 'ASSET_OPERATION_CONCURRENT');
    return { originalOutcome: proof.originalOutcome, replacementHash: proof.replacementHash };
  }
  async acknowledge(minimumConfirmations = 2n): Promise<void> {
    const s = await this.status(); check(s.status === 'submitted' && s.transactionHash !== null, 'ASSET_KNOWN_HASH_REQUIRED');
    const receipt = await this.#receipt(s, s.transactionHash, minimumConfirmations);
    check(receipt.state === 'confirmed' || receipt.state === 'reverted', 'ASSET_TERMINAL_RECEIPT_REQUIRED');
    check(await this.#store.compareAndSwap(s.revision, { ...s, revision: s.revision + 1, status: 'idle', transaction: null, transactionHash: null, digest: null }), 'ASSET_OPERATION_CONCURRENT');
  }
}
