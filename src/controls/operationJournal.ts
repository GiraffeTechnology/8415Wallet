import { controlHex, requireControlAdapter as check, validateControlPin, type ControlDeploymentPin } from './authorization.ts';
import { parseControlSubmission, serializeControlSubmission, type ControlSubmission } from './client.ts';
import { parseFixedSubmission, serializeFixedSubmission, type FixedSubmission } from './execution.ts';

export type WalletSubmission = ControlSubmission | FixedSubmission;
export type OperationState = { readonly schema: '8415-operation/1'; readonly revision: bigint;
  readonly status: 'idle' | 'outcome-unknown' | 'submitted'; readonly deployment: ControlDeploymentPin;
  readonly actor: string; readonly requestDigest: string | null; readonly submission: WalletSubmission | null };
/** CAS must be atomic and durable before returning true. Implementations must not silently reset a corrupt record. */
export interface PublicOperationStore {
  read(): Promise<OperationState | null>;
  compareAndSwap(expectedRevision: bigint | null, next: OperationState): Promise<boolean>;
}
export function serializeOperation(s: OperationState): string {
  return JSON.stringify({ schema: s.schema, revision: s.revision.toString(), status: s.status,
    deployment: { chainId: s.deployment.chainId.toString(), controller: s.deployment.controller, runtimeCodeHash: s.deployment.runtimeCodeHash },
    actor: s.actor, requestDigest: s.requestDigest,
    submission: s.submission === null ? null : s.submission.schema === '8415-control-submission/1'
      ? serializeControlSubmission(s.submission) : serializeFixedSubmission(s.submission) });
}
export function parseOperation(json: string): OperationState {
  check(typeof json === 'string' && json.length <= 16384, 'CONTROL_OPERATION_JOURNAL_REFUSED');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('CONTROL_OPERATION_JOURNAL_REFUSED'); }
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  const r = raw as Record<string, unknown>;
  const keys = ['schema', 'revision', 'status', 'deployment', 'actor', 'requestDigest', 'submission'];
  check(Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k)) && r.schema === '8415-operation/1' &&
    typeof r.revision === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(r.revision), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  check(r.deployment !== null && typeof r.deployment === 'object' && !Array.isArray(r.deployment), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  const d = r.deployment as Record<string, unknown>;
  check(Object.keys(d).length === 3 && typeof d.chainId === 'string' && /^[1-9][0-9]{0,77}$/.test(d.chainId) &&
    controlHex(d.controller, 20) && controlHex(d.runtimeCodeHash, 32), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  const deployment = { chainId: BigInt(d.chainId), controller: d.controller.toLowerCase(), runtimeCodeHash: d.runtimeCodeHash.toLowerCase() };
  validateControlPin(deployment);
  check(controlHex(r.actor, 20) && !/^0x0+$/i.test(r.actor) &&
    (r.status === 'idle' || r.status === 'outcome-unknown' || r.status === 'submitted'), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  check((r.status === 'idle' ? r.requestDigest === null : controlHex(r.requestDigest, 32)) &&
    (r.status === 'submitted' ? typeof r.submission === 'string' : r.status === 'idle' ? r.submission === null :
      r.submission === null || typeof r.submission === 'string'), 'CONTROL_OPERATION_JOURNAL_REFUSED');
  let submission: WalletSubmission | null = null;
  if (typeof r.submission === 'string') {
    let tag: unknown;
    try { tag = (JSON.parse(r.submission) as Record<string, unknown>).schema; } catch { throw new Error('CONTROL_OPERATION_JOURNAL_REFUSED'); }
    check(tag === '8415-control-submission/1' || tag === '8415-fixed-submission/1', 'CONTROL_OPERATION_JOURNAL_REFUSED');
    submission = tag === '8415-control-submission/1' ? parseControlSubmission(r.submission) : parseFixedSubmission(r.submission);
    check((/^0x0+$/.test(submission.transactionHash)) === (r.status === 'outcome-unknown'), 'CONTROL_JOURNAL_TRANSACTION_REFUSED');
    check(submission.actor.toLowerCase() === r.actor.toLowerCase(), 'CONTROL_JOURNAL_ACTOR_REFUSED');
    const pins = submission.schema === '8415-control-submission/1' ? [submission.deployment] : [submission.pin, ...submission.guards];
    check(pins.some(p => sameDeployment(p, deployment)), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
  }
  const revision = BigInt(r.revision); check(revision < 1n << 256n, 'CONTROL_OPERATION_JOURNAL_REFUSED');
  return { schema: '8415-operation/1', revision, status: r.status, deployment, actor: r.actor.toLowerCase(),
    requestDigest: r.requestDigest as string | null, submission };
}
export function sameDeployment(a: ControlDeploymentPin, b: ControlDeploymentPin): boolean {
  return a.chainId === b.chainId && a.controller.toLowerCase() === b.controller.toLowerCase() &&
    a.runtimeCodeHash.toLowerCase() === b.runtimeCodeHash.toLowerCase();
}
