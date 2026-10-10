/** Durable bounded task grants. Login is not operation authorization.
 * No signer, market verifier or receipt verifier is supplied by this module.
 */
import { digest, equal, randomToken } from './crypto.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TaskContractError, freezeTaskPolicy, freezeChildOperation, emptyTaskBudget,
  normalizeTaskBudget, reserveTaskBudget, markTaskSendAttempt, noteTaskSubmission,
  cancelUnattemptedReservation, assessChildScope,
} from '../src/agent/taskContract.ts';
import { TaskObservationError, freezeTaskObservationPolicy, normalizeObservationVerifier, normalizeTaskObservation, bindTaskObservation } from '../src/agent/receiptObservation.ts';

const CHALLENGE_LIFE = 2 * 60_000;
export class TaskAuthorizationError extends Error {
  constructor(code, status = 409) { super(code); this.status = status; }
}
const requireThat = (ok, code, status = 409) => { if (!ok) throw new TaskAuthorizationError(code, status); };
function fields(value, names) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'TASK_REQUEST_REFUSED', 400);
}
function hash(value) { requireThat(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value), 'TASK_DIGEST_REFUSED', 400); return value; }
function identifier(value) { requireThat(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), 'TASK_ID_REFUSED', 400); return value; }
function version(value) { requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n, 'TASK_REVISION_REFUSED', 400); return value; }
const immutable = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') immutable(child); return Object.freeze(value); };
const key = (kind, values) => `task-${kind}:${digest(JSON.stringify(values))}`;
const missing = ['OPERATION_ENCODING_VERIFIER_NOT_CONNECTED', 'USER_CONTROLLED_SIGNER_NOT_CONNECTED'];

const SERVICE_IMPLEMENTATION_DIGEST = `0x${digest(readFileSync(fileURLToPath(import.meta.url)))}`;
export function freezeTaskExecutorIdentity(input) {
  fields(input, ['schema', 'agentId', 'agentVersion', 'adapterId', 'adapterVersion', 'implementationDigest']);
  requireThat(input.schema === '8415-task-executor/1', 'TASK_EXECUTOR_IDENTITY_REFUSED', 400);
  const identity = { schema: '8415-task-executor/1', agentId: identifier(input.agentId), agentVersion: identifier(input.agentVersion),
    adapterId: identifier(input.adapterId), adapterVersion: identifier(input.adapterVersion), implementationDigest: hash(input.implementationDigest) };
  requireThat(!/^0x0+$/.test(identity.implementationDigest), 'TASK_EXECUTOR_IDENTITY_REFUSED', 400);
  return immutable({ identity, digest: `0x${digest(JSON.stringify(identity))}` });
}
function executorCopy(input) {
  requireThat(input && typeof input === 'object', 'TASK_EXECUTOR_STATE_REFUSED', 503);
  const copy = freezeTaskExecutorIdentity(input.identity);
  requireThat(copy.digest === input.digest, 'TASK_EXECUTOR_STATE_REFUSED', 503); return copy;
}

function observationPolicyCopy(input) {
  if (input === null) return null;
  requireThat(input && typeof input === 'object', 'TASK_OBSERVATION_POLICY_STATE_REFUSED', 503);
  const copy = freezeTaskObservationPolicy(input.policy);
  requireThat(copy.digest === input.digest, 'TASK_OBSERVATION_POLICY_STATE_REFUSED', 503); return copy;
}
const sameVerifier = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Session/credential callbacks and execution adapters are server-owned objects,
 * never JSON request fields. All tenants sharing an actor MUST use this same
 * single-writer store for cross-tenant nonce exclusion. Separate stores/replicas
 * do not provide a coordinated execution boundary and are unsupported.
 */
