/** Read-only receipt observation for the existing bounded operations. No keys,
 * signing, transaction submission, market execution or budget mutation. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeCall, encodeCallWithTail } from '../src/codec/abi.ts';
import { freezeTaskPolicy, freezeChildOperation } from '../src/agent/taskContract.ts';
import { TaskObservationError, freezeTaskObservationPolicy, normalizeObservationAttempt,
  normalizeObservationVerifier, bindTaskObservation } from '../src/agent/receiptObservation.ts';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { ResponsibilityControlClient, decodeControlSequence } from '../src/controls/client.ts';
import { ControlledAccountClient } from '../src/controls/accounts.ts';
import { receiptFixed, proveSupersededNonce, wordAddress, wordUint } from '../src/controls/execution.ts';
import { receiptAssetTransaction, proveAssetReplacement } from '../src/xiongan/externalAssets.ts';

// Exact runtime closure, also used as the implementation identity. Type-only
// modules are compiler inputs, not executed dependencies. Packagers rewrite the
// .ts suffixes together with imports when emitting the same closure to JavaScript.
export const TASK_RECEIPT_RUNTIME_FILES = Object.freeze([
  'server/task-receipt-adapter.mjs', 'src/agent/receiptObservation.ts', 'src/agent/taskContract.ts',
  'src/codec/abi.ts', 'src/codec/keccak.ts', 'src/controls/accounts.ts', 'src/controls/authorization.ts',
  'src/controls/client.ts', 'src/controls/execution.ts', 'src/sdk/errors.ts', 'src/sdk/interfaceIds.ts', 'src/xiongan/address.ts', 'src/xiongan/externalAssets.ts',
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const implementationDigest = `0x${sha256(JSON.stringify(TASK_RECEIPT_RUNTIME_FILES.map(path => ({ path,
  sha256: sha256(readFileSync(new URL(`../${path}`, import.meta.url))) }))))}`;
const identity = normalizeObservationVerifier({ verifierId: '8415wallet:task-receipt', verifierVersion: '1', verifierImplementationDigest: implementationDigest });
const check = (ok, code) => { if (!ok) throw new TaskObservationError(code); };
function fields(value, names) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'TASK_RECEIPT_INPUT_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === names.length && names.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], 'value')), 'TASK_RECEIPT_INPUT_REFUSED');
}
const hex = value => `0x${BigInt(value).toString(16)}`;
const quantity = value => { check(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) && value.length <= 66, 'TASK_RECEIPT_QUANTITY_REFUSED'); return BigInt(value); };
const pin = (value, chainId) => ({ chainId: BigInt(chainId), controller: value.contract, runtimeCodeHash: value.runtimeCodeHash });
function wireMatches(child, to, data, value) {
  check(child.wire.to === to.toLowerCase() && child.wire.calldataHash === hashControlBytes(data) &&
    BigInt(child.wire.valueWei) === BigInt(value), 'TASK_RECEIPT_ENCODING_MISMATCH');
}
/** Server-owned provider and policy are captured once. Browser JSON cannot
 * select an endpoint, reduce depth or replace verifier methods. */
