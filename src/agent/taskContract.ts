import { keccak256Utf8 } from '../codec/keccak.ts';
import { isAddressInput } from '../xiongan/address.ts';

/** Pure proposal/data contract only. Importing or calling this module cannot
 * authenticate a person, verify a market, sign, send, persist or grant authority.
 * Task authorization covers a bounded task, not a particular child nonce.
 */
export class TaskContractError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'TaskContractError'; this.code = code; }
}
function refuse(ok: unknown, code: string): asserts ok {
  if (!ok) throw new TaskContractError(code);
}
type RecordValue = Record<string, unknown>;
function object(value: unknown, keys: readonly string[]): RecordValue {
  refuse(value !== null && typeof value === 'object' && !Array.isArray(value), 'TASK_SCHEMA_REFUSED');
  const prototype = Object.getPrototypeOf(value);
  refuse(prototype === Object.prototype || prototype === null, 'TASK_SCHEMA_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  refuse(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key]!, 'value')), 'TASK_SCHEMA_REFUSED');
  return value as RecordValue;
}
function text(value: unknown): string {
  refuse(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), 'TASK_ID_REFUSED');
  return value;
}
function boundedArray(value: unknown, maximum: number): readonly unknown[] {
  refuse(Array.isArray(value) && value.length <= maximum, 'TASK_ARRAY_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  refuse(Reflect.ownKeys(descriptors).length === value.length + 1, 'TASK_ARRAY_REFUSED');
  const copy: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = descriptors[String(i)];
    refuse(descriptor && Object.hasOwn(descriptor, 'value'), 'TASK_ARRAY_REFUSED');
    copy.push(descriptor.value);
  }
  return copy;
}
function uint(value: unknown, positive = false, bits = 256): string {
  refuse(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'TASK_INTEGER_REFUSED');
  const n = BigInt(value);
  refuse(n >= (positive ? 1n : 0n) && n < 1n << BigInt(bits), 'TASK_INTEGER_REFUSED');
  return value;
}
function address(value: unknown): string {
  refuse(isAddressInput(value), 'TASK_ADDRESS_REFUSED');
  return (value as string).toLowerCase();
}
function hash(value: unknown): string {
  refuse(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0+$/i.test(value), 'TASK_HASH_REFUSED');
  return value.toLowerCase();
}
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function json(textValue: string): unknown {
  refuse(typeof textValue === 'string' && textValue.length > 0 && new TextEncoder().encode(textValue).length <= 32768,
    'TASK_SIZE_REFUSED');
  try { return JSON.parse(textValue); } catch { throw new TaskContractError('TASK_JSON_REFUSED'); }
}
const ASSET_CHAINS = ['1', '8453', '11155111', '84532'];
const CONTROL_CHAINS = ['11155111', '560048'];
type Identity = { readonly chainId: string; readonly actor: string };
type Pin = { readonly contract: string; readonly runtimeCodeHash: string };
export type ExistingOperation = Identity & (
  | { readonly kind: 'native-transfer'; readonly recipient: string; readonly valueWei: string }
  | { readonly kind: 'erc20-transfer'; readonly contract: string; readonly recipient: string; readonly amount: string }
  | { readonly kind: 'erc721-transfer'; readonly contract: string; readonly recipient: string; readonly tokenId: string }
  | { readonly kind: 'erc1155-transfer'; readonly contract: string; readonly recipient: string; readonly tokenId: string; readonly amount: string }
  | { readonly kind: 'create-account'; readonly controller: Pin }
  | { readonly kind: 'deposit'; readonly controller: Pin; readonly token: Pin; readonly tokenId: string }
  | { readonly kind: 'standalone-withdraw'; readonly controller: Pin; readonly token: Pin; readonly tokenId: string; readonly destination: string }
  | { readonly kind: 'complete' | 'return-hop'; readonly controller: Pin; readonly token: Pin; readonly sequenceId: string; readonly legId: string; readonly expectedRevision: string }
);
function pin(value: unknown): Pin {
  const r = object(value, ['contract', 'runtimeCodeHash']);
  return { contract: address(r.contract), runtimeCodeHash: hash(r.runtimeCodeHash) };
}
/** Existing operation kinds only; no approval, arbitrary call or sale calldata. */
export function normalizeExistingOperation(value: unknown): ExistingOperation {
  refuse(value !== null && typeof value === 'object', 'TASK_SCHEMA_REFUSED');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  refuse(descriptor && Object.hasOwn(descriptor, 'value'), 'TASK_SCHEMA_REFUSED');
  const kind: unknown = descriptor.value;
  const fields: Record<string, string[]> = {
    'native-transfer': ['recipient', 'valueWei'], 'erc20-transfer': ['contract', 'recipient', 'amount'],
    'erc721-transfer': ['contract', 'recipient', 'tokenId'], 'erc1155-transfer': ['contract', 'recipient', 'tokenId', 'amount'],
    'create-account': ['controller'], 'deposit': ['controller', 'token', 'tokenId'],
    'standalone-withdraw': ['controller', 'token', 'tokenId', 'destination'],
    'complete': ['controller', 'token', 'sequenceId', 'legId', 'expectedRevision'],
    'return-hop': ['controller', 'token', 'sequenceId', 'legId', 'expectedRevision'],
  };
  refuse(typeof kind === 'string' && Object.hasOwn(fields, kind), 'TASK_OPERATION_REFUSED');
  const r = object(value, ['kind', 'chainId', 'actor', ...fields[kind]!]);
  const identity = { chainId: uint(r.chainId, true), actor: address(r.actor) };
  const asset = ['native-transfer', 'erc20-transfer', 'erc721-transfer', 'erc1155-transfer'].includes(kind);
  refuse((asset ? ASSET_CHAINS : CONTROL_CHAINS).includes(identity.chainId), 'TASK_CHAIN_REFUSED');
  let result: ExistingOperation;
  if (asset) {
    const recipient = address(r.recipient);
    refuse(recipient !== identity.actor, 'TASK_SELF_TRANSFER_REFUSED');
    if (kind === 'native-transfer') result = { ...identity, kind, recipient, valueWei: uint(r.valueWei, true) };
    else {
      const contract = address(r.contract);
      if (kind === 'erc20-transfer') result = { ...identity, kind, contract, recipient, amount: uint(r.amount, true) };
      else if (kind === 'erc721-transfer') result = { ...identity, kind, contract, recipient, tokenId: uint(r.tokenId) };
      else result = { ...identity, kind: 'erc1155-transfer', contract, recipient, tokenId: uint(r.tokenId), amount: uint(r.amount, true) };
    }
  } else {
    const controller = pin(r.controller);
    if (kind === 'create-account') result = { ...identity, kind, controller };
    else {
      const token = pin(r.token);
      if (kind === 'deposit') result = { ...identity, kind, controller, token, tokenId: uint(r.tokenId) };
      else if (kind === 'standalone-withdraw') result = { ...identity, kind, controller, token, tokenId: uint(r.tokenId), destination: address(r.destination) };
      else result = { ...identity, kind: kind as 'complete' | 'return-hop', controller, token,
        sequenceId: hash(r.sequenceId), legId: hash(r.legId), expectedRevision: uint(r.expectedRevision) };
    }
  }
  return freeze(result);
}

