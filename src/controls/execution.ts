import type { Eip1193Provider } from '../adapters/signing/eip1193Signer.ts';
import { keccak256Utf8 } from '../codec/keccak.ts';
import { controlHex, controlRpc, hashControlBytes, requireControlAdapter as check, validateControlPin, verifyControlDeployment,
  type ControlDeploymentPin } from './authorization.ts';

/** Internal transport shared by fixed account/payment adapters; not a generic wallet API. */
export type FixedCall = {
  readonly pin: ControlDeploymentPin; readonly guards: readonly ControlDeploymentPin[];
  readonly actor: string; readonly data: string; readonly value: bigint;
  readonly event: { readonly address: string; readonly signature: string; readonly indexed: readonly (string | null)[];
    readonly dataHash: string | null };
};
export type FixedSubmission = {
  readonly schema: '8415-fixed-submission/1'; readonly pin: ControlDeploymentPin;
  readonly guards: readonly ControlDeploymentPin[]; readonly actor: string; readonly value: bigint;
  readonly nonce: bigint;
  readonly transactionHash: string; readonly calldataHash: string; readonly event: FixedCall['event'];
};
export type FixedReceipt = { readonly state: 'pending' | 'reorged' | 'reverted' | 'confirming' | 'confirmed';
  readonly transactionHash: string; readonly blockNumber: bigint | null; readonly blockHash: string | null;
  readonly confirmations: bigint; readonly executionEventObserved: boolean; readonly protocolFinality: 'not-evaluated' };

export function rpcObject(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'CONTROL_RPC_SCHEMA_REFUSED');
  return value as Record<string, unknown>;
}
export function rpcQuantity(value: unknown): bigint {
  check(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'CONTROL_RPC_QUANTITY_REFUSED');
  return BigInt(value);
}
export function uint(value: bigint, positive = false): void {
  check(typeof value === 'bigint' && value >= (positive ? 1n : 0n) && value < 1n << 256n, 'CONTROL_INTEGER_REFUSED');
}
export function address(value: string): void {
  check(controlHex(value, 20) && !/^0x0+$/i.test(value), 'CONTROL_ADDRESS_REFUSED');
}
export function wordAddress(value: string): string {
  address(value); return `0x${'0'.repeat(24)}${value.slice(2).toLowerCase()}`;
}
export function wordUint(value: bigint): string { uint(value); return `0x${value.toString(16).padStart(64, '0')}`; }
export async function actorSelected(provider: Eip1193Provider, actor: string): Promise<void> {
  address(actor);
  const accounts = await controlRpc(provider, 'eth_accounts', []);
  check(Array.isArray(accounts) && typeof accounts[0] === 'string' && accounts[0].toLowerCase() === actor.toLowerCase(),
    'CONTROL_SIGNER_MISMATCH');
}
export async function callWords(provider: Eip1193Provider, to: string, data: string, block: unknown = 'latest'): Promise<unknown> {
  return controlRpc(provider, 'eth_call', [{ to, data }, block]);
}
export async function submitFixed(provider: Eip1193Provider, input: FixedCall,
  beforeSend?: (template: FixedSubmission) => Promise<void>): Promise<FixedSubmission> {
  const c = structuredClone(input);
  check(c.guards.length <= 4 && controlHex(c.data) && c.data.length >= 10, 'CONTROL_FIXED_CALL_REFUSED');
  uint(c.value); address(c.actor); address(c.event.address);
  check(c.event.indexed.length <= 3 && c.event.indexed.every(t => t === null || controlHex(t, 32)) &&
    (c.event.dataHash === null || controlHex(c.event.dataHash, 32)), 'CONTROL_EVENT_CONTRACT_REFUSED');
  const verify = async () => {
    for (const pin of [c.pin, ...c.guards]) {
      check(pin.chainId === c.pin.chainId, 'CONTROL_CHAIN_MISMATCH');
      await verifyControlDeployment(provider, pin);
    }
    await actorSelected(provider, c.actor);
  };
  await verify();
  const tx = { chainId: `0x${c.pin.chainId.toString(16)}`, from: c.actor, to: c.pin.controller,
    data: c.data, value: `0x${c.value.toString(16)}` };
  check(controlHex(await controlRpc(provider, 'eth_call', [tx, 'latest'])), 'CONTROL_PREFLIGHT_RESPONSE_REFUSED');
  await verify();
  const nonce = rpcQuantity(await controlRpc(provider, 'eth_getTransactionCount', [c.actor, 'pending']));
  const template: FixedSubmission = { schema: '8415-fixed-submission/1', pin: c.pin, guards: c.guards, actor: c.actor.toLowerCase(),
    value: c.value, nonce, transactionHash: `0x${'0'.repeat(64)}`, calldataHash: hashControlBytes(c.data), event: c.event };
  if (beforeSend) await beforeSend(structuredClone(template));
  const hash = await controlRpc(provider, 'eth_sendTransaction', [{ ...tx, nonce: `0x${nonce.toString(16)}` }]);
  check(controlHex(hash, 32), 'CONTROL_TRANSACTION_HASH_REFUSED');
  return { ...template, transactionHash: hash.toLowerCase() };
}