export function createTaskReceiptAdapter({ provider, observationPolicy, now = Date.now }) {
  check(provider && typeof provider.request === 'function' && typeof now === 'function', 'TASK_RECEIPT_CONFIG_REFUSED');
  const request = provider.request.bind(provider), policy = freezeTaskObservationPolicy(observationPolicy);
  const allowed = new Set(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber',
    'eth_blockNumber', 'eth_getCode', 'eth_call', 'eth_getTransactionCount']);
  const readonlyProvider = Object.freeze({ async request({ method, params = [] }) {
    check(allowed.has(method), 'TASK_RECEIPT_RPC_WRITE_REFUSED');
    const result = structuredClone(await request({ method, params: structuredClone(params) }));
    if (method === 'eth_getTransactionReceipt' && result !== null) {
      check(Array.isArray(result.logs), 'TASK_RECEIPT_LOGS_REFUSED');
      const index = quantity(result.transactionIndex), number = quantity(result.blockNumber);
      for (const log of result.logs) check(log.removed === false && log.transactionHash?.toLowerCase() === result.transactionHash?.toLowerCase() &&
        log.blockHash?.toLowerCase() === result.blockHash?.toLowerCase() && quantity(log.blockNumber) === number && quantity(log.transactionIndex) === index,
        'TASK_RECEIPT_LOG_BINDING_REFUSED');
    }
    return result;
  } });
  function assessmentContext(input) {
    fields(input, ['task', 'child', 'executor', 'observationPolicy']);
    const task = freezeTaskPolicy(input.task.policy), child = freezeChildOperation(input.child.child);
    const suppliedPolicy = freezeTaskObservationPolicy(input.observationPolicy), executorDigest = input.executor?.digest;
    check(typeof executorDigest === 'string' && /^0x[0-9a-f]{64}$/.test(executorDigest) && !/^0x0+$/.test(executorDigest), 'TASK_RECEIPT_BINDING_REFUSED');
    check(task.digest === input.task.digest && child.digest === input.child.digest && child.child.taskDigest === task.digest &&
      child.child.operation.chainId === task.policy.chainId && child.child.operation.actor === task.policy.actor, 'TASK_RECEIPT_BINDING_REFUSED');
    check(suppliedPolicy.digest === policy.digest, 'TASK_OBSERVATION_POLICY_MISMATCH');
    check(task.policy.intent.kind === 'exact-operation', 'TASK_ATOMIC_SALE_VERIFIER_NOT_CONNECTED');
    check(JSON.stringify(task.policy.intent.operation) === JSON.stringify(child.child.operation) && child.child.market === null,
      'TASK_RECEIPT_BINDING_REFUSED');
    return { task, child, executorDigest, observationPolicy: policy.policy };
  }
  function context(input) {
    fields(input, ['task', 'child', 'executor', 'attempt', 'observationPolicy']);
    const { executorDigest, ...c } = assessmentContext({ task: input.task, child: input.child, executor: input.executor,
      observationPolicy: input.observationPolicy });
    const attempt = normalizeObservationAttempt(input.attempt);
    check(executorDigest === attempt.executorDigest, 'TASK_RECEIPT_BINDING_REFUSED');
    return { ...c, attempt };
  }
  // A null hash is used only while assessing an unsent child. It is never
  // returned as an observation or passed to a receipt verifier.
  async function submission(c, transactionHash) {
    const child = c.child.child, op = child.operation;
    const base = { from: op.actor, chainId: hex(op.chainId), nonce: hex(child.nonce) };
    let data, to, value = '0';
    switch (op.kind) {
      case 'native-transfer': to = op.recipient; data = '0x'; value = op.valueWei; break;
      case 'erc20-transfer': to = op.contract; data = encodeCall('transfer(address,uint256)', ['address', 'uint256'], [op.recipient, BigInt(op.amount)]); break;
      case 'erc721-transfer': to = op.contract; data = encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [op.actor, op.recipient, BigInt(op.tokenId)]); break;
      case 'erc1155-transfer': to = op.contract; data = encodeCallWithTail('safeTransferFrom(address,address,uint256,uint256,bytes)',
        ['address', 'address', 'uint256', 'uint256', 'bytes'], [op.actor, op.recipient, BigInt(op.tokenId), BigInt(op.amount), '0x']); break;
      case 'create-account': case 'complete': case 'return-hop': {
        const deployment = pin(op.controller, op.chainId);
        data = op.kind === 'create-account' ? encodeCall('createAccount()', [], []) : encodeCall(op.kind === 'complete' ?
          'completeThrough(bytes32,bytes32,uint256)' : 'returnHop(bytes32,bytes32,uint256)',
        ['bytes32', 'bytes32', 'uint256'], [op.sequenceId, op.legId, BigInt(op.expectedRevision)]);
        wireMatches(child, deployment.controller, data, '0');
        return { kind: 'control', record: { schema: '8415-control-submission/1', deployment, kind: op.kind, transactionHash,
          actor: op.actor, nonce: BigInt(child.nonce), calldataHash: hashControlBytes(data),
          sequenceId: op.kind === 'create-account' ? null : op.sequenceId, legId: op.kind === 'return-hop' ? op.legId : null,
          expectedRevision: op.kind === 'create-account' ? null : BigInt(op.expectedRevision), acceptanceHash: null } };
      }
      case 'deposit': case 'standalone-withdraw': {
        const controller = pin(op.controller, op.chainId), token = pin(op.token, op.chainId);
        const account = await new ControlledAccountClient(readonlyProvider, controller).account(op.actor);
        check(account !== null, 'TASK_RECEIPT_ACCOUNT_NOT_ESTABLISHED');
        const deposit = op.kind === 'deposit';
        data = deposit ? encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'],
          [op.actor, account.account, BigInt(op.tokenId)]) : encodeCall('withdrawStandalone(address,uint256,address)',
          ['address', 'uint256', 'address'], [token.controller, BigInt(op.tokenId), op.destination]);
        const target = deposit ? token : account.pin;
        wireMatches(child, target.controller, data, '0');
        return { kind: 'fixed', record: { schema: '8415-fixed-submission/1', pin: target,
          guards: deposit ? [controller, account.pin] : [controller, token], actor: op.actor, value: 0n,
          nonce: BigInt(child.nonce), transactionHash, calldataHash: hashControlBytes(data),
          event: { address: token.controller, signature: 'Transfer(address,address,uint256)',
            indexed: [wordAddress(deposit ? op.actor : account.account), wordAddress(deposit ? account.account : op.destination), wordUint(BigInt(op.tokenId))],
            dataHash: hashControlBytes('0x') } } };
      }
      default: throw new TaskObservationError('TASK_RECEIPT_OPERATION_NOT_SUPPORTED');
    }
    wireMatches(child, to, data, value);
    return { kind: 'asset', record: { ...base, to, data, value: hex(value) } };
  }
  function output(c, observed, replacementHash = null) {
    const time = now(); check(Number.isSafeInteger(time) && time >= 0, 'TASK_RECEIPT_CLOCK_REFUSED');
    const state = observed.state === 'confirmed' ? 'confirmed-at-depth' : observed.state === 'reverted' ? 'reverted-at-depth' : observed.state;
    return bindTaskObservation({ schema: '8415-task-observation/1', taskDigest: c.task.digest, childDigest: c.child.digest,
      chainId: c.task.policy.chainId, actor: c.task.policy.actor, nonce: c.child.child.nonce,
      attemptExecutorDigest: c.attempt.executorDigest, attemptGrantPolicyVersion: c.attempt.grantPolicyVersion,
      originalTransactionHash: c.attempt.transactionHash, observationPolicy: policy.policy, observationPolicyDigest: policy.digest,
      state, blockNumber: observed.blockNumber === null ? null : String(observed.blockNumber), blockHash: observed.blockHash,
      confirmations: state === 'reorged' ? '0' : String(observed.confirmations), replacementHash, observedAt: String(Math.floor(time / 1000)),
      effect: state === 'confirmed-at-depth' && observed.executionEventObserved ? 'exact-operation-observed' : 'not-established',
      protocolFinality: 'not-evaluated', economicFinality: 'not-evaluated', ...identity }, { ...c, verifier: identity });
  }
  async function nativeEoaBinding(op, block) {
    const code = address => readonlyProvider.request({ method: 'eth_getCode', params: [address, block] });
    check(await code(op.actor) === '0x' && await code(op.recipient) === '0x', 'TASK_RECEIPT_NATIVE_EOA_REQUIRED');
  }
  async function assessNativeEoa(op) {
    const rpc = (method, params) => readonlyProvider.request({ method, params });
    check(quantity(await rpc('eth_chainId', [])) === BigInt(op.chainId), 'TASK_RECEIPT_CHAIN_MISMATCH');
    const header = await rpc('eth_getBlockByNumber', ['latest', false]);
    check(header && typeof header.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(header.hash) && !/^0x0+$/i.test(header.hash),
      'TASK_RECEIPT_SNAPSHOT_REFUSED');
    const blockNumber = quantity(header.number), blockHash = header.hash.toLowerCase();
    await nativeEoaBinding(op, { blockHash, requireCanonical: true });
    check(quantity(await rpc('eth_chainId', [])) === BigInt(op.chainId), 'TASK_RECEIPT_CHAIN_MISMATCH');
    const canonical = await rpc('eth_getBlockByNumber', [hex(blockNumber), false]);
    check(canonical && canonical.hash?.toLowerCase() === blockHash && quantity(canonical.number) === blockNumber,
      'TASK_RECEIPT_SNAPSHOT_REORGED');
  }
  async function operationBinding(c, observed) {
    if (observed.state !== 'confirmed') return observed;
    const op = c.child.child.operation, block = { blockHash: observed.blockHash, requireCanonical: true };
    const rpc = (method, params) => readonlyProvider.request({ method, params });
    const actual = await rpc('eth_getTransactionByHash', [c.attempt.transactionHash]);
    check(actual?.hash?.toLowerCase() === c.attempt.transactionHash && actual.blockHash?.toLowerCase() === observed.blockHash &&
      quantity(actual.blockNumber) === BigInt(observed.blockNumber), 'TASK_RECEIPT_BINDING_REFUSED');
    const maximumFee = actual.maxFeePerGas === undefined ? actual.gasPrice : actual.maxFeePerGas;
    check(quantity(actual.gas) <= BigInt(c.child.child.fees.gasLimit) && quantity(maximumFee) <= BigInt(c.child.child.fees.maxFeePerGasWei),
      'TASK_RECEIPT_FEE_BOUND_EXCEEDED');
    if (op.kind === 'native-transfer') {
      await nativeEoaBinding(op, block);
    } else if (op.kind === 'complete' || op.kind === 'return-hop') {
      const sequence = decodeControlSequence(await rpc('eth_call', [{ to: op.controller.contract,
        data: encodeCall('sequence(bytes32)', ['bytes32'], [op.sequenceId]) }, block]));
      check(sequence.token === op.token.contract && sequence.tokenCodeHash === op.token.runtimeCodeHash,
        'TASK_RECEIPT_SEQUENCE_TOKEN_MISMATCH');
      for (const deployed of [op.controller, op.token]) check(hashControlBytes(await rpc('eth_getCode', [deployed.contract, block])) === deployed.runtimeCodeHash,
        'TASK_RECEIPT_RUNTIME_PIN_MISMATCH');
    } else if (op.kind === 'create-account') {
      check(hashControlBytes(await rpc('eth_getCode', [op.controller.contract, block])) === op.controller.runtimeCodeHash,
        'TASK_RECEIPT_RUNTIME_PIN_MISMATCH');
    }
    // Any extra binding reads above must remain anchored to this same chain and
    // canonical block. They are not a new projection or commercial-finality proof.
    check(BigInt(await rpc('eth_chainId', [])) === BigInt(op.chainId), 'TASK_RECEIPT_CHAIN_MISMATCH');
    const canonical = await rpc('eth_getBlockByNumber', [hex(observed.blockNumber), false]);
    if (canonical === null || canonical.hash?.toLowerCase() !== observed.blockHash)
      return { ...observed, state: 'reorged', confirmations: 0n, executionEventObserved: false };
    return observed;
  }
  /** Pre-send capability check, called by the service's captured trusted method.
   * Reconstruct the same supported encoding as observe; no receipt, signer or
   * send is invoked. Dynamic account binding uses existing read-only checks.
   * This establishes observability, not authorization or a predicted result. */
  async function assessChild(input) {
    const c = assessmentContext(input);
    await submission(c, null);
    if (c.child.child.operation.kind === 'native-transfer') await assessNativeEoa(c.child.child.operation);
    return Object.freeze({ taskDigest: c.task.digest, childDigest: c.child.digest, executorDigest: c.executorDigest,
      observationPolicyDigest: policy.digest, ...identity, capability: 'exact-operation-observable' });
  }
  async function observe(input) {
    const c = context(input), submitted = await submission(c, c.attempt.transactionHash), depth = BigInt(policy.policy.minimumConfirmations);
    let observed;
    if (submitted.kind === 'asset') observed = await receiptAssetTransaction(readonlyProvider, submitted.record, c.attempt.transactionHash, depth);
    else if (submitted.kind === 'fixed') observed = await receiptFixed(readonlyProvider, submitted.record, depth);
    else observed = await new ResponsibilityControlClient(readonlyProvider, submitted.record.deployment).receipt(submitted.record, depth);
    return output(c, await operationBinding(c, observed));
  }
  async function observeReplacement(input, replacementHash) {
    const c = context(input), submitted = await submission(c, c.attempt.transactionHash), depth = BigInt(policy.policy.minimumConfirmations);
    check(typeof replacementHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(replacementHash) && !/^0x0+$/i.test(replacementHash) &&
      replacementHash.toLowerCase() !== c.attempt.transactionHash, 'TASK_REPLACEMENT_HASH_REFUSED');
    replacementHash = replacementHash.toLowerCase();
    const original = await observe({ ...c, executor: { digest: c.attempt.executorDigest } });
    check(original.state === 'pending' || original.state === 'reorged', 'TASK_ORIGINAL_MINED_REPLACEMENT_REFUSED');
    const locatorReceipt = await readonlyProvider.request({ method: 'eth_getTransactionReceipt', params: [replacementHash] });
    if (locatorReceipt === null) return output(c, { state: 'pending', blockNumber: null, blockHash: null, confirmations: 0n, executionEventObserved: false });
    let proof;
    try {
    if (submitted.kind === 'asset') proof = await proveAssetReplacement(readonlyProvider, submitted.record, c.attempt.transactionHash, replacementHash, depth);
    else {
      const r = submitted.record;
      proof = await proveSupersededNonce(readonlyProvider, { pin: submitted.kind === 'fixed' ? r.pin : r.deployment,
        actor: r.actor, nonce: r.nonce, value: submitted.kind === 'fixed' ? r.value : 0n,
        calldataHash: r.calldataHash, transactionHash: r.transactionHash }, replacementHash, depth);
    }
    } catch (error) {
      if (['ASSET_REPLACEMENT_REORGED', 'CONTROL_REPLACEMENT_REORGED'].includes(error?.code))
        return output(c, { state: 'reorged', blockNumber: null, blockHash: null, confirmations: 0n, executionEventObserved: false });
      if (['ASSET_REPLACEMENT_CONFIRMATIONS_REQUIRED', 'CONTROL_REPLACEMENT_CONFIRMATIONS_REQUIRED'].includes(error?.code))
        return output(c, { state: 'pending', blockNumber: null, blockHash: null, confirmations: 0n, executionEventObserved: false });
      throw error;
    }
    return output(c, { state: 'superseded-at-depth', blockNumber: proof.blockNumber, blockHash: proof.blockHash,
      confirmations: proof.confirmations, executionEventObserved: false }, proof.replacementHash);
  }
  return Object.freeze({ identity, observationPolicy: policy, assessChild, observe, observeReplacement });
}