export type TaskIntent =
  | { readonly kind: 'exact-operation'; readonly operation: ExistingOperation }
  | { readonly kind: 'nft-sale'; readonly direction: 'sell'; readonly standard: 'ERC-721' | 'ERC-1155';
      readonly contract: string; readonly tokenId: string; readonly quantity: string;
      readonly minimumProceeds: { readonly currency: 'USD'; readonly amountMinor: string; readonly minorUnit: 2;
        readonly comparison: 'gt' | 'gte'; readonly basis: 'gross' | 'net' };
      readonly marketAdapters: readonly string[] };
export type TaskPolicy = Identity & {
  readonly schema: '8415-agent-task/1'; readonly taskId: string; readonly tenant: string; readonly origin: string;
  readonly expiresAt: string; readonly fees: { readonly perOperationWei: string; readonly totalWei: string };
  readonly intent: TaskIntent;
};
export type FrozenTask = { readonly policy: TaskPolicy; readonly digest: string };
export function freezeTaskPolicy(value: unknown): FrozenTask {
  const r = object(value, ['schema', 'taskId', 'tenant', 'origin', 'chainId', 'actor', 'expiresAt', 'fees', 'intent']);
  refuse(r.schema === '8415-agent-task/1', 'TASK_SCHEMA_REFUSED');
  const taskId = text(r.taskId), tenant = text(r.tenant), chainId = uint(r.chainId, true), actor = address(r.actor);
  refuse(/^[a-z][a-z0-9-]{0,47}$/.test(tenant), 'TASK_TENANT_REFUSED');
  refuse(typeof r.origin === 'string', 'TASK_ORIGIN_REFUSED');
  let origin: URL; try { origin = new URL(r.origin); } catch { throw new TaskContractError('TASK_ORIGIN_REFUSED'); }
  refuse(origin.origin === r.origin && ['https:', 'http:'].includes(origin.protocol) &&
    (origin.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)), 'TASK_ORIGIN_REFUSED');
  const f = object(r.fees, ['perOperationWei', 'totalWei']);
  const fees = { perOperationWei: uint(f.perOperationWei, true), totalWei: uint(f.totalWei, true) };
  refuse(BigInt(fees.perOperationWei) <= BigInt(fees.totalWei), 'TASK_FEE_LIMIT_REFUSED');
  refuse(r.intent !== null && typeof r.intent === 'object', 'TASK_SCHEMA_REFUSED');
  const kind = Object.getOwnPropertyDescriptor(r.intent, 'kind')?.value;
  let intent: TaskIntent;
  if (kind === 'exact-operation') {
    const i = object(r.intent, ['kind', 'operation']);
    const operation = normalizeExistingOperation(i.operation);
    refuse(operation.chainId === chainId && operation.actor === actor, 'TASK_IDENTITY_REFUSED');
    intent = { kind, operation };
  } else {
    refuse(kind === 'nft-sale' && ASSET_CHAINS.includes(chainId), 'TASK_INTENT_REFUSED');
    const i = object(r.intent, ['kind', 'direction', 'standard', 'contract', 'tokenId', 'quantity', 'minimumProceeds', 'marketAdapters']);
    refuse(i.direction === 'sell' && ['ERC-721', 'ERC-1155'].includes(i.standard as string), 'TASK_INTENT_REFUSED');
    const quantity = uint(i.quantity, true);
    refuse(i.standard !== 'ERC-721' || quantity === '1', 'TASK_NFT_QUANTITY_REFUSED');
    const m = object(i.minimumProceeds, ['currency', 'amountMinor', 'minorUnit', 'comparison', 'basis']);
    refuse(m.currency === 'USD' && m.minorUnit === 2 && ['gt', 'gte'].includes(m.comparison as string) &&
      ['gross', 'net'].includes(m.basis as string), 'TASK_PRICE_POLICY_REFUSED');
    refuse(Array.isArray(i.marketAdapters) && i.marketAdapters.length > 0 && i.marketAdapters.length <= 8,
      'TASK_MARKET_SCOPE_REQUIRED');
    const marketAdapters = boundedArray(i.marketAdapters, 8).map(text).sort();
    refuse(new Set(marketAdapters).size === marketAdapters.length, 'TASK_MARKET_SCOPE_REFUSED');
    intent = { kind, direction: 'sell', standard: i.standard as 'ERC-721' | 'ERC-1155',
      contract: address(i.contract), tokenId: uint(i.tokenId), quantity,
      minimumProceeds: { currency: 'USD', amountMinor: uint(m.amountMinor, true), minorUnit: 2,
        comparison: m.comparison as 'gt' | 'gte', basis: m.basis as 'gross' | 'net' }, marketAdapters };
  }
  const policy: TaskPolicy = { schema: '8415-agent-task/1', taskId, tenant, origin: r.origin, chainId, actor,
    expiresAt: uint(r.expiresAt, true, 64), fees, intent };
  return freeze({ policy, digest: keccak256Utf8(JSON.stringify(policy)) });
}
export function parseTaskPolicy(input: string): FrozenTask { return freezeTaskPolicy(json(input)); }

