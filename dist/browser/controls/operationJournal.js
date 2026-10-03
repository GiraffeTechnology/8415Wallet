import { controlHex, requireControlAdapter as check, validateControlPin } from "./authorization.js";
import { parseControlSubmission, serializeControlSubmission } from "./client.js";
import { parseFixedSubmission, serializeFixedSubmission } from "./execution.js";
export function serializeOperation(s) {
    return JSON.stringify({ schema: s.schema, revision: s.revision.toString(), status: s.status,
        deployment: { chainId: s.deployment.chainId.toString(), controller: s.deployment.controller, runtimeCodeHash: s.deployment.runtimeCodeHash },
        actor: s.actor, requestDigest: s.requestDigest,
        submission: s.submission === null ? null : s.submission.schema === '8415-control-submission/1'
            ? serializeControlSubmission(s.submission) : serializeFixedSubmission(s.submission) });
}
export function parseOperation(json) {
    check(typeof json === 'string' && json.length <= 16384, 'CONTROL_OPERATION_JOURNAL_REFUSED');
    let raw;
    try {
        raw = JSON.parse(json);
    }
    catch {
        throw new Error('CONTROL_OPERATION_JOURNAL_REFUSED');
    }
    check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    const r = raw;
    const keys = ['schema', 'revision', 'status', 'deployment', 'actor', 'requestDigest', 'submission'];
    check(Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k)) && r.schema === '8415-operation/1' &&
        typeof r.revision === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(r.revision), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    check(r.deployment !== null && typeof r.deployment === 'object' && !Array.isArray(r.deployment), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    const d = r.deployment;
    check(Object.keys(d).length === 3 && typeof d.chainId === 'string' && /^[1-9][0-9]{0,77}$/.test(d.chainId) &&
        controlHex(d.controller, 20) && controlHex(d.runtimeCodeHash, 32), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    const deployment = { chainId: BigInt(d.chainId), controller: d.controller.toLowerCase(), runtimeCodeHash: d.runtimeCodeHash.toLowerCase() };
    validateControlPin(deployment);
    check(controlHex(r.actor, 20) && !/^0x0+$/i.test(r.actor) &&
        (r.status === 'idle' || r.status === 'outcome-unknown' || r.status === 'submitted'), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    check((r.status === 'idle' ? r.requestDigest === null : controlHex(r.requestDigest, 32)) &&
        (r.status === 'submitted' ? typeof r.submission === 'string' : r.status === 'idle' ? r.submission === null :
            r.submission === null || typeof r.submission === 'string'), 'CONTROL_OPERATION_JOURNAL_REFUSED');
    let submission = null;
    if (typeof r.submission === 'string') {
        let tag;
        try {
            tag = JSON.parse(r.submission).schema;
        }
        catch {
            throw new Error('CONTROL_OPERATION_JOURNAL_REFUSED');
        }
        check(tag === '8415-control-submission/1' || tag === '8415-fixed-submission/1', 'CONTROL_OPERATION_JOURNAL_REFUSED');
        submission = tag === '8415-control-submission/1' ? parseControlSubmission(r.submission) : parseFixedSubmission(r.submission);
        check((/^0x0+$/.test(submission.transactionHash)) === (r.status === 'outcome-unknown'), 'CONTROL_JOURNAL_TRANSACTION_REFUSED');
        check(submission.actor.toLowerCase() === r.actor.toLowerCase(), 'CONTROL_JOURNAL_ACTOR_REFUSED');
        const pins = submission.schema === '8415-control-submission/1' ? [submission.deployment] : [submission.pin, ...submission.guards];
        check(pins.some(p => sameDeployment(p, deployment)), 'CONTROL_JOURNAL_DEPLOYMENT_REFUSED');
    }
    const revision = BigInt(r.revision);
    check(revision < 1n << 256n, 'CONTROL_OPERATION_JOURNAL_REFUSED');
    return { schema: '8415-operation/1', revision, status: r.status, deployment, actor: r.actor.toLowerCase(),
        requestDigest: r.requestDigest, submission };
}
export function sameDeployment(a, b) {
    return a.chainId === b.chainId && a.controller.toLowerCase() === b.controller.toLowerCase() &&
        a.runtimeCodeHash.toLowerCase() === b.runtimeCodeHash.toLowerCase();
}