/** Reconciles one submission, with no retry/send path. Callers retain only this public journal. */
export async function receiptFixed(provider: Eip1193Provider, input: FixedSubmission, confirmations = 1n): Promise<FixedReceipt> {
  const r = parseFixedSubmission(serializeFixedSubmission(input));
  check(r.schema === '8415-fixed-submission/1' && controlHex(r.transactionHash, 32) && controlHex(r.calldataHash, 32) &&
    r.guards.length <= 4 && confirmations >= 1n && confirmations <= 1024n, 'CONTROL_FIXED_RECEIPT_REFUSED');
  uint(r.value); address(r.actor);
  await verifyControlDeployment(provider, r.pin);
  const base = { transactionHash: r.transactionHash, protocolFinality: 'not-evaluated' as const };
  const raw = await controlRpc(provider, 'eth_getTransactionReceipt', [r.transactionHash]);
  if (raw === null) return { ...base, state: 'pending', blockNumber: null, blockHash: null, confirmations: 0n, executionEventObserved: false };
  const receipt = rpcObject(raw);
  check(controlHex(receipt.blockHash, 32), 'CONTROL_BLOCK_HASH_REFUSED');
  const blockNumber = rpcQuantity(receipt.blockNumber); const blockHash = receipt.blockHash.toLowerCase();
  const at = { ...base, blockNumber, blockHash };
  const matches = (x: unknown, expected: string) => typeof x === 'string' && x.toLowerCase() === expected.toLowerCase();
  const canonical = async () => {
    const head = rpcObject(await controlRpc(provider, 'eth_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]));
    check(rpcQuantity(await controlRpc(provider, 'eth_chainId', [])) === r.pin.chainId, 'CONTROL_CHAIN_MISMATCH');
    return matches(head.hash, blockHash);
  };
  if (!await canonical()) return { ...at, state: 'reorged', confirmations: 0n, executionEventObserved: false };
  check(matches(receipt.transactionHash, r.transactionHash) && matches(receipt.from, r.actor) && matches(receipt.to, r.pin.controller),
    'CONTROL_RECEIPT_BINDING_REFUSED');
  const tx = rpcObject(await controlRpc(provider, 'eth_getTransactionByHash', [r.transactionHash]));
  check(matches(tx.hash, r.transactionHash) && matches(tx.from, r.actor) && matches(tx.to, r.pin.controller) &&
    matches(tx.blockHash, blockHash) && rpcQuantity(tx.blockNumber) === blockNumber &&
    rpcQuantity(tx.chainId) === r.pin.chainId && rpcQuantity(tx.value) === r.value && rpcQuantity(tx.nonce) === r.nonce &&
    controlHex(tx.input) && hashControlBytes(tx.input) === r.calldataHash.toLowerCase(), 'CONTROL_TRANSACTION_BINDING_REFUSED');
  const block = { blockHash, requireCanonical: true };
  for (const pin of [r.pin, ...r.guards]) {
    check(pin.chainId === r.pin.chainId, 'CONTROL_CHAIN_MISMATCH');
    const code = await controlRpc(provider, 'eth_getCode', [pin.controller, block]);
    check(controlHex(code) && hashControlBytes(code) === pin.runtimeCodeHash.toLowerCase(), 'CONTROL_RUNTIME_PIN_MISMATCH');
  }
  const head = rpcQuantity(await controlRpc(provider, 'eth_blockNumber', []));
  check(head >= blockNumber, 'CONTROL_HEAD_BEHIND_RECEIPT');
  const depth = head - blockNumber + 1n;
  const status = rpcQuantity(receipt.status);
  check(status === 0n || status === 1n, 'CONTROL_RECEIPT_STATUS_REFUSED');
  if (status === 0n) return { ...at, state: await canonical() ? 'reverted' : 'reorged', confirmations: depth, executionEventObserved: false };
  check(Array.isArray(receipt.logs), 'CONTROL_RECEIPT_LOGS_REFUSED');
  const topic0 = keccak256Utf8(r.event.signature);
  const logs = receipt.logs.map(rpcObject).filter(log => matches(log.address, r.event.address) &&
    Array.isArray(log.topics) && matches(log.topics[0], topic0));
  check(logs.length === 1, 'CONTROL_EXECUTION_EVENT_MISSING');
  const log = logs[0]!; const topics = log.topics as unknown[];
  check(topics.length === r.event.indexed.length + 1 && topics.every(t => controlHex(t, 32)) &&
    r.event.indexed.every((expected, i) => expected === null || matches(topics[i + 1], expected)) &&
    log.removed !== true && matches(log.blockHash, blockHash) && matches(log.transactionHash, r.transactionHash) &&
    controlHex(log.data) && (r.event.dataHash === null || hashControlBytes(log.data) === r.event.dataHash.toLowerCase()),
    'CONTROL_EXECUTION_EVENT_REFUSED');
  if (!await canonical()) return { ...at, state: 'reorged', confirmations: 0n, executionEventObserved: false };
  return { ...at, state: depth >= confirmations ? 'confirmed' : 'confirming', confirmations: depth, executionEventObserved: true };
}

/** Public-only recovery format. Never serializes arbitrary caller properties. */
export function serializeFixedSubmission(r: FixedSubmission): string {
  const pin = (p: ControlDeploymentPin) => ({ chainId: p.chainId.toString(), controller: p.controller, runtimeCodeHash: p.runtimeCodeHash });
  return JSON.stringify({ schema: r.schema, pin: pin(r.pin), guards: r.guards.map(pin), actor: r.actor,
    value: r.value.toString(), nonce: r.nonce.toString(), transactionHash: r.transactionHash, calldataHash: r.calldataHash,
    event: { address: r.event.address, signature: r.event.signature, indexed: [...r.event.indexed], dataHash: r.event.dataHash } });
}

/** Restored records are hints only: receiptFixed verifies transaction, event and code again. */
export function parseFixedSubmission(json: string): FixedSubmission {
  check(typeof json === 'string' && json.length <= 8192, 'CONTROL_JOURNAL_SIZE_REFUSED');
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new Error('CONTROL_JOURNAL_JSON_REFUSED'); }
  const exact = (input: unknown, keys: readonly string[]) => {
    const o = rpcObject(input);
    check(Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k)), 'CONTROL_JOURNAL_SCHEMA_REFUSED');
    return o;
  };
  const hex = (v: unknown, bytes: number) => {
    check(controlHex(v, bytes), 'CONTROL_JOURNAL_HEX_REFUSED'); return v.toLowerCase();
  };
  const decimal = (v: unknown) => {
    check(typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v), 'CONTROL_JOURNAL_INTEGER_REFUSED');
    const n = BigInt(v); uint(n); return n;
  };
  const pin = (v: unknown): ControlDeploymentPin => {
    const p = exact(v, ['chainId', 'controller', 'runtimeCodeHash']);
    const result = { chainId: decimal(p.chainId), controller: hex(p.controller, 20), runtimeCodeHash: hex(p.runtimeCodeHash, 32) };
    validateControlPin(result); return Object.freeze(result);
  };
  const r = exact(value, ['schema', 'pin', 'guards', 'actor', 'value', 'nonce', 'transactionHash', 'calldataHash', 'event']);
  check(r.schema === '8415-fixed-submission/1' && Array.isArray(r.guards) && r.guards.length <= 4, 'CONTROL_JOURNAL_SCHEMA_REFUSED');
  const p = pin(r.pin); const guards = r.guards.map(pin);
  check(guards.every(g => g.chainId === p.chainId), 'CONTROL_CHAIN_MISMATCH');
  const e = exact(r.event, ['address', 'signature', 'indexed', 'dataHash']);
  const signatures = ['Transfer(address,address,uint256)', 'Funded(bytes32,bytes32,address,address,uint256)',
    'Allocated(bytes32,bytes32,address,uint256,uint8)', 'Withdrawn(bytes32,bytes32,address,uint256,uint8)'];
  check(typeof e.signature === 'string' && signatures.includes(e.signature) && Array.isArray(e.indexed) &&
    e.indexed.length === 3, 'CONTROL_EVENT_CONTRACT_REFUSED');
  // Account/payment adapters always know all indexed values and the event data hash.
  const event = Object.freeze({ address: hex(e.address, 20), signature: e.signature,
    indexed: Object.freeze(e.indexed.map(t => hex(t, 32))), dataHash: hex(e.dataHash, 32) });
  const actor = hex(r.actor, 20); address(actor); address(event.address);
  return Object.freeze({ schema: '8415-fixed-submission/1', pin: p, guards: Object.freeze(guards), actor,
    value: decimal(r.value), nonce: decimal(r.nonce), transactionHash: hex(r.transactionHash, 32), calldataHash: hex(r.calldataHash, 32), event });
}