/** Market inputs are claims/references for a future trusted adapter, NEVER proof.
 * USD valuation and atomic NFT-for-consideration settlement must be verified by
 * an independently configured market adapter (for example an existing market).
 * This wallet contract does not supply a marketplace or a price authority.
 */
export type MarketEvidenceReference = {
  readonly adapterId: string; readonly quoteId: string; readonly buyer: string;
  readonly proceedsMinor: string; readonly currency: 'USD'; readonly minorUnit: 2;
  readonly basis: 'gross' | 'net'; readonly expiresAt: string;
  readonly priceEvidenceRef: string; readonly settlementEvidenceRef: string;
};
export type ChildOperation = {
  readonly schema: '8415-agent-child/1'; readonly operationId: string; readonly taskDigest: string;
  readonly operation: ExistingOperation; readonly nonce: string; readonly expiresAt: string;
  readonly wire: { readonly to: string; readonly calldataHash: string; readonly valueWei: string };
  readonly fees: { readonly gasLimit: string; readonly maxFeePerGasWei: string };
  readonly market: MarketEvidenceReference | null;
};
export type FrozenChild = { readonly child: ChildOperation; readonly digest: string };
export function freezeChildOperation(value: unknown): FrozenChild {
  const r = object(value, ['schema', 'operationId', 'taskDigest', 'operation', 'nonce', 'expiresAt', 'wire', 'fees', 'market']);
  refuse(r.schema === '8415-agent-child/1', 'TASK_SCHEMA_REFUSED');
  const f = object(r.fees, ['gasLimit', 'maxFeePerGasWei']);
  const fees = { gasLimit: uint(f.gasLimit, true), maxFeePerGasWei: uint(f.maxFeePerGasWei, true) };
  const w = object(r.wire, ['to', 'calldataHash', 'valueWei']);
  const wire = { to: address(w.to), calldataHash: hash(w.calldataHash), valueWei: uint(w.valueWei) };
  refuse(BigInt(fees.gasLimit) * BigInt(fees.maxFeePerGasWei) < 1n << 256n, 'TASK_FEE_OVERFLOW_REFUSED');
  let market: MarketEvidenceReference | null = null;
  if (r.market !== null) {
    const m = object(r.market, ['adapterId', 'quoteId', 'buyer', 'proceedsMinor', 'currency', 'minorUnit', 'basis', 'expiresAt', 'priceEvidenceRef', 'settlementEvidenceRef']);
    refuse(m.currency === 'USD' && m.minorUnit === 2 && ['gross', 'net'].includes(m.basis as string), 'TASK_MARKET_CLAIM_REFUSED');
    market = { adapterId: text(m.adapterId), quoteId: text(m.quoteId), buyer: address(m.buyer),
      proceedsMinor: uint(m.proceedsMinor, true), currency: 'USD', minorUnit: 2, basis: m.basis as 'gross' | 'net',
      expiresAt: uint(m.expiresAt, true, 64), priceEvidenceRef: text(m.priceEvidenceRef), settlementEvidenceRef: text(m.settlementEvidenceRef) };
  }
  const child: ChildOperation = { schema: '8415-agent-child/1', operationId: text(r.operationId), taskDigest: hash(r.taskDigest),
    operation: normalizeExistingOperation(r.operation), nonce: uint(r.nonce), expiresAt: uint(r.expiresAt, true, 64), wire, fees, market };
  return freeze({ child, digest: keccak256Utf8(JSON.stringify(child)) });
}
export function parseChildOperation(input: string): FrozenChild { return freezeChildOperation(json(input)); }
function taskCopy(input: FrozenTask): FrozenTask {
  const copy = freezeTaskPolicy(input.policy); refuse(copy.digest === input.digest, 'TASK_DIGEST_MISMATCH'); return copy;
}
function childCopy(input: FrozenChild): FrozenChild {
  const copy = freezeChildOperation(input.child); refuse(copy.digest === input.digest, 'TASK_CHILD_DIGEST_MISMATCH'); return copy;
}
function nowValue(now: bigint): void { refuse(typeof now === 'bigint' && now >= 0n && now < 1n << 64n, 'TASK_CLOCK_REFUSED'); }
export type ScopeAssessment = {
  readonly state: 'outside-declared-scope' | 'requires-trusted-verification';
  readonly reasons: readonly string[]; readonly executable: false;
  readonly requiredCapabilities: readonly string[];
};
/** Checks declared bounds only. Even a perfectly matching quote is not verified. */
export function assessChildScope(taskInput: FrozenTask, childInput: FrozenChild, now: bigint): ScopeAssessment {
  const { policy: t, digest } = taskCopy(taskInput), { child: c } = childCopy(childInput); nowValue(now);
  const reasons: string[] = [];
  const required = ['TASK_AUTHORIZATION_VERIFIER', 'OPERATION_ENCODING_VERIFIER', 'USER_CONTROLLED_SIGNER'];
  if (c.taskDigest !== digest || c.operation.chainId !== t.chainId || c.operation.actor !== t.actor) reasons.push('TASK_BINDING_MISMATCH');
  if (BigInt(t.expiresAt) <= now || BigInt(c.expiresAt) <= now || BigInt(c.expiresAt) > BigInt(t.expiresAt) ||
    BigInt(c.expiresAt) - now > 900n) reasons.push('TASK_EXPIRED_OR_CHILD_WINDOW_REFUSED');
  if (BigInt(c.fees.gasLimit) * BigInt(c.fees.maxFeePerGasWei) > BigInt(t.fees.perOperationWei)) reasons.push('TASK_CHILD_FEE_LIMIT');
  const op = c.operation;
  if (op.kind === 'native-transfer' ? c.wire.to !== op.recipient || c.wire.valueWei !== op.valueWei : c.wire.valueWei !== '0') reasons.push('TASK_WIRE_VALUE_OUTSIDE_SCOPE');
  // Hash the empty bytes, not the UTF-8 spelling "0x". Native transfers cannot
  // conceal a contract call behind otherwise matching recipient/value fields.
  if (op.kind === 'native-transfer' && c.wire.calldataHash !== keccak256Utf8('')) reasons.push('TASK_NATIVE_CALLDATA_REFUSED');
  if ((op.kind === 'erc20-transfer' || op.kind === 'erc721-transfer' || op.kind === 'erc1155-transfer') && c.wire.to !== op.contract) reasons.push('TASK_WIRE_TARGET_OUTSIDE_SCOPE');
  if ((op.kind === 'create-account' || op.kind === 'complete' || op.kind === 'return-hop') && c.wire.to !== op.controller.contract) reasons.push('TASK_WIRE_TARGET_OUTSIDE_SCOPE');
  if (op.kind === 'deposit' && c.wire.to !== op.token.contract) reasons.push('TASK_WIRE_TARGET_OUTSIDE_SCOPE');
  // The account address is resolved from the pinned controller and checked
  // against owner/controller/registration/runtime by ControlledAccountClient.
  // It cannot be derived from, or authenticated by, a caller's wire target.
  if (op.kind === 'standalone-withdraw') required.push('CONTROL_ACCOUNT_BINDING_VERIFIER');
  if (t.intent.kind === 'exact-operation') {
    if (JSON.stringify(t.intent.operation) !== JSON.stringify(c.operation) || c.market !== null) reasons.push('TASK_OPERATION_OUTSIDE_SCOPE');
  } else {
    required.push('MARKET_PRICE_VERIFIER', 'ATOMIC_SALE_SETTLEMENT_VERIFIER');
    const i = t.intent, op = c.operation, m = c.market;
    if (op.kind !== (i.standard === 'ERC-721' ? 'erc721-transfer' : 'erc1155-transfer') ||
      !('contract' in op) || op.contract !== i.contract || !('tokenId' in op) || op.tokenId !== i.tokenId ||
      (op.kind === 'erc1155-transfer' && op.amount !== i.quantity)) reasons.push('TASK_NFT_OUTSIDE_SCOPE');
    if (!m) reasons.push('TASK_MARKET_EVIDENCE_REQUIRED');
    else {
      if (!i.marketAdapters.includes(m.adapterId) || !('recipient' in op) || op.recipient !== m.buyer ||
        m.basis !== i.minimumProceeds.basis || BigInt(m.expiresAt) <= now || BigInt(c.expiresAt) > BigInt(m.expiresAt)) reasons.push('TASK_MARKET_CLAIM_OUTSIDE_SCOPE');
      const amount = BigInt(m.proceedsMinor), floor = BigInt(i.minimumProceeds.amountMinor);
      if (i.minimumProceeds.comparison === 'gt' ? amount <= floor : amount < floor) reasons.push('TASK_PRICE_BELOW_REQUIRED_BOUND');
    }
  }
  return freeze({ state: reasons.length ? 'outside-declared-scope' : 'requires-trusted-verification', reasons,
    executable: false, requiredCapabilities: required });
}

