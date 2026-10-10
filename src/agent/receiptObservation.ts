import { keccak256Utf8 } from '../codec/keccak.ts';
import { isAddressInput } from '../xiongan/address.ts';
import { freezeTaskPolicy, freezeChildOperation, type FrozenTask, type FrozenChild } from './taskContract.ts';

/** Observation data is neither authorization nor a receipt proof. Only a trusted
 * read-only verifier may create evidence accepted by the task service. */
export class TaskObservationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'TaskObservationError'; this.code = code; }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new TaskObservationError(code);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'TASK_OBSERVATION_SCHEMA_REFUSED');
  check([Object.prototype, null].includes(Object.getPrototypeOf(value)), 'TASK_OBSERVATION_SCHEMA_REFUSED');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key]!, 'value')), 'TASK_OBSERVATION_SCHEMA_REFUSED');
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  check(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0+$/i.test(value), 'TASK_OBSERVATION_HASH_REFUSED');
  return value.toLowerCase();
}
function uint(value: unknown, positive = false, bits = 256): string {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) >= (positive ? 1n : 0n) && BigInt(value) < 1n << BigInt(bits), 'TASK_OBSERVATION_INTEGER_REFUSED');
  return value;
}
function id(value: unknown): string {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), 'TASK_OBSERVATION_ID_REFUSED');
  return value;
}
function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export type TaskObservationPolicy = { readonly minimumConfirmations: string };
export type FrozenTaskObservationPolicy = { readonly policy: TaskObservationPolicy; readonly digest: string };
export function normalizeObservationPolicy(value: unknown): TaskObservationPolicy {
  const r = object(value, ['minimumConfirmations']);
  const minimumConfirmations = uint(r.minimumConfirmations, true);
  check(BigInt(minimumConfirmations) <= 1024n, 'TASK_OBSERVATION_POLICY_REFUSED');
  return freeze({ minimumConfirmations });
}
export function freezeTaskObservationPolicy(value: unknown): FrozenTaskObservationPolicy {
  const policy = normalizeObservationPolicy(value);
  return freeze({ policy, digest: keccak256Utf8(JSON.stringify(policy)) });
}
export type TaskObservationAttempt = {
  readonly executorDigest: string; readonly grantPolicyVersion: string; readonly transactionHash: string;
};
export function normalizeObservationAttempt(value: unknown): TaskObservationAttempt {
  const r = object(value, ['executorDigest', 'grantPolicyVersion', 'transactionHash']);
  return freeze({ executorDigest: hash(r.executorDigest), grantPolicyVersion: uint(r.grantPolicyVersion, true), transactionHash: hash(r.transactionHash) });
}
export type TaskObservationVerifier = {
  readonly verifierId: string; readonly verifierVersion: string; readonly verifierImplementationDigest: string;
};
export function normalizeObservationVerifier(value: unknown): TaskObservationVerifier {
  const r = object(value, ['verifierId', 'verifierVersion', 'verifierImplementationDigest']);
  return freeze({ verifierId: id(r.verifierId), verifierVersion: id(r.verifierVersion), verifierImplementationDigest: hash(r.verifierImplementationDigest) });
}
export type TaskObservation = TaskObservationVerifier & {
  readonly schema: '8415-task-observation/1'; readonly taskDigest: string; readonly childDigest: string;
  readonly chainId: string; readonly actor: string; readonly nonce: string;
  readonly attemptExecutorDigest: string; readonly attemptGrantPolicyVersion: string;
  readonly originalTransactionHash: string; readonly observationPolicy: TaskObservationPolicy; readonly observationPolicyDigest: string;
  readonly state: 'pending' | 'confirming' | 'confirmed-at-depth' | 'reverted-at-depth' | 'superseded-at-depth' | 'reorged';
  readonly blockNumber: string | null; readonly blockHash: string | null; readonly confirmations: string;
  readonly replacementHash: string | null; readonly observedAt: string;
  readonly effect: 'not-established' | 'exact-operation-observed' | 'atomic-sale-observed';
  readonly protocolFinality: 'not-evaluated'; readonly economicFinality: 'not-evaluated';
};
export function normalizeTaskObservation(value: unknown): TaskObservation {
  const r = object(value, ['schema', 'taskDigest', 'childDigest', 'chainId', 'actor', 'nonce', 'attemptExecutorDigest',
    'attemptGrantPolicyVersion', 'originalTransactionHash', 'observationPolicy', 'observationPolicyDigest', 'state',
    'blockNumber', 'blockHash', 'confirmations', 'replacementHash', 'observedAt', 'effect', 'protocolFinality',
    'economicFinality', 'verifierId', 'verifierVersion', 'verifierImplementationDigest']);
  check(r.schema === '8415-task-observation/1' && r.protocolFinality === 'not-evaluated' && r.economicFinality === 'not-evaluated', 'TASK_OBSERVATION_SCHEMA_REFUSED');
  check(['pending', 'confirming', 'confirmed-at-depth', 'reverted-at-depth', 'superseded-at-depth', 'reorged'].includes(r.state as string), 'TASK_OBSERVATION_STATE_REFUSED');
  check(['not-established', 'exact-operation-observed', 'atomic-sale-observed'].includes(r.effect as string), 'TASK_OBSERVATION_EFFECT_REFUSED');
  check(isAddressInput(r.actor), 'TASK_OBSERVATION_ACTOR_REFUSED');
  const policy = freezeTaskObservationPolicy(r.observationPolicy);
  check(hash(r.observationPolicyDigest) === policy.digest, 'TASK_OBSERVATION_POLICY_MISMATCH');
  const blockNumber = r.blockNumber === null ? null : uint(r.blockNumber), blockHash = r.blockHash === null ? null : hash(r.blockHash);
  const confirmations = uint(r.confirmations), replacementHash = r.replacementHash === null ? null : hash(r.replacementHash);
  check((blockNumber === null) === (blockHash === null), 'TASK_OBSERVATION_BLOCK_REFUSED');
  if (r.state === 'pending') check(blockNumber === null && confirmations === '0', 'TASK_OBSERVATION_STATE_REFUSED');
  else if (r.state === 'reorged') check(confirmations === '0', 'TASK_OBSERVATION_STATE_REFUSED');
  else {
    check(blockNumber !== null && BigInt(confirmations) >= 1n, 'TASK_OBSERVATION_STATE_REFUSED');
    check(r.state === 'confirming' ? BigInt(confirmations) < BigInt(policy.policy.minimumConfirmations) :
      BigInt(confirmations) >= BigInt(policy.policy.minimumConfirmations), 'TASK_OBSERVATION_DEPTH_REFUSED');
  }
  check((r.state === 'confirmed-at-depth') === (r.effect !== 'not-established'), 'TASK_OBSERVATION_EFFECT_REFUSED');
  check(r.state === 'superseded-at-depth' ? replacementHash !== null : replacementHash === null, 'TASK_OBSERVATION_REPLACEMENT_REFUSED');
  const originalTransactionHash = hash(r.originalTransactionHash);
  check(replacementHash !== originalTransactionHash, 'TASK_OBSERVATION_REPLACEMENT_REFUSED');
  const verifier = normalizeObservationVerifier({ verifierId: r.verifierId, verifierVersion: r.verifierVersion,
    verifierImplementationDigest: r.verifierImplementationDigest });
  return freeze({ schema: '8415-task-observation/1', taskDigest: hash(r.taskDigest), childDigest: hash(r.childDigest),
    chainId: uint(r.chainId, true), actor: (r.actor as string).toLowerCase(), nonce: uint(r.nonce),
    attemptExecutorDigest: hash(r.attemptExecutorDigest), attemptGrantPolicyVersion: uint(r.attemptGrantPolicyVersion, true),
    originalTransactionHash, observationPolicy: policy.policy, observationPolicyDigest: policy.digest,
    state: r.state as TaskObservation['state'], blockNumber, blockHash, confirmations, replacementHash,
    observedAt: uint(r.observedAt, false, 64), effect: r.effect as TaskObservation['effect'],
    protocolFinality: 'not-evaluated', economicFinality: 'not-evaluated', ...verifier });
}
export type TaskObservationBinding = {
  readonly task: FrozenTask; readonly child: FrozenChild; readonly attempt: TaskObservationAttempt;
  readonly observationPolicy: TaskObservationPolicy; readonly verifier?: TaskObservationVerifier;
};
/** A validated binding still is only data. Never accept client JSON as a trusted observation. */
export function bindTaskObservation(value: unknown, expected: TaskObservationBinding): TaskObservation {
  const observation = normalizeTaskObservation(value), task = freezeTaskPolicy(expected.task.policy), child = freezeChildOperation(expected.child.child);
  const attempt = normalizeObservationAttempt(expected.attempt), policy = freezeTaskObservationPolicy(expected.observationPolicy);
  check(task.digest === expected.task.digest && child.digest === expected.child.digest && child.child.taskDigest === task.digest &&
    child.child.operation.chainId === task.policy.chainId && child.child.operation.actor === task.policy.actor, 'TASK_OBSERVATION_BINDING_REFUSED');
  check(observation.taskDigest === task.digest && observation.childDigest === child.digest && observation.chainId === task.policy.chainId &&
    observation.actor === task.policy.actor && observation.nonce === child.child.nonce && observation.attemptExecutorDigest === attempt.executorDigest &&
    observation.attemptGrantPolicyVersion === attempt.grantPolicyVersion && observation.originalTransactionHash === attempt.transactionHash &&
    observation.observationPolicyDigest === policy.digest, 'TASK_OBSERVATION_BINDING_REFUSED');
  if (expected.verifier) {
    const verifier = normalizeObservationVerifier(expected.verifier);
    check(observation.verifierId === verifier.verifierId && observation.verifierVersion === verifier.verifierVersion &&
      observation.verifierImplementationDigest === verifier.verifierImplementationDigest, 'TASK_OBSERVATION_VERIFIER_MISMATCH');
  }
  if (task.policy.intent.kind === 'exact-operation') {
    check(JSON.stringify(task.policy.intent.operation) === JSON.stringify(child.child.operation), 'TASK_OBSERVATION_BINDING_REFUSED');
    check(observation.effect !== 'atomic-sale-observed', 'TASK_OBSERVATION_EFFECT_REFUSED');
  } else check(observation.effect !== 'exact-operation-observed', 'TASK_OBSERVATION_EFFECT_REFUSED');
  return observation;
}
