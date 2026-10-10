import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskReceiptAdapter, TASK_RECEIPT_RUNTIME_FILES } from '../server/task-receipt-adapter.mjs';
import { freezeTaskPolicy, freezeChildOperation, emptyTaskBudget, reserveTaskBudget, markTaskSendAttempt,
  noteTaskSubmission, reconcileTaskBudget } from '../src/agent/taskContract.ts';
import { bindTaskObservation, normalizeTaskObservation, freezeTaskObservationPolicy } from '../src/agent/receiptObservation.ts';
import { hashControlBytes } from '../src/controls/authorization.ts';
import { encodeCall, encodeCallWithTail, encodeWords } from '../src/codec/abi.ts';
import { keccak256Utf8 } from '../src/codec/keccak.ts';

const a = digit => `0x${digit.repeat(40)}`, h = digit => `0x${digit.repeat(64)}`;
const actor = a('1'), recipient = a('2'), token = a('3'), controller = a('4'), account = a('5');
const transactionHash = h('a'), blockHash = h('b'), replacementHash = h('c'), executorDigest = h('d');
const runtimeCode = '0x6000', runtimeCodeHash = hashControlBytes(runtimeCode), chainId = '11155111';
const wordAddress = value => `0x${'0'.repeat(24)}${value.slice(2)}`;
const word = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const chainHex = `0x${BigInt(chainId).toString(16)}`;
const operationKinds = ['native-transfer', 'erc20-transfer', 'erc721-transfer', 'erc1155-transfer', 'create-account', 'deposit', 'standalone-withdraw', 'complete', 'return-hop'];
function fixture(kind = 'native-transfer') {
  const identity = { chainId, actor }, tokenPin = { contract: token, runtimeCodeHash }, controllerPin = { contract: controller, runtimeCodeHash };
  const operations = {
    'native-transfer': { ...identity, kind, recipient, valueWei: '100' },
    'erc20-transfer': { ...identity, kind, contract: token, recipient, amount: '7' },
    'erc721-transfer': { ...identity, kind, contract: token, recipient, tokenId: '7' },
    'erc1155-transfer': { ...identity, kind, contract: token, recipient, tokenId: '7', amount: '3' },
    'create-account': { ...identity, kind, controller: controllerPin },
    deposit: { ...identity, kind, controller: controllerPin, token: tokenPin, tokenId: '7' },
    'standalone-withdraw': { ...identity, kind, controller: controllerPin, token: tokenPin, tokenId: '7', destination: recipient },
    complete: { ...identity, kind, controller: controllerPin, token: tokenPin, sequenceId: h('6'), legId: h('7'), expectedRevision: '3' },
    'return-hop': { ...identity, kind, controller: controllerPin, token: tokenPin, sequenceId: h('6'), legId: h('7'), expectedRevision: '3' },
  };
  const operation = operations[kind];
  let to = recipient, value = '0x0', data;
  if (kind === 'native-transfer') { data = '0x'; value = '0x64'; }
  else if (kind === 'erc20-transfer') { to = token; data = encodeCall('transfer(address,uint256)', ['address', 'uint256'], [recipient, 7n]); }
  else if (kind === 'erc721-transfer' || kind === 'deposit') { to = token; data = encodeCall('safeTransferFrom(address,address,uint256)', ['address', 'address', 'uint256'], [actor, kind === 'deposit' ? account : recipient, 7n]); }
  else if (kind === 'erc1155-transfer') { to = token; data = encodeCallWithTail('safeTransferFrom(address,address,uint256,uint256,bytes)', ['address', 'address', 'uint256', 'uint256', 'bytes'], [actor, recipient, 7n, 3n, '0x']); }
  else if (kind === 'standalone-withdraw') { to = account; data = encodeCall('withdrawStandalone(address,uint256,address)', ['address', 'uint256', 'address'], [token, 7n, recipient]); }
  else { to = controller; data = kind === 'create-account' ? encodeCall('createAccount()', [], []) : encodeCall(kind === 'complete' ? 'completeThrough(bytes32,bytes32,uint256)' : 'returnHop(bytes32,bytes32,uint256)', ['bytes32', 'bytes32', 'uint256'], [h('6'), h('7'), 3n]); }
  const task = freezeTaskPolicy({ schema: '8415-agent-task/1', taskId: 'receipt-test', tenant: 'default', origin: 'https://wallet.example',
    chainId, actor, expiresAt: '2000', fees: { perOperationWei: '1000000', totalWei: '1000000' }, intent: { kind: 'exact-operation', operation } });
  const child = freezeChildOperation({ schema: '8415-agent-child/1', operationId: 'receipt-op', taskDigest: task.digest,
    operation, nonce: '1', expiresAt: '1500', wire: { to, calldataHash: hashControlBytes(data), valueWei: BigInt(value).toString() },
    fees: { gasLimit: '100000', maxFeePerGasWei: '10' }, market: null });
  const input = { task, child, executor: { digest: executorDigest }, attempt: { executorDigest, grantPolicyVersion: '1', transactionHash }, observationPolicy: { minimumConfirmations: '2' } };
  const logs = [];
  const log = (address, signature, topics, data) => ({ address, transactionHash, blockHash, blockNumber: '0x64', transactionIndex: '0x0', removed: false,
    topics: [keccak256Utf8(signature), ...topics], data });
  if (kind === 'erc20-transfer') logs.push(log(token, 'Transfer(address,address,uint256)', [wordAddress(actor), wordAddress(recipient)], word(7)));
  else if (['erc721-transfer', 'deposit', 'standalone-withdraw'].includes(kind)) logs.push(log(token, 'Transfer(address,address,uint256)',
    [wordAddress(kind === 'standalone-withdraw' ? account : actor), wordAddress(kind === 'deposit' ? account : recipient), word(7)], '0x'));
  else if (kind === 'erc1155-transfer') logs.push(log(token, 'TransferSingle(address,address,address,uint256,uint256)', [wordAddress(actor), wordAddress(actor), wordAddress(recipient)], encodeWords(['uint256', 'uint256'], [7n, 3n])));
  else if (kind === 'create-account') logs.push(log(controller, 'AccountCreated(address,address)', [wordAddress(actor), wordAddress(account)], '0x'));
  else if (kind === 'complete') logs.push(log(controller, 'PrefixCompleted(bytes32,uint256,uint64,uint256)', [h('6')], encodeWords(['uint256', 'uint64', 'uint256'], [1n, 1n, 4n])));
  else if (kind === 'return-hop') logs.push(log(controller, 'ReturnHopCompleted(bytes32,bytes32,address,address,uint256)', [h('6'), h('7')], encodeWords(['address', 'address', 'uint256'], [account, recipient, 4n])));
  const tx = { hash: transactionHash, from: actor, to, value, input: data, nonce: '0x1', chainId: chainHex, blockHash, blockNumber: '0x64', transactionIndex: '0x0', gas: '0x186a0', maxFeePerGas: '0xa' };
  const receipt = { transactionHash, from: actor, to, blockHash, blockNumber: '0x64', transactionIndex: '0x0', status: '0x1', logs };
  const flags = { pending: false, head: '0x65', canonical: blockHash, chain: chainHex, sequenceToken: token, sequenceCodeHash: runtimeCodeHash,
    code: runtimeCode, actorCode: '0x', recipientCode: '0x', replacementPending: false, replaceNonce: '0x1', replaceActor: actor, replaceSameIntent: false, reorgOnBlockRead: Infinity };
  const calls = []; let blockReads = 0;
  const provider = { async request({ method, params = [] }) {
    calls.push({ method, params });
    if (method === 'eth_chainId') return flags.chain;
    if (method === 'eth_getCode') return params[0] === actor ? flags.actorCode : params[0] === recipient ? flags.recipientCode : flags.code;
    if (method === 'eth_getBlockByNumber') { blockReads++; return flags.canonical === null ? null : { number: '0x64', hash: blockReads >= flags.reorgOnBlockRead ? h('e') : flags.canonical }; }
    if (method === 'eth_blockNumber') return flags.head;
    if (method === 'eth_getTransactionCount') return '0x2';
    if (method === 'eth_getTransactionByHash') return params[0] === replacementHash ? { ...tx, hash: replacementHash, from: flags.replaceActor, nonce: flags.replaceNonce,
      ...(flags.replaceSameIntent ? {} : { to: actor, input: '0x', value: '0x0' }) } : structuredClone(tx);
    if (method === 'eth_getTransactionReceipt') return params[0] === replacementHash ? flags.replacementPending ? null : { ...receipt, transactionHash: replacementHash, from: flags.replaceActor,
      to: flags.replaceSameIntent ? tx.to : actor, logs: [] } : flags.pending ? null : structuredClone(receipt);
    if (method === 'eth_call') {
      const call = params[0];
      if (call.data === encodeCall('accountOf(address)', ['address'], [actor])) return wordAddress(account);
      if (call.data === encodeCall('registeredAccount(address)', ['address'], [account])) return word(1);
      if (call.data === encodeCall('owner()', [], [])) return wordAddress(actor);
      if (call.data === encodeCall('controller()', [], [])) return wordAddress(controller);
      if (call.data === encodeCall('sequence(bytes32)', ['bytes32'], [h('6')])) return encodeWords(
        ['address', 'uint256', 'address', 'address', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32', 'bool'],
        [flags.sequenceToken, 7n, actor, account, recipient, h('8'), h('9'), flags.sequenceCodeHash, 4n, 1n, 1n, 0n, 1n, h('a'), false]);
    }
    throw new Error(`Unexpected read-only fixture method ${method}`);
  } };
  const adapter = createTaskReceiptAdapter({ provider, observationPolicy: input.observationPolicy, now: () => 2500000 });
  return { input, adapter, flags, tx, receipt, calls, provider };
}
for (const kind of operationKinds) test(`${kind}: exact canonical result verified at configured depth after task expiry`, async () => {
  const f = fixture(kind), result = await f.adapter.observe(f.input);
  assert.equal(result.state, 'confirmed-at-depth'); assert.equal(result.effect, 'exact-operation-observed');
  assert.equal(result.observedAt, '2500'); assert.equal(result.protocolFinality, 'not-evaluated');
  assert.equal(result.economicFinality, 'not-evaluated'); assert.equal(result.observationPolicy.minimumConfirmations, '2');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.observationPolicy));
  assert.equal(result.verifierImplementationDigest, f.adapter.identity.verifierImplementationDigest);
  assert.ok(!f.calls.some(call => /send|sign|accounts/i.test(call.method)));
});
for (const kind of operationKinds) test(`${kind}: pending, confirming, reverted and reorg cannot establish an effect`, async () => {
  const f = fixture(kind); f.flags.pending = true;
  assert.equal((await f.adapter.observe(f.input)).state, 'pending'); f.flags.pending = false; f.flags.head = '0x64';
  assert.equal((await f.adapter.observe(f.input)).state, 'confirming'); f.flags.head = '0x65'; f.receipt.status = '0x0';
  assert.equal((await f.adapter.observe(f.input)).state, 'reverted-at-depth'); f.receipt.status = '0x1'; f.flags.canonical = h('e');
  const reorg = await f.adapter.observe(f.input); assert.equal(reorg.state, 'reorged'); assert.equal(reorg.effect, 'not-established');
});
for (const kind of operationKinds) test(`${kind}: wrong actual actor, nonce, value, calldata or chain is refused`, async () => {
  for (const changes of [{ from: recipient }, { nonce: '0x2' }, { value: '0xff' }, { input: '0xab' }, { chainId: '0x1' }, { blockHash: h('e') }, { hash: h('e') }]) {
    const f = fixture(kind); Object.assign(f.tx, changes); await assert.rejects(f.adapter.observe(f.input));
  }
});
for (const kind of operationKinds.filter(kind => kind !== 'native-transfer')) test(`${kind}: status one with missing or mismatched effect is refused`, async () => {
  for (const mutate of [r => { r.logs = []; }, r => { r.logs[0].address = a('9'); }, r => { r.logs[0].transactionHash = h('f'); },
    r => { r.logs[0].blockHash = h('f'); }, r => { r.logs[0].blockNumber = '0x63'; }, r => { r.logs[0].transactionIndex = '0x1'; },
    r => { r.logs[0].removed = true; }, r => { r.logs[0].topics[1] = h('f'); }]) {
    const f = fixture(kind); mutate(f.receipt); await assert.rejects(f.adapter.observe(f.input));
  }
});
for (const kind of operationKinds) test(`${kind}: known-hash different-intent replacement proves only supersession`, async () => {
  const f = fixture(kind); f.flags.pending = true; const result = await f.adapter.observeReplacement(f.input, replacementHash);
  assert.equal(result.state, 'superseded-at-depth'); assert.equal(result.effect, 'not-established');
  assert.equal(result.originalTransactionHash, transactionHash); assert.equal(result.replacementHash, replacementHash);
  assert.ok(!f.calls.some(call => /send|sign|accounts/i.test(call.method)));
});
test('replacement requires different intent and exact original actor/nonce/chain at depth', async () => {
  for (const flags of [{ replaceSameIntent: true }, { replaceNonce: '0x2' }, { replaceActor: recipient }, { chain: '0x1' }]) {
    for (const kind of ['native-transfer', 'create-account', 'deposit']) { const f = fixture(kind); f.flags.pending = true; Object.assign(f.flags, flags); await assert.rejects(f.adapter.observeReplacement(f.input, replacementHash)); }
  }
});
test('null original hash after lost send response remains unknown; it cannot be invented or replayed', async () => {
  const f = fixture(), unknown = { ...f.input, attempt: { ...f.input.attempt, transactionHash: null } };
  await assert.rejects(f.adapter.observe(unknown)); await assert.rejects(f.adapter.observeReplacement(unknown, replacementHash));
  assert.equal(f.calls.length, 0);
  const verifiedKnownHash = await f.adapter.observe(f.input); assert.equal(verifiedKnownHash.originalTransactionHash, transactionHash);
});
test('success and later reorg observations never free spent budget or send tombstones', async () => {
  const f = fixture(); let budget = reserveTaskBudget(f.input.task, f.input.child, emptyTaskBudget(f.input.task), '0', 1000n);
  budget = markTaskSendAttempt(budget, 'receipt-op', f.input.child.digest, budget.revision);
  budget = noteTaskSubmission(budget, 'receipt-op', f.input.child.digest, transactionHash, budget.revision);
  const before = JSON.stringify(budget), success = await f.adapter.observe(f.input);
  assert.throws(() => reconcileTaskBudget(budget, success), /VERIFIER_NOT_CONNECTED/);
  assert.throws(() => reserveTaskBudget(f.input.task, f.input.child, budget, budget.revision, 1000n), /DUPLICATE/);
  f.flags.canonical = h('e'); assert.equal((await f.adapter.observe(f.input)).state, 'reorged');
  assert.equal(JSON.stringify(budget), before); assert.equal(budget.reservations[0].status, 'submitted');
});
test('late reorg and disappearance degrade an earlier confirmed observation', async () => {
  for (const kind of ['native-transfer', 'create-account', 'deposit']) {
    const f = fixture(kind); assert.equal((await f.adapter.observe(f.input)).state, 'confirmed-at-depth');
    f.flags.canonical = null; assert.equal((await f.adapter.observe(f.input)).state, 'reorged');
    f.flags.pending = true; assert.equal((await f.adapter.observe(f.input)).state, 'pending');
    const late = fixture(kind); late.flags.reorgOnBlockRead = 2;
    assert.equal((await late.adapter.observe(late.input)).state, 'reorged');
  }
});
test('sequence token identity and historical runtime pin cannot be substituted', async () => {
  for (const kind of ['complete', 'return-hop']) for (const flags of [{ sequenceToken: recipient }, { sequenceCodeHash: h('f') }, { code: '0x6001' }]) {
    const f = fixture(kind); Object.assign(f.flags, flags); await assert.rejects(f.adapter.observe(f.input));
  }
});
test('native recipient contract and excessive transaction fee bounds refuse completion', async () => {
  const f = fixture(); f.flags.recipientCode = '0x6000'; await assert.rejects(f.adapter.observe(f.input), /NATIVE_EOA/);
  for (const changes of [{ gas: '0x186a1' }, { maxFeePerGas: '0xb' }, { gas: '0x00' }, { gas: 100000 }, { maxFeePerGas: undefined, gasPrice: '0xb' }]) {
    const f = fixture(); Object.assign(f.tx, changes); await assert.rejects(f.adapter.observe(f.input));
  }
});
test('child hash, executor, canonical encoding and configured confirmation policy are independently bound', async () => {
  const f = fixture();
  const wrongWire = freezeChildOperation({ ...f.input.child.child, wire: { ...f.input.child.child.wire, valueWei: '101' } });
  for (const input of [{ ...f.input, child: { ...f.input.child, digest: h('f') } }, { ...f.input, child: wrongWire },
    { ...f.input, executor: { digest: h('f') } }, { ...f.input, observationPolicy: { minimumConfirmations: '1' } },
    { ...f.input, success: true }]) await assert.rejects(f.adapter.observe(input));
});
test('atomic NFT sale claims cannot turn a plain transfer into a verified sale', async () => {
  const f = fixture('erc721-transfer');
  const task = freezeTaskPolicy({ ...f.input.task.policy, intent: { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721', contract: token,
    tokenId: '7', quantity: '1', minimumProceeds: { currency: 'USD', amountMinor: '100', minorUnit: 2, comparison: 'gte', basis: 'net' }, marketAdapters: ['fixture-market'] } });
  const child = freezeChildOperation({ ...f.input.child.child, taskDigest: task.digest });
  await assert.rejects(f.adapter.observe({ ...f.input, task, child }), /ATOMIC_SALE_VERIFIER_NOT_CONNECTED/); assert.equal(f.calls.length, 0);
});
test('fixed policy golden, strict observation normalizer and all attempt bindings reject forged fields', async () => {
  assert.equal(freezeTaskObservationPolicy({ minimumConfirmations: '2' }).digest, '0xe834daeddaea8e8bc8d1aad561998012fd6f5a1b5a0803492441c0a9061c6beb');
  for (const policy of [{ minimumConfirmations: '0' }, { minimumConfirmations: '1025' }, { minimumConfirmations: 2 }, { minimumConfirmations: '02' }, { minimumConfirmations: '2', verified: true }]) assert.throws(() => freezeTaskObservationPolicy(policy));
  const f = fixture(), result = await f.adapter.observe(f.input), binding = { ...f.input, verifier: f.adapter.identity };
  for (const field of ['taskDigest', 'childDigest', 'attemptExecutorDigest', 'originalTransactionHash', 'observationPolicyDigest', 'verifierImplementationDigest'])
    assert.throws(() => bindTaskObservation({ ...result, [field]: h('f') }, binding));
  for (const changes of [{ nonce: '2' }, { attemptGrantPolicyVersion: '2' }, { actor: recipient }, { chainId: '1' },
    { effect: 'atomic-sale-observed' }, { state: 'pending' }, { confirmations: '1' }, { replacementHash }, { success: true }, { protocolFinality: 'final' }, { economicFinality: 'settled' }])
    assert.throws(() => bindTaskObservation({ ...result, ...changes }, binding));
  const accessor = { ...result }; let getterCalled = false;
  Object.defineProperty(accessor, 'state', { get() { getterCalled = true; return result.state; }, enumerable: true });
  assert.throws(() => normalizeTaskObservation(accessor)); assert.equal(getterCalled, false);
});
test('provider function and observation policy are captured; caller mutation cannot redirect reads', async () => {
  const f = fixture(); f.provider.request = async () => { throw new Error('replaced provider'); };
  f.input.observationPolicy.minimumConfirmations = '1';
  await assert.rejects(f.adapter.observe(f.input), /POLICY_MISMATCH/);
  f.input.observationPolicy.minimumConfirmations = '2'; assert.equal((await f.adapter.observe(f.input)).state, 'confirmed-at-depth');
  assert.equal(TASK_RECEIPT_RUNTIME_FILES.length, 13); assert.ok(Object.isFrozen(TASK_RECEIPT_RUNTIME_FILES));
});