export type AuthorizationReference = {
  readonly schema: '8415-task-authorization-reference/1'; readonly taskDigest: string; readonly reference: string;
  readonly status: 'pending' | 'authorized' | 'suspended' | 'revoked' | 'expired';
  readonly grantPolicyVersion: string; readonly credentialRevisionAtApproval: string;
};
/** An untrusted status/reference, not an authorization capability. Credential
 * revision identifies the factor used; policy version governs grant lifecycle.
 * Factor replacement must not silently expand or reapprove a historical task.
 */
export function normalizeAuthorizationReference(value: unknown): AuthorizationReference {
  const r = object(value, ['schema', 'taskDigest', 'reference', 'status', 'grantPolicyVersion', 'credentialRevisionAtApproval']);
  refuse(r.schema === '8415-task-authorization-reference/1' && ['pending', 'authorized', 'suspended', 'revoked', 'expired'].includes(r.status as string), 'TASK_AUTHORIZATION_REFERENCE_REFUSED');
  return freeze({ schema: '8415-task-authorization-reference/1', taskDigest: hash(r.taskDigest), reference: text(r.reference),
    status: r.status as AuthorizationReference['status'], grantPolicyVersion: uint(r.grantPolicyVersion),
    credentialRevisionAtApproval: uint(r.credentialRevisionAtApproval) });
}
export function executionAvailability(task: FrozenTask, child: FrozenChild, reference: unknown, now: bigint) {
  const scope = assessChildScope(task, child, now);
  const r = reference === null ? null : normalizeAuthorizationReference(reference);
  const reasons = [...scope.reasons];
  if (r === null || r.taskDigest !== task.digest || r.status !== 'authorized') reasons.push('TASK_AUTHORIZATION_NOT_AVAILABLE');
  // No caller-supplied status or fabricated reference can connect a verifier.
  reasons.push(...scope.requiredCapabilities.map(capability => `${capability}_NOT_CONNECTED`));
  return freeze({ executable: false as const, reasons });
}