export function createTaskAuthorizationService({ origin, tenant, store, now = Date.now,
  assertSession, credentialFor, consumeTotp, assertPrincipal = null, principalReady = null,
  execution = null, executorIdentity = null, observationPolicy = null, receipt = null }) {
  requireThat(store && typeof store.transactionMany === 'function' &&
    [assertSession, credentialFor, consumeTotp, now].every(value => typeof value === 'function'), 'TASK_CONFIG_REFUSED', 500);
  requireThat(execution === null || execution && ['verify', 'send', 'recover'].every(name => typeof execution[name] === 'function') && (execution.plan === undefined || typeof execution.plan === 'function'), 'TASK_ADAPTER_CONFIG_REFUSED', 500);
  requireThat(execution === null ? executorIdentity === null : executorIdentity !== null, 'TASK_EXECUTOR_IDENTITY_CONFIG_REQUIRED', 500);
  const executor = freezeTaskExecutorIdentity(executorIdentity ?? { schema: '8415-task-executor/1',
    agentId: '8415wallet:local-task-service', agentVersion: '1', adapterId: 'unconfigured-signer', adapterVersion: '0',
    implementationDigest: SERVICE_IMPLEMENTATION_DIGEST });
  requireThat(execution === null || executor.identity.adapterId !== 'unconfigured-signer', 'TASK_EXECUTOR_IDENTITY_CONFIG_REQUIRED', 500);
  // Capture methods once; mutating a configuration object's properties cannot
  // replace the verifier/signer beneath an already reviewed executor identity.
  if (execution !== null) {
    const configured = execution;
    execution = Object.freeze(Object.fromEntries(['verify', 'send', 'recover', 'plan'].filter(name => typeof configured[name] === 'function')
      .map(name => [name, configured[name].bind(configured)])));
  }
  requireThat(execution === null || observationPolicy !== null, 'TASK_OBSERVATION_POLICY_CONFIG_REQUIRED', 500);
  const approvedObservationPolicy = observationPolicy === null ? null : freezeTaskObservationPolicy(observationPolicy);
  let receiptVerifier = null;
  if (receipt !== null) {
    requireThat(typeof receipt.observe === 'function' && typeof receipt.assessChild === 'function' && approvedObservationPolicy !== null &&
      observationPolicyCopy(receipt.observationPolicy)?.digest === approvedObservationPolicy.digest, 'TASK_RECEIPT_CONFIG_REFUSED', 500);
    receiptVerifier = normalizeObservationVerifier(receipt.identity);
    const configured = receipt;
    receipt = Object.freeze({ assessChild: configured.assessChild.bind(configured), observe: configured.observe.bind(configured), ...(typeof configured.observeReplacement === 'function' ?
      { observeReplacement: configured.observeReplacement.bind(configured) } : {}) });
  }
  requireThat(assertPrincipal === null || typeof assertPrincipal === 'function', 'TASK_BACKGROUND_CONFIG_REFUSED', 500);
  const internalContexts = new WeakSet(), assertOwnerSession = assertSession, ownerCredentialFor = credentialFor;
  // Only this closure creates internal contexts, from a durably approved grant.
  // A JSON object, caller flag, session ID or cookie cannot construct one.
  assertSession = (context, credential) => {
    if (!internalContexts.has(context)) return assertOwnerSession(context, credential);
    requireThat(assertPrincipal !== null, 'TASK_BACKGROUND_PRINCIPAL_NOT_CONFIGURED', 503);
    const result = assertPrincipal(context, credential);
    requireThat(!result || typeof result.then !== 'function', 'TASK_BACKGROUND_CONFIG_REFUSED', 500);
  };
  credentialFor = async context => {
    if (!internalContexts.has(context)) return ownerCredentialFor(context);
    const credential = await store.read(`${tenant}:${context.username}`); assertSession(context, credential); return credential;
  };
  const queueKey = key('queue', [origin, tenant]);
  const challenges = new Map();
  const stamp = () => { const time = now(); requireThat(Number.isSafeInteger(time) && time >= 0, 'TASK_CLOCK_REFUSED', 503); return time; };
  const seconds = () => BigInt(Math.floor(stamp() / 1000));
  const principal = session => [origin, tenant, session.username, session.account.toLowerCase(), session.chainId];
  const binding = session => JSON.stringify([...principal(session), session.id, session.revision]);
  const credentialKey = session => `${tenant}:${session.username}`;
  const grantKey = (session, taskDigest) => key('grant', [...principal(session), hash(taskDigest)]);
  const ownerIndexKey = session => key('owner', principal(session));
  const taskIdKey = (session, taskId) => key('id', [...principal(session), identifier(taskId)]);
  // Tenant-independent keys: one account cannot spend the same nonce in two tasks.
  const operationKey = (task, operationId) => key('operation', [task.policy.chainId, task.policy.actor, identifier(operationId)]);
  const nonceKey = child => key('nonce', [child.child.operation.chainId, child.child.operation.actor, child.child.nonce]);
  function sweep() {
    const time = stamp();
    for (const [id, challenge] of challenges) if (time < challenge.issuedAt || time >= challenge.expiresAt) challenges.delete(id);
  }
  function cancel(session) {
    for (const [id, challenge] of challenges) if (challenge.sessionId === session.id) challenges.delete(id);
  }
  function checkTask(task, session) {
    requireThat(task.policy.origin === origin && task.policy.tenant === tenant && task.policy.actor === session.account.toLowerCase() &&
      task.policy.chainId === session.chainId, 'TASK_PRINCIPAL_BINDING_REFUSED', 403);
  }
  function readGrant(raw, session, taskDigest) {
    requireThat(raw?.schema === '8415-task-grant/1' && raw.principal === JSON.stringify(principal(session)) &&
      raw.task?.digest === taskDigest && ['pending', 'authorized', 'revoked'].includes(raw.status), 'TASK_GRANT_NOT_FOUND', 404);
    const task = freezeTaskPolicy(raw.task.policy); checkTask(task, session); executorCopy(raw.executor); observationPolicyCopy(raw.observationPolicy);
    if (raw.receiptVerifier !== null) normalizeObservationVerifier(raw.receiptVerifier);
    requireThat(Array.isArray(raw.observations), 'TASK_OBSERVATION_STATE_REFUSED', 503); version(raw.observationRevision);
    for (const entry of raw.observations) { identifier(entry.operationId);
      requireThat(typeof entry.available === 'boolean' && (!entry.available || entry.observation !== null), 'TASK_OBSERVATION_STATE_REFUSED', 503);
      if (entry.observation !== null) normalizeTaskObservation(entry.observation); }
    requireThat(task.digest === taskDigest && (raw.status === 'pending' ? raw.budget === null : raw.budget?.taskDigest === taskDigest) &&
      typeof raw.reference === 'string' && Number.isSafeInteger(raw.issuedAt) && raw.issuedAt >= 0,
    'TASK_GRANT_STATE_REFUSED', 503);
    version(raw.grantPolicyVersion);
    if (raw.status !== 'pending') { version(raw.credentialRevisionAtApproval); normalizeTaskBudget(raw.budget); }
    return raw;
  }
  function effectiveStatus(grant, credential) {
    if (grant.status === 'revoked') return 'revoked';
    if (stamp() < grant.issuedAt || seconds() >= BigInt(grant.task.policy.expiresAt)) return 'expired';
    // Factor changes pause this principal only; they never renew or expand a task.
    if (grant.status === 'pending') return 'pending';
    if (grant.executor.digest !== executor.digest || grant.observationPolicy?.digest !== approvedObservationPolicy?.digest ||
      !sameVerifier(grant.receiptVerifier, receiptVerifier)) return 'suspended';
    if (String(credential?.revision ?? 0) !== grant.credentialRevisionAtApproval) return 'suspended';
    return 'authorized';
  }
  function requireActive(grant, credential) {
    const status = effectiveStatus(grant, credential);
    requireThat(status === 'authorized', status === 'suspended' ? (grant.executor.digest !== executor.digest ? 'TASK_EXECUTOR_REVALIDATION_REQUIRED' : grant.observationPolicy?.digest !== approvedObservationPolicy?.digest ? 'TASK_OBSERVATION_POLICY_REVALIDATION_REQUIRED' :
      !sameVerifier(grant.receiptVerifier, receiptVerifier) ? 'TASK_RECEIPT_VERIFIER_REVALIDATION_REQUIRED' : 'TASK_FACTOR_REVALIDATION_REQUIRED') : `TASK_GRANT_${status.toUpperCase()}`, 403);
  }
  function completion(grant) {
    const spent = grant.budget?.reservations.filter(r => r.status !== 'cancelled') ?? [];
    if (!spent.length) return { state: 'not-attempted', fresh: false };
    if (spent.some(r => r.status === 'outcome-unknown')) return { state: 'outcome-unknown', fresh: false };
    const observations = spent.map(r => grant.observations.find(entry => entry.operationId === r.operationId &&
      entry.available && entry.observation?.childDigest === r.childDigest)?.observation);
    if (observations.every(o => o?.state === 'confirmed-at-depth')) return { state: 'completed-at-observation-depth', fresh: false };
    if (observations.some(o => ['reverted-at-depth', 'superseded-at-depth'].includes(o?.state))) return { state: 'failed-at-observation-depth', fresh: false };
    return { state: 'awaiting-evidence', fresh: false };
  }
  function view(grant, credential) {
    const effective = effectiveStatus(grant, credential), gaps = execution ? ['TASK_CHILD_VERIFICATION_REQUIRED'] : [...missing,
      ...(grant.task.policy.intent.kind === 'nft-sale' ? ['MARKET_PRICE_VERIFIER_NOT_CONNECTED', 'ATOMIC_SALE_SETTLEMENT_VERIFIER_NOT_CONNECTED'] : [])];
    return { task: grant.task, executor: grant.executor, observationPolicy: grant.observationPolicy, receiptVerifier: grant.receiptVerifier,
      observations: grant.observations, observationRevision: grant.observationRevision, completion: completion(grant), authorization: grant.status === 'pending' ? null : {
      schema: '8415-task-authorization-reference/1', taskDigest: grant.task.digest, reference: grant.reference,
      status: effective, grantPolicyVersion: grant.grantPolicyVersion,
      credentialRevisionAtApproval: grant.credentialRevisionAtApproval,
    }, effectiveStatus: effective, budget: grant.budget,
    capabilities: { executable: false, adapterConfigured: Boolean(execution), missing: gaps,
      sessionRequired: true, factorRevalidationRequired: String(credential?.revision ?? 0) !== grant.credentialRevisionAtApproval && grant.status !== 'pending',
      executorRevalidationRequired: grant.executor.digest !== executor.digest, receiptVerifierConfigured: Boolean(receipt),
      observationPolicyRevalidationRequired: grant.observationPolicy?.digest !== approvedObservationPolicy?.digest,
      receiptVerifierRevalidationRequired: !sameVerifier(grant.receiptVerifier, receiptVerifier) } };
  }
  async function transaction(keys, update) {
    try { return await store.transactionMany(keys, update); }
    catch (error) {
      if (error?.message === 'AUTH_STORE_CAPACITY') throw new TaskAuthorizationError('TASK_STORE_CAPACITY', 507);
      if (error instanceof TaskContractError || error instanceof TaskObservationError) throw new TaskAuthorizationError(error.code, 409);
      throw error;
    }
  }
  async function status(session, taskDigest) {
    const ckey = credentialKey(session), gkey = grantKey(session, taskDigest);
    // Read both in one serialized snapshot; a write failure cannot yield authority.
    const result = await store.readMany([ckey, gkey]);
    assertSession(session, result[ckey]); readGrant(result[gkey], session, taskDigest);
    return view(result[gkey], result[ckey]);
  }
  async function list(body, session) {
    requireThat(Object.keys(body).length === 0 || Object.keys(body).length === 2 && Object.hasOwn(body, 'cursor') && Object.hasOwn(body, 'revision'), 'TASK_REQUEST_REFUSED', 400);
    const cursor = body.cursor === undefined ? 0 : Number(version(body.cursor));
    requireThat(Number.isSafeInteger(cursor) && cursor >= 0, 'TASK_CURSOR_REFUSED', 400);
    const ckey = credentialKey(session), lkey = ownerIndexKey(session);
    const first = await store.readMany([ckey, lkey]); assertSession(session, first[ckey]);
    const index = first[lkey] ?? { revision: '0', taskDigests: [] };
    if (body.revision !== undefined) requireThat(version(body.revision) === index.revision, 'TASK_LIST_REVISION_CONFLICT');
    requireThat(Array.isArray(index.taskDigests) && cursor <= index.taskDigests.length, 'TASK_CURSOR_REFUSED', 400);
    const selected = index.taskDigests.slice(cursor, cursor + 50), keys = selected.map(value => grantKey(session, value));
    const result = await store.readMany([ckey, lkey, ...keys]); assertSession(session, result[ckey]);
    requireThat((result[lkey]?.revision ?? '0') === index.revision, 'TASK_LIST_REVISION_CONFLICT');
    return { tasks: selected.map((value, i) => view(readGrant(result[keys[i]], session, value), result[ckey])),
      revision: index.revision, nextCursor: cursor + selected.length < index.taskDigests.length ? String(cursor + selected.length) : null };
  }
  async function prepare(body, session) {
    fields(body, ['policy']); const task = freezeTaskPolicy(body.policy); checkTask(task, session);
    await credentialFor(session); assertSession(session); sweep();
    const time = stamp(); requireThat(BigInt(task.policy.expiresAt) > seconds(), 'TASK_EXPIRED', 400);
    requireThat(challenges.size < 10000, 'TASK_BUSY', 503);
    const ckey = credentialKey(session), gkey = grantKey(session, task.digest), ikey = taskIdKey(session, task.policy.taskId), lkey = ownerIndexKey(session);
    await transaction([ckey, gkey, ikey, lkey], values => {
      assertSession(session, values[ckey]); requireThat(BigInt(task.policy.expiresAt) > seconds(), 'TASK_EXPIRED', 400);
      requireThat(values[ikey] === null || values[ikey].taskDigest === task.digest, 'TASK_ID_ALREADY_BOUND');
      if (values[gkey] !== null) {
        const prior = readGrant(values[gkey], session, task.digest); requireThat(prior.status === 'pending', 'TASK_ALREADY_EXISTS');
        requireThat(prior.executor.digest === executor.digest && prior.observationPolicy?.digest === approvedObservationPolicy?.digest &&
          sameVerifier(prior.receiptVerifier, receiptVerifier), 'TASK_EXECUTOR_REVALIDATION_REQUIRED');
        return values;
      }
      const index = values[lkey] ?? { revision: '0', taskDigests: [] };
      version(index.revision); requireThat(BigInt(index.revision) < (1n << 256n) - 1n, 'TASK_REVISION_EXHAUSTED');
      return { [ckey]: values[ckey], [gkey]: { schema: '8415-task-grant/1', principal: JSON.stringify(principal(session)), task, executor, observationPolicy: approvedObservationPolicy, receiptVerifier,
        observations: [], observationRevision: '0',
        reference: `grant:${randomToken()}`, status: 'pending', grantPolicyVersion: '0', credentialRevisionAtApproval: null,
        issuedAt: time, revokedAt: null, budget: null }, [ikey]: { taskDigest: task.digest },
      [lkey]: { revision: (BigInt(index.revision) + 1n).toString(), taskDigests: [...index.taskDigests, task.digest] } };
    });
    assertSession(session); sweep();
    const challengeId = `challenge:${randomToken()}`, expiresAt = Math.min(time + CHALLENGE_LIFE, session.expiresAt,
      Number(BigInt(task.policy.expiresAt) * 1000n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(task.policy.expiresAt) * 1000n));
    requireThat(stamp() < expiresAt, 'TASK_APPROVAL_CHALLENGE_REFUSED', 403);
    challenges.set(challengeId, { task, executor, observationPolicy: approvedObservationPolicy, receiptVerifier, sessionId: session.id, binding: binding(session), issuedAt: time, expiresAt, attempts: 0 });
    return { challengeId, task, executor, observationPolicy: approvedObservationPolicy, receiptVerifier, expiresAt, purpose: 'authorize-task' };
  }
  async function authorize(body, session) {
    fields(body, ['challengeId', 'taskDigest', 'executorDigest', 'observationPolicyDigest', 'code']); hash(body.taskDigest); hash(body.executorDigest); if (body.observationPolicyDigest !== null) hash(body.observationPolicyDigest); sweep();
    const challenge = challenges.get(body.challengeId);
    const current = () => {
      assertSession(session); sweep();
      requireThat(challenge && challenges.get(body.challengeId) === challenge && challenge.binding === binding(session) &&
        equal(challenge.task.digest, body.taskDigest) && equal(challenge.executor.digest, body.executorDigest) && equal(executor.digest, body.executorDigest) &&
        (challenge.observationPolicy?.digest ?? null) === body.observationPolicyDigest &&
        (approvedObservationPolicy?.digest ?? null) === body.observationPolicyDigest, 'TASK_APPROVAL_CHALLENGE_REFUSED', 403);
    };
    current(); requireThat(challenge.attempts < 5, 'TASK_APPROVAL_ATTEMPTS_EXHAUSTED', 429); challenge.attempts++;
    const ckey = credentialKey(session), gkey = grantKey(session, body.taskDigest), ikey = taskIdKey(session, challenge.task.policy.taskId);
    const result = await transaction([ckey, gkey, ikey, queueKey], values => {
      current(); assertSession(session, values[ckey]);
      const proposal = readGrant(values[gkey], session, body.taskDigest);
      requireThat(proposal.status === 'pending' && proposal.executor.digest === body.executorDigest && values[ikey]?.taskDigest === body.taskDigest, 'TASK_ALREADY_EXISTS');
      // One durable replace consumes the OTP and creates every grant/index field.
      const credential = consumeTotp(session, values[ckey], body.code);
      const grant = { schema: '8415-task-grant/1', principal: JSON.stringify(principal(session)),
        task: challenge.task, executor: challenge.executor, observationPolicy: challenge.observationPolicy, receiptVerifier: challenge.receiptVerifier,
        observations: [], observationRevision: '0', reference: proposal.reference, status: 'authorized', grantPolicyVersion: '1',
        credentialRevisionAtApproval: String(session.revision), issuedAt: stamp(), revokedAt: null,
        budget: emptyTaskBudget(challenge.task) };
      const queue = values[queueKey] ?? { schema: '8415-task-queue/1', entries: [] };
      requireThat(queue.schema === '8415-task-queue/1' && Array.isArray(queue.entries) && !queue.entries.includes(gkey), 'TASK_QUEUE_STATE_REFUSED', 503);
      return { [ckey]: credential, [gkey]: grant, [ikey]: { taskDigest: body.taskDigest },
        [queueKey]: { schema: '8415-task-queue/1', entries: [...queue.entries, gkey] } };
    });
    challenges.delete(body.challengeId); return view(result[gkey], result[ckey]);
  }
  async function reserve(body, session) {
    fields(body, ['taskDigest', 'child', 'expectedBudgetRevision']); hash(body.taskDigest); version(body.expectedBudgetRevision);
    const child = freezeChildOperation(body.child);
    requireThat(child.child.taskDigest === body.taskDigest, 'TASK_BINDING_MISMATCH');
    const ckey = credentialKey(session), gkey = grantKey(session, body.taskDigest);
    const okey = key('operation', [child.child.operation.chainId, child.child.operation.actor, child.child.operationId]), nkey = nonceKey(child);
    const result = await transaction([ckey, gkey, okey, nkey], values => {
      assertSession(session, values[ckey]); const grant = readGrant(values[gkey], session, body.taskDigest); requireActive(grant, values[ckey]);
      requireThat(values[okey] === null, 'TASK_DUPLICATE_OPERATION_REFUSED'); requireThat(values[nkey] === null, 'TASK_NONCE_OCCUPIED');
      const budget = reserveTaskBudget(grant.task, child, grant.budget, body.expectedBudgetRevision, seconds());
      const operation = { schema: '8415-task-operation/1', grantKey: gkey, child, status: 'reserved', nonceKey: nkey, observationRevision: '0' };
      return { [ckey]: values[ckey], [gkey]: { ...grant, budget }, [okey]: operation,
        [nkey]: { operationKey: okey, taskDigest: body.taskDigest, childDigest: child.digest, permanent: false } };
    });
    return view(result[gkey], result[ckey]);
  }
  async function operationContext(body, session) {
    fields(body, ['taskDigest', 'operationId', 'childDigest', 'expectedBudgetRevision']);
    hash(body.taskDigest); hash(body.childDigest); identifier(body.operationId); version(body.expectedBudgetRevision);
    const credential = await credentialFor(session), gkey = grantKey(session, body.taskDigest);
    const grant = readGrant(await store.read(gkey), session, body.taskDigest);
    assertSession(session); const okey = operationKey(grant.task, body.operationId), operation = await store.read(okey);
    assertSession(session);
    requireThat(operation?.schema === '8415-task-operation/1' && operation.grantKey === gkey && operation.child?.digest === body.childDigest,
      'TASK_OPERATION_NOT_FOUND', 404);
    const child = freezeChildOperation(operation.child.child);
    requireThat(child.digest === body.childDigest && child.child.taskDigest === body.taskDigest &&
      operation.nonceKey === nonceKey(child), 'TASK_OPERATION_STATE_REFUSED', 503);
    return { credential, ckey: credentialKey(session), gkey, grant, okey, nkey: operation.nonceKey, child, operation };
  }
  function checkOperation(values, context, body, session) {
    const { ckey, gkey, okey, nkey } = context;
    assertSession(session, values[ckey]); const grant = readGrant(values[gkey], session, body.taskDigest);
    requireThat(values[okey]?.grantKey === gkey && values[okey]?.child?.digest === body.childDigest &&
      values[nkey]?.operationKey === okey && values[nkey]?.childDigest === body.childDigest, 'TASK_OPERATION_STATE_REFUSED', 503);
    requireThat(grant.budget.revision === body.expectedBudgetRevision, 'TASK_BUDGET_REVISION_CONFLICT');
    return grant;
  }
  async function cancelReservation(body, session) {
    const context = await operationContext(body, session), { ckey, gkey, okey, nkey } = context;
    const result = await transaction([ckey, gkey, okey, nkey], values => {
      const grant = checkOperation(values, context, body, session);
      requireThat(values[okey].status === 'reserved' && values[nkey].permanent === false, 'TASK_UNCERTAIN_RESERVATION_CANNOT_RELEASE');
      const budget = cancelUnattemptedReservation(grant.budget, body.operationId, body.childDigest, body.expectedBudgetRevision);
      // Cancel is safe even after revocation/expiry. The operation ID is forever
      // consumed; the nonce can be used by a new explicitly unattempted proposal.
      return { [ckey]: values[ckey], [gkey]: { ...grant, budget }, [okey]: { ...values[okey], status: 'cancelled' }, [nkey]: null };
    });
    return view(result[gkey], result[ckey]);
  }
  function verifiedBinding(result, context) {
    const { child, grant } = context;
    return result && result.taskDigest === grant.task.digest && result.childDigest === child.digest &&
      result.chainId === child.child.operation.chainId && result.actor === child.child.operation.actor &&
      result.nonce === child.child.nonce && result.executorDigest === (context.operation?.attemptExecutor?.digest ?? grant.executor.digest) && result.grantPolicyVersion === (context.operation?.attemptGrantPolicyVersion ?? grant.grantPolicyVersion);
  }
  async function execute(body, session) {
    const context = await operationContext(body, session);
    requireThat(execution, 'TASK_EXECUTION_ADAPTER_NOT_CONNECTED', 503);
    requireThat(receipt && context.grant.receiptVerifier !== null, 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED', 503); requireActive(context.grant, context.credential);
    requireThat(assessChildScope(context.grant.task, context.child, seconds()).state !== 'outside-declared-scope', 'TASK_CHILD_OUTSIDE_SCOPE');
    const capability = await receipt.assessChild(immutable(structuredClone({ task: context.grant.task, child: context.child,
      executor: context.grant.executor, observationPolicy: context.grant.observationPolicy.policy })));
    fields(capability, ['taskDigest', 'childDigest', 'executorDigest', 'observationPolicyDigest', 'verifierId', 'verifierVersion',
      'verifierImplementationDigest', 'capability']);
    requireThat(capability.taskDigest === context.grant.task.digest && capability.childDigest === context.child.digest &&
      capability.executorDigest === context.grant.executor.digest && capability.observationPolicyDigest === context.grant.observationPolicy.digest &&
      capability.verifierId === receiptVerifier.verifierId && capability.verifierVersion === receiptVerifier.verifierVersion &&
      capability.verifierImplementationDigest === receiptVerifier.verifierImplementationDigest &&
      capability.capability === 'exact-operation-observable' && context.grant.task.policy.intent.kind === 'exact-operation',
      'TASK_RECEIPT_CAPABILITY_REFUSED', 503);
    // Server-configured verifier must independently re-encode the operation,
    // inspect live account/chain/nonce, and verify sale price + atomic settlement.
    const checked = await execution.verify(immutable(structuredClone({ task: context.grant.task, child: context.child, executor: context.grant.executor,
      grantPolicyVersion: context.grant.grantPolicyVersion })));
    requireThat(verifiedBinding(checked, context), 'TASK_EXECUTION_VERIFICATION_REFUSED', 403);
    const { ckey, gkey, okey, nkey } = context;
    const result = await transaction([ckey, gkey, okey, nkey], values => {
      const grant = checkOperation(values, context, body, session); requireActive(grant, values[ckey]);
      requireThat(grant.grantPolicyVersion === context.grant.grantPolicyVersion && values[okey].status === 'reserved' &&
        !values[nkey].permanent, 'TASK_SEND_ATTEMPT_REFUSED');
      requireThat(assessChildScope(grant.task, context.child, seconds()).state !== 'outside-declared-scope', 'TASK_CHILD_OUTSIDE_SCOPE');
      return { [ckey]: values[ckey], [gkey]: { ...grant, budget: markTaskSendAttempt(grant.budget, body.operationId, body.childDigest, body.expectedBudgetRevision) },
        [okey]: { ...values[okey], status: 'outcome-unknown', attemptGrantPolicyVersion: grant.grantPolicyVersion, attemptExecutor: executor, attemptObservationPolicy: grant.observationPolicy, attemptReceiptVerifier: grant.receiptVerifier }, [nkey]: { ...values[nkey], permanent: true } };
    });
    // This is the sole send call. Any exception or lost response keeps the full
    // durable reservation and permanent nonce claim; neither retry nor release.
    let submitted;
    try { submitted = await execution.send(immutable(structuredClone({ task: context.grant.task, child: context.child, executor: context.grant.executor,
      grantPolicyVersion: context.grant.grantPolicyVersion }))); }
    catch { return { ...view(result[gkey], result[ckey]), outcome: 'outcome-unknown' }; }
    if (!verifiedBinding(submitted, context) || !/^0x[0-9a-f]{64}$/.test(submitted.transactionHash ?? '') || /^0x0+$/.test(submitted.transactionHash)) {
      return { ...view(result[gkey], result[ckey]), outcome: 'outcome-unknown' };
    }
    return recordSubmission(context, body, session, submitted.transactionHash, result[gkey].budget.revision);
  }
  async function recordSubmission(context, body, session, transactionHash, expectedRevision) {
    const { ckey, gkey, okey, nkey } = context;
    // Recording already attempted progress must remain possible after grant
    // expiry/revocation. A current authenticated session is still required.
    const result = await transaction([ckey, gkey, okey, nkey], values => {
      const grant = checkOperation(values, context, { ...body, expectedBudgetRevision: expectedRevision }, session);
      requireThat(values[okey].status === 'outcome-unknown' && values[nkey].permanent, 'TASK_SUBMISSION_STATE_REFUSED');
      return { [ckey]: values[ckey], [gkey]: { ...grant, budget: noteTaskSubmission(grant.budget, body.operationId, body.childDigest, transactionHash, expectedRevision) },
        [okey]: { ...values[okey], status: 'submitted' }, [nkey]: values[nkey] };
    });
    return { ...view(result[gkey], result[ckey]), outcome: 'submitted' };
  }
  async function recover(body, session) {
    const context = await operationContext(body, session);
    requireThat(execution, 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED', 503);
    requireThat(context.operation.attemptExecutor && executorCopy(context.operation.attemptExecutor).digest === executor.digest, 'TASK_RECOVERY_EXECUTOR_BINDING_REQUIRED', 503);
    const evidence = await execution.recover(immutable(structuredClone({ task: context.grant.task, child: context.child, executor: context.operation.attemptExecutor,
      grantPolicyVersion: context.operation.attemptGrantPolicyVersion })));
    requireThat(verifiedBinding(evidence, context) && evidence.state === 'submitted' &&
      /^0x[0-9a-f]{64}$/.test(evidence.transactionHash ?? '') && !/^0x0+$/.test(evidence.transactionHash), 'TASK_RECOVERY_NOT_ESTABLISHED');
    // A matching trusted chain observation records submission only. It never
    // proves finality or refunds any reserved quota, even on a reverted receipt.
    return recordSubmission(context, body, session, evidence.transactionHash, body.expectedBudgetRevision);
  }
  async function observe(body, session, requestedReplacementHash = null) {
    const context = await operationContext(body, session), { ckey, gkey, okey, nkey, operation } = context;
    requireThat(receipt && operation.attemptReceiptVerifier !== null, 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED', 503);
    requireThat(operation.status === 'submitted' && operation.attemptExecutor?.digest === executor.digest &&
      sameVerifier(operation.attemptReceiptVerifier, receiptVerifier), 'TASK_RECEIPT_EXECUTOR_BINDING_REQUIRED', 503);
    const policy = observationPolicyCopy(operation.attemptObservationPolicy);
    requireThat(policy !== null && policy.digest === approvedObservationPolicy?.digest, 'TASK_RECEIPT_POLICY_BINDING_REQUIRED', 503);
    const reservation = context.grant.budget.reservations.find(r => r.operationId === body.operationId && r.childDigest === body.childDigest);
    requireThat(reservation?.status === 'submitted' && reservation.transactionHash !== null, 'TASK_SUBMISSION_STATE_REFUSED');
    const input = immutable(structuredClone({ task: context.grant.task, child: context.child, executor: operation.attemptExecutor,
      attempt: { executorDigest: operation.attemptExecutor.digest, grantPolicyVersion: operation.attemptGrantPolicyVersion,
        transactionHash: reservation.transactionHash }, observationPolicy: policy.policy }));
    const replacementHash = requestedReplacementHash ?? operation.replacementHash ?? null;
    if (replacementHash !== null) {
      hash(replacementHash); requireThat(!/^0x0+$/.test(replacementHash) && replacementHash !== reservation.transactionHash,
        'TASK_OBSERVATION_REPLACEMENT_REFUSED', 400);
      requireThat(receipt.observeReplacement, 'TASK_REPLACEMENT_VERIFIER_NOT_CONNECTED', 503);
    }
    const startedAt = seconds(); let observation = null, failure = null;
    try {
      const raw = await (replacementHash === null ? receipt.observe(input) : receipt.observeReplacement(input, replacementHash));
      observation = bindTaskObservation(raw, { ...input, verifier: receiptVerifier });
      requireThat(BigInt(observation.observedAt) >= startedAt && BigInt(observation.observedAt) <= seconds(), 'TASK_OBSERVATION_TIME_REFUSED', 503);
      requireThat(replacementHash === null ? observation.state !== 'superseded-at-depth' :
        observation.state === 'superseded-at-depth' ? observation.replacementHash === replacementHash :
          ['pending', 'confirming', 'reorged'].includes(observation.state), 'TASK_OBSERVATION_REPLACEMENT_REFUSED', 503);
    } catch (error) { failure = error; }
    const result = await transaction([ckey, gkey, okey, nkey], values => {
      const grant = checkOperation(values, context, body, session), current = values[okey];
      requireThat(current.status === 'submitted' && values[nkey].permanent && current.observationRevision === operation.observationRevision &&
        current.attemptExecutor.digest === operation.attemptExecutor.digest && current.attemptObservationPolicy.digest === policy.digest &&
        sameVerifier(current.attemptReceiptVerifier, receiptVerifier), 'TASK_OBSERVATION_REVISION_CONFLICT');
      requireThat(BigInt(grant.observationRevision) < (1n << 256n) - 1n && BigInt(current.observationRevision) < (1n << 256n) - 1n,
        'TASK_OBSERVATION_REVISION_EXHAUSTED');
      const revision = (BigInt(grant.observationRevision) + 1n).toString();
      const prior = grant.observations.find(entry => entry.operationId === body.operationId);
      const observations = [...grant.observations.filter(entry => entry.operationId !== body.operationId),
        { operationId: body.operationId, observation: failure ? prior?.observation ?? null : observation, available: failure === null }];
      return { [ckey]: values[ckey], [gkey]: { ...grant, observations, observationRevision: revision },
        [okey]: { ...current, observationRevision: (BigInt(current.observationRevision) + 1n).toString(),
          // Only a verified supersession may install a replacement locator.
          // A later disappearance/reorg retains that locator for read-only retry.
          ...(failure === null && observation.state === 'superseded-at-depth' ? { replacementHash } : {}) }, [nkey]: values[nkey] };
    });
    // Persist unavailable before reporting an error: old evidence is historical,
    // never silently presented as a successful current observation.
    if (failure) throw new TaskAuthorizationError('TASK_OBSERVATION_UNAVAILABLE', 503);
    const snapshot = view(result[gkey], result[ckey]);
    const single = result[gkey].budget.reservations.filter(r => r.status !== 'cancelled').length === 1;
    return { ...snapshot, observation, completion: { ...snapshot.completion, fresh: single }, outcome: observation.state };
  }
  async function revoke(body, session) {
    fields(body, ['taskDigest', 'expectedGrantPolicyVersion']); hash(body.taskDigest); version(body.expectedGrantPolicyVersion);
    const ckey = credentialKey(session), gkey = grantKey(session, body.taskDigest);
    const result = await transaction([ckey, gkey], values => {
      assertSession(session, values[ckey]); const grant = readGrant(values[gkey], session, body.taskDigest);
      requireThat(grant.status !== 'pending', 'TASK_GRANT_NOT_AUTHORIZED');
      requireThat(grant.grantPolicyVersion === body.expectedGrantPolicyVersion, 'TASK_GRANT_REVISION_CONFLICT');
      requireThat(BigInt(grant.grantPolicyVersion) < (1n << 256n) - 1n, 'TASK_GRANT_REVISION_EXHAUSTED');
      return { [ckey]: values[ckey], [gkey]: grant.status === 'revoked' ? grant : { ...grant, status: 'revoked', revokedAt: stamp(),
        grantPolicyVersion: (BigInt(grant.grantPolicyVersion) + 1n).toString() } };
    });
    return view(result[gkey], result[ckey]);
  }
  async function resume(body, session) {
    fields(body, ['taskDigest']); const initial = await status(session, hash(body.taskDigest));
    const blocked = code => ({ ...initial, continuation: { state: 'blocked', code } });
    const continueExecution = async operation => {
      try { return await execute(operation, session); }
      catch (error) {
        if (error?.code === 'TASK_ATOMIC_SALE_VERIFIER_NOT_CONNECTED') return { ...await status(session, body.taskDigest),
          outcome: 'blocked', continuation: { state: 'blocked', code: error.code } };
        throw error;
      }
    };
    // Recovery only records an already attempted operation. It is permitted
    // after task expiry/revocation/factor changes and never calls plan or send.
    const unknown = initial.budget?.reservations.find(r => r.status === 'outcome-unknown');
    if (unknown) {
      if (!execution) return blocked('TASK_RECEIPT_VERIFIER_NOT_CONNECTED');
      const progress = await recover({ taskDigest: body.taskDigest, operationId: unknown.operationId,
        childDigest: unknown.childDigest, expectedBudgetRevision: initial.budget.revision }, session);
      return { ...progress, continuation: { state: progress.outcome, operationId: unknown.operationId } };
    }
    // The current contract permits one whole non-cancelled operation. Its spent
    // quota is never released. Terminal cached outcomes do not restart planning
    // or monopolize automatic continuation; explicit observe rechecks reorgs.
    if (['completed-at-observation-depth', 'failed-at-observation-depth'].includes(initial.completion.state))
      return { ...initial, continuation: { state: initial.completion.state } };
    const submitted = initial.budget?.reservations.filter(r => r.status === 'submitted').sort((a, b) => {
      const at = id => initial.observations.find(entry => entry.operationId === id)?.observation?.observedAt ?? '-1';
      return BigInt(at(a.operationId)) < BigInt(at(b.operationId)) ? -1 : 1;
    })[0];
    if (submitted) {
      if (!receipt) return { ...initial, continuation: { state: 'awaiting-evidence', code: 'TASK_RECEIPT_VERIFIER_NOT_CONNECTED' } };
      const progress = await observe({ taskDigest: body.taskDigest, operationId: submitted.operationId, childDigest: submitted.childDigest,
        expectedBudgetRevision: initial.budget.revision }, session);
      return { ...progress, continuation: { state: progress.completion.state, operationId: submitted.operationId } };
    }
    if (initial.effectiveStatus !== 'authorized') return blocked(initial.effectiveStatus === 'suspended' ?
      (initial.capabilities.executorRevalidationRequired ? 'TASK_EXECUTOR_REVALIDATION_REQUIRED' : initial.capabilities.observationPolicyRevalidationRequired ?
        'TASK_OBSERVATION_POLICY_REVALIDATION_REQUIRED' : initial.capabilities.receiptVerifierRevalidationRequired ? 'TASK_RECEIPT_VERIFIER_REVALIDATION_REQUIRED' : 'TASK_FACTOR_REVALIDATION_REQUIRED') : 'TASK_GRANT_NOT_ACTIVE');
    if (!execution) return blocked('TASK_EXECUTION_ADAPTER_NOT_CONNECTED');
    if (!receipt || initial.receiptVerifier === null) return blocked('TASK_RECEIPT_VERIFIER_NOT_CONNECTED');
    // Exactly one bounded step per call. Never replan or resend an unknown
    // operation; verified recovery above takes priority over new work.
    const pending = initial.budget.reservations.find(r => r.status === 'reserved');
    if (pending) {
      const progress = await continueExecution({ taskDigest: body.taskDigest, operationId: pending.operationId, childDigest: pending.childDigest,
        expectedBudgetRevision: initial.budget.revision });
      return { ...progress, continuation: progress.continuation ?? { state: progress.outcome, operationId: pending.operationId } };
    }
    if (!execution.plan) return { ...initial, continuation: { state: 'waiting-for-operation', code: 'TASK_PLANNER_NOT_CONNECTED' } };
    const proposal = await execution.plan(immutable(structuredClone({ task: initial.task, budget: initial.budget, executor: initial.executor,
      grantPolicyVersion: initial.authorization.grantPolicyVersion })));
    if (proposal === null) return { ...await status(session, body.taskDigest), continuation: { state: 'waiting-for-operation', code: 'TASK_NO_CANDIDATE' } };
    const frozen = freezeChildOperation(proposal);
    const reserved = await reserve({ taskDigest: body.taskDigest, child: frozen.child, expectedBudgetRevision: initial.budget.revision }, session);
    const progress = await continueExecution({ taskDigest: body.taskDigest, operationId: frozen.child.operationId, childDigest: frozen.digest,
      expectedBudgetRevision: reserved.budget.revision });
    return { ...progress, continuation: progress.continuation ?? { state: progress.outcome, operationId: frozen.child.operationId } };
  }
  async function handler(path, body, session) {
    try {
      if (path === 'tasks/list') return await list(body, session);
      if (path === 'tasks/resume') return await resume(body, session);
      if (path === 'tasks/prepare') return await prepare(body, session);
      if (path === 'tasks/authorize') return await authorize(body, session);
      if (path === 'tasks/status') { fields(body, ['taskDigest']); return await status(session, hash(body.taskDigest)); }
      if (path === 'tasks/revoke') return await revoke(body, session);
      if (path === 'tasks/reserve') return await reserve(body, session);
      if (path === 'tasks/cancel-reservation') return await cancelReservation(body, session);
      if (path === 'tasks/execute') return await execute(body, session);
      if (path === 'tasks/recover') return await recover(body, session);
      if (path === 'tasks/observe') return await observe(body, session);
      if (path === 'tasks/observe-replacement') {
        fields(body, ['taskDigest', 'operationId', 'childDigest', 'expectedBudgetRevision', 'replacementHash']);
        const { replacementHash, ...operation } = body; return await observe(operation, session, hash(replacementHash));
      }
      throw new TaskAuthorizationError('TASK_ROUTE_REFUSED', 404);
    } catch (error) {
      if (error instanceof TaskContractError || error instanceof TaskObservationError) throw new TaskAuthorizationError(error.code, 400);
      throw error;
    }
  }
  const background = Object.freeze({
    async list({ cursor = '0', limit = 10 } = {}) {
      await principalReady;
      requireThat(assertPrincipal !== null, 'TASK_BACKGROUND_PRINCIPAL_NOT_CONFIGURED', 503);
      const offset = Number(version(cursor));
      requireThat(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50,
        'TASK_BACKGROUND_PAGE_REFUSED', 400);
      const queue = await store.read(queueKey) ?? { schema: '8415-task-queue/1', entries: [] };
      requireThat(queue.schema === '8415-task-queue/1' && Array.isArray(queue.entries) && offset <= queue.entries.length &&
        queue.entries.every(entry => typeof entry === 'string' && /^task-grant:[0-9a-f]{64}$/.test(entry)), 'TASK_QUEUE_STATE_REFUSED', 503);
      const entries = queue.entries.slice(offset, offset + limit);
      return { entries, nextCursor: offset + entries.length < queue.entries.length ? String(offset + entries.length) : null };
    },
    async resume(entry) {
      await principalReady;
      requireThat(assertPrincipal !== null && typeof entry === 'string' && /^task-grant:[0-9a-f]{64}$/.test(entry), 'TASK_BACKGROUND_GRANT_REFUSED', 403);
      const snapshot = await store.readMany([queueKey, entry]), raw = snapshot[entry], queue = snapshot[queueKey];
      requireThat(queue?.schema === '8415-task-queue/1' && Array.isArray(queue.entries) && queue.entries.includes(entry) &&
        raw?.schema === '8415-task-grant/1' && raw.status !== 'pending', 'TASK_BACKGROUND_GRANT_REFUSED', 403);
      let owner; try { owner = JSON.parse(raw.principal); } catch { throw new TaskAuthorizationError('TASK_BACKGROUND_PRINCIPAL_REFUSED', 503); }
      requireThat(Array.isArray(owner) && owner.length === 5 && owner[0] === origin && owner[1] === tenant &&
        typeof owner[2] === 'string' && typeof owner[3] === 'string' && typeof owner[4] === 'string', 'TASK_BACKGROUND_PRINCIPAL_REFUSED', 503);
      const context = Object.freeze({ username: owner[2], account: owner[3], chainId: owner[4] });
      requireThat(grantKey(context, raw.task?.digest) === entry, 'TASK_BACKGROUND_GRANT_REFUSED', 403);
      readGrant(raw, context, raw.task.digest); internalContexts.add(context);
      // This is the only internal operation. No prepare, approve or mutation API
      // is exposed to a worker, and the normal atomic send gates stay in force.
      return resume({ taskDigest: raw.task.digest }, context);
    },
  });
  return { handler, cancel, background };
}