test('contradictory canonical original and replacement receipts never imply supersession', async () => {
  for (const kind of ['native-transfer', 'create-account', 'deposit']) {
    const f = fixture(kind); await assert.rejects(f.adapter.observeReplacement(f.input, replacementHash), /ORIGINAL_MINED_REPLACEMENT_REFUSED/);
  }
});

test('saved replacement locator must be re-read and degrades on shallow depth or reorg', async () => {
  for (const kind of ['native-transfer', 'create-account', 'deposit']) {
    const f = fixture(kind); f.flags.pending = true;
    assert.equal((await f.adapter.observeReplacement(f.input, replacementHash)).state, 'superseded-at-depth');
    f.flags.replacementPending = true; assert.equal((await f.adapter.observeReplacement(f.input, replacementHash)).state, 'pending');
    f.flags.replacementPending = false; f.flags.head = '0x64'; assert.equal((await f.adapter.observeReplacement(f.input, replacementHash)).state, 'pending');
    f.flags.head = '0x65'; f.flags.canonical = h('e');
    const degraded = await f.adapter.observeReplacement(f.input, replacementHash);
    assert.equal(degraded.state, 'reorged'); assert.equal(degraded.replacementHash, null); assert.equal(degraded.effect, 'not-established');
  }
});

const assessmentInput = input => ({ task: input.task, child: input.child, executor: input.executor, observationPolicy: input.observationPolicy });
for (const kind of operationKinds) test(`${kind}: pre-send receipt capability independently binds the supported child`, async () => {
  const f = fixture(kind), result = await f.adapter.assessChild(assessmentInput(f.input));
  assert.deepEqual(result, { taskDigest: f.input.task.digest, childDigest: f.input.child.digest, executorDigest,
    observationPolicyDigest: freezeTaskObservationPolicy(f.input.observationPolicy).digest, ...f.adapter.identity,
    capability: 'exact-operation-observable' });
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(f.adapter));
  assert.ok(!f.calls.some(call => /receipt|transactionbyhash|send|sign|accounts/i.test(call.method)));
  if (!['native-transfer', 'deposit', 'standalone-withdraw'].includes(kind)) assert.equal(f.calls.length, 0);
});
test('pre-send capability refuses an NFT sale before any RPC despite a plausible transfer child', async () => {
  const f = fixture('erc721-transfer');
  const task = freezeTaskPolicy({ ...f.input.task.policy, intent: { kind: 'nft-sale', direction: 'sell', standard: 'ERC-721', contract: token,
    tokenId: '7', quantity: '1', minimumProceeds: { currency: 'USD', amountMinor: '100', minorUnit: 2, comparison: 'gte', basis: 'net' }, marketAdapters: ['fixture-market'] } });
  const child = freezeChildOperation({ ...f.input.child.child, taskDigest: task.digest });
  await assert.rejects(f.adapter.assessChild({ ...assessmentInput(f.input), task, child }), /TASK_ATOMIC_SALE_VERIFIER_NOT_CONNECTED/);
  assert.equal(f.calls.length, 0);
});
test('pre-send capability rejects request support flags, mismatched digests, policy and encoding', async () => {
  for (const kind of ['native-transfer', 'deposit', 'standalone-withdraw']) {
    const f = fixture(kind), input = assessmentInput(f.input);
    const wrongWire = freezeChildOperation({ ...f.input.child.child, wire: { ...f.input.child.child.wire, calldataHash: h('f') } });
    for (const candidate of [{ ...input, supported: true }, { ...input, capability: 'exact-operation-observable' },
      { ...input, child: { ...input.child, digest: h('f') } }, { ...input, child: wrongWire },
      { ...input, executor: { digest: null } }, { ...input, observationPolicy: { minimumConfirmations: '1' } }])
      await assert.rejects(f.adapter.assessChild(candidate));
    assert.ok(!f.calls.some(call => /receipt|transactionbyhash|send|sign|accounts/i.test(call.method)));
  }
});
test('pre-send capability does not infer that an unresolved registered account is observable', async () => {
  for (const kind of ['deposit', 'standalone-withdraw']) {
    const f = fixture(kind), provider = { request: async args => args.method === 'eth_call' &&
      args.params[0].data === encodeCall('accountOf(address)', ['address'], [actor]) ? word(0) : f.provider.request(args) };
    const adapter = createTaskReceiptAdapter({ provider, observationPolicy: f.input.observationPolicy });
    await assert.rejects(adapter.assessChild(assessmentInput(f.input)), /TASK_RECEIPT_ACCOUNT_NOT_ESTABLISHED/);
    assert.ok(!f.calls.some(call => /receipt|transactionbyhash|send|sign|accounts/i.test(call.method)));
  }
});