export type Reservation = {
  readonly operationId: string; readonly childDigest: string; readonly feeWei: string; readonly units: string;
  readonly status: 'reserved' | 'outcome-unknown' | 'submitted' | 'cancelled'; readonly transactionHash: string | null;
};
export type TaskBudget = {
  readonly schema: '8415-task-budget/1'; readonly taskDigest: string; readonly revision: string;
  readonly reservations: readonly Reservation[];
};
/** The next service must use one durable CAS/transaction for authorization
 * consumption and this proposal. These pure values alone authorize nothing.
 */
export interface TaskBudgetJournal {
  read(taskDigest: string): Promise<TaskBudget | null>;
  compareAndSwap(taskDigest: string, expectedRevision: string | null, proposal: TaskBudget): Promise<boolean>;
}
/** Transport page size is a parser/storage concern, never a task-history limit.
 * Keep cancelled operation IDs in durable history or an equivalent unique index.
 * All pages must be read from one immutable revision, including archived pages.
 */
export type TaskBudgetPage = {
  readonly schema: '8415-task-budget-page/1'; readonly taskDigest: string; readonly revision: string;
  readonly cursor: string | null; readonly nextCursor: string | null;
  readonly reservations: readonly Reservation[];
};
export interface PagedTaskBudgetJournal {
  readHead(taskDigest: string): Promise<{ readonly taskDigest: string; readonly revision: string } | null>;
  readPage(taskDigest: string, revision: string, cursor: string | null): Promise<TaskBudgetPage>;
  /** Must include archived/cancelled records, in the same transaction as CAS. */
  containsOperation(taskDigest: string, revision: string, operationId: string): Promise<boolean>;
  compareAndSwap(taskDigest: string, expectedRevision: string | null, proposal: TaskBudget): Promise<boolean>;
}
export function emptyTaskBudget(task: FrozenTask): TaskBudget {
  return freeze({ schema: '8415-task-budget/1', taskDigest: taskCopy(task).digest, revision: '0', reservations: [] });
}
export function normalizeTaskBudget(value: unknown): TaskBudget {
  const r = object(value, ['schema', 'taskDigest', 'revision', 'reservations']);
  refuse(r.schema === '8415-task-budget/1' && Array.isArray(r.reservations), 'TASK_BUDGET_SCHEMA_REFUSED');
  // This is a complete logical snapshot, not one untrusted network message.
  // Transport uses bounded pages below; task history has no arbitrary count cap.
  const reservations: Reservation[] = boundedArray(r.reservations, Number.MAX_SAFE_INTEGER).map(value => {
    const a = object(value, ['operationId', 'childDigest', 'feeWei', 'units', 'status', 'transactionHash']);
    refuse(['reserved', 'outcome-unknown', 'submitted', 'cancelled'].includes(a.status as string), 'TASK_BUDGET_STATE_REFUSED');
    const transactionHash = a.transactionHash === null ? null : hash(a.transactionHash);
    refuse((a.status === 'submitted') === (transactionHash !== null), 'TASK_BUDGET_STATE_REFUSED');
    return { operationId: text(a.operationId), childDigest: hash(a.childDigest), feeWei: uint(a.feeWei, true),
      units: uint(a.units, true), status: a.status as Reservation['status'], transactionHash };
  });
  refuse(new Set(reservations.map(r => r.operationId)).size === reservations.length, 'TASK_DUPLICATE_OPERATION_REFUSED');
  return freeze({ schema: '8415-task-budget/1', taskDigest: hash(r.taskDigest), revision: uint(r.revision), reservations });
}
export function normalizeTaskBudgetPage(value: unknown): TaskBudgetPage {
  const r = object(value, ['schema', 'taskDigest', 'revision', 'cursor', 'nextCursor', 'reservations']);
  refuse(r.schema === '8415-task-budget-page/1', 'TASK_BUDGET_PAGE_REFUSED');
  const cursor = r.cursor === null ? null : text(r.cursor), nextCursor = r.nextCursor === null ? null : text(r.nextCursor);
  refuse(nextCursor === null || nextCursor !== cursor, 'TASK_BUDGET_PAGE_REFUSED');
  const reservations = boundedArray(r.reservations, 128);
  refuse(nextCursor === null || reservations.length > 0, 'TASK_BUDGET_PAGE_REFUSED');
  const budget = normalizeTaskBudget({ schema: '8415-task-budget/1', taskDigest: r.taskDigest, revision: r.revision, reservations });
  return freeze({ schema: '8415-task-budget-page/1', taskDigest: budget.taskDigest, revision: budget.revision,
    cursor, nextCursor, reservations: budget.reservations });
}
/** Parse a bounded transport page. A store can return smaller pages to fit the
 * byte limit; neither bound permits truncating the logical reservation history.
 */
export function parseTaskBudgetPage(input: string): TaskBudgetPage { return normalizeTaskBudgetPage(json(input)); }
export function assembleTaskBudgetPages(input: readonly TaskBudgetPage[]): TaskBudget {
  const pages = boundedArray(input, Number.MAX_SAFE_INTEGER).map(normalizeTaskBudgetPage);
  refuse(pages.length > 0, 'TASK_BUDGET_PAGE_CHAIN_REFUSED');
  const first = pages[0]!, reservations: Reservation[] = [], cursors = new Set<string>();
  let expectedCursor: string | null = null;
  pages.forEach((page, index) => {
    refuse(page.taskDigest === first.taskDigest && page.revision === first.revision &&
      page.cursor === expectedCursor && (index === pages.length - 1 ? page.nextCursor === null : page.nextCursor !== null),
      'TASK_BUDGET_PAGE_CHAIN_REFUSED');
    if (page.cursor !== null) { refuse(!cursors.has(page.cursor), 'TASK_BUDGET_PAGE_CHAIN_REFUSED'); cursors.add(page.cursor); }
    reservations.push(...page.reservations); expectedCursor = page.nextCursor;
  });
  return normalizeTaskBudget({ schema: '8415-task-budget/1', taskDigest: first.taskDigest, revision: first.revision, reservations });
}
function budgetCopy(value: TaskBudget, expectedRevision: string): TaskBudget {
  const budget = normalizeTaskBudget(value);
  refuse(budget.revision === uint(expectedRevision), 'TASK_BUDGET_REVISION_CONFLICT');
  refuse(BigInt(budget.revision) < (1n << 256n) - 1n, 'TASK_BUDGET_REVISION_EXHAUSTED');
  return budget;
}
function advance(budget: TaskBudget, reservations: readonly Reservation[]): TaskBudget {
  return freeze({ ...budget, revision: (BigInt(budget.revision) + 1n).toString(), reservations });
}
/** Reserve a non-executing proposal. The actual adapter must separately prove
 * task authority, market facts and signing capability before attempting a send.
 */