test('native pre-send capability checks both EOAs at the same canonical chain block', async () => {
  const f = fixture(); await f.adapter.assessChild(assessmentInput(f.input));
  const codes = f.calls.filter(call => call.method === 'eth_getCode');
  assert.deepEqual(codes.map(call => call.params), [[actor, { blockHash, requireCanonical: true }], [recipient, { blockHash, requireCanonical: true }]]);
  assert.equal(f.calls.filter(call => call.method === 'eth_chainId').length, 2);
  assert.deepEqual(f.calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params), [['latest', false], ['0x64', false]]);
  assert.ok(!f.calls.some(call => /receipt|transactionbyhash|send|sign|accounts/i.test(call.method)));
});
test('native pre-send capability refuses a contract actor or recipient before execution could be reached', async () => {
  for (const flags of [{ actorCode: '0x6000' }, { recipientCode: '0x6000' }]) {
    const f = fixture(); Object.assign(f.flags, flags);
    let verifyCalls = 0, sendCalls = 0;
    const guardedExecution = async () => {
      await f.adapter.assessChild(assessmentInput(f.input)); verifyCalls++; sendCalls++;
    };
    await assert.rejects(guardedExecution(), /TASK_RECEIPT_NATIVE_EOA_REQUIRED/);
    assert.equal(verifyCalls, 0); assert.equal(sendCalls, 0);
    await assert.rejects(f.adapter.observe(f.input), /TASK_RECEIPT_NATIVE_EOA_REQUIRED/);
  }
});
test('native pre-send EOA capability refuses chain mismatch, missing header and late reorg', async () => {
  for (const flags of [{ chain: '0x1' }, { canonical: null }, { reorgOnBlockRead: 2 }]) {
    const f = fixture(); Object.assign(f.flags, flags); await assert.rejects(f.adapter.assessChild(assessmentInput(f.input)));
    assert.ok(!f.calls.some(call => /receipt|transactionbyhash|send|sign|accounts/i.test(call.method)));
  }
});