export function reserveTaskBudget(task: FrozenTask, child: FrozenChild, input: TaskBudget, expectedRevision: string, now: bigint): TaskBudget {
  const t = taskCopy(task), c = childCopy(child), budget = budgetCopy(input, expectedRevision);
  refuse(assessChildScope(t, c, now).state !== 'outside-declared-scope', 'TASK_CHILD_OUTSIDE_SCOPE');
  refuse(budget.taskDigest === t.digest, 'TASK_BUDGET_BINDING_REFUSED');
  refuse(!budget.reservations.some(r => r.operationId === c.child.operationId), 'TASK_DUPLICATE_OPERATION_REFUSED');
  const fees = BigInt(c.child.fees.gasLimit) * BigInt(c.child.fees.maxFeePerGasWei);
  const units = t.policy.intent.kind === 'nft-sale' && c.child.operation.kind === 'erc1155-transfer' ? BigInt(c.child.operation.amount) : 1n;
  const maxUnits = t.policy.intent.kind === 'nft-sale' ? BigInt(t.policy.intent.quantity) : 1n;
  refuse(budget.reservations.reduce((n, r) => n + (r.status === 'cancelled' ? 0n : BigInt(r.feeWei)), fees) <= BigInt(t.policy.fees.totalWei), 'TASK_TOTAL_FEE_LIMIT');
  refuse(budget.reservations.reduce((n, r) => n + (r.status === 'cancelled' ? 0n : BigInt(r.units)), units) <= maxUnits, 'TASK_TOTAL_ASSET_LIMIT');
  return advance(budget, [...budget.reservations, { operationId: c.child.operationId, childDigest: c.digest,
    feeWei: fees.toString(), units: units.toString(), status: 'reserved', transactionHash: null }]);
}
/** Persist this state BEFORE the only signer call. Pending/unknown claims keep
 * their entire reservation across reloads; no timeout-based release exists.
 */
export function markTaskSendAttempt(input: TaskBudget, operationId: string, childDigest: string, expectedRevision: string): TaskBudget {
  const budget = budgetCopy(input, expectedRevision);
  const selected = budget.reservations.find(r => r.operationId === text(operationId));
  refuse(selected?.childDigest === hash(childDigest) && selected.status === 'reserved', 'TASK_SEND_ATTEMPT_REFUSED');
  return advance(budget, budget.reservations.map(r => r === selected ? { ...r, status: 'outcome-unknown' as const } : r));
}
export function noteTaskSubmission(input: TaskBudget, operationId: string, childDigest: string, transactionHash: string, expectedRevision: string): TaskBudget {
  const budget = budgetCopy(input, expectedRevision), tx = hash(transactionHash);
  const selected = budget.reservations.find(r => r.operationId === text(operationId));
  refuse(selected?.childDigest === hash(childDigest) && selected.status === 'outcome-unknown', 'TASK_SUBMISSION_STATE_REFUSED');
  return advance(budget, budget.reservations.map(r => r === selected ? { ...r, status: 'submitted' as const, transactionHash: tx } : r));
}
/** Only a proposal never advanced to the send boundary can be discarded. */
export function cancelUnattemptedReservation(input: TaskBudget, operationId: string, childDigest: string, expectedRevision: string): TaskBudget {
  const budget = budgetCopy(input, expectedRevision);
  const selected = budget.reservations.find(r => r.operationId === text(operationId));
  refuse(selected?.childDigest === hash(childDigest) && selected.status === 'reserved', 'TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE');
  // Keep the operation ID as a tombstone; a changed child must use a new ID.
  return advance(budget, budget.reservations.map(r => r === selected ? { ...r, status: 'cancelled' as const } : r));
}
/** No trusted receipt verifier is connected in this pure-core stage. A hash,
 * status object, timeout or claimed cancellation cannot settle/release a budget.
 */
export function reconcileTaskBudget(_input: TaskBudget, _untrustedEvidence: unknown): never {
  throw new TaskContractError('TASK_RECEIPT_VERIFIER_NOT_CONNECTED');
}
