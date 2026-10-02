import { keccak256Utf8 } from '../codec/keccak.ts';
import { controlHex, requireControlAdapter as check, validateControlPin, type ControlDeploymentPin } from '../controls/authorization.ts';
import type { WalletOperation } from '../controls/session.ts';

export const XIONGAN_PROFILE = Object.freeze({
  name: 'Xiongan Wallet', displayName: 'Xiongan Wallet',
  controlsExecution: 'testnet-owner-confirmed', custody: 'external-wallet-provider',
  independentAudit: 'NOT_INDEPENDENTLY_AUDITED',
} as const);
export type AgentRequestContext = {
  readonly actor: string; readonly controller: ControlDeploymentPin;
  readonly token: ControlDeploymentPin; readonly now: bigint;
};
export type AgentRequestReview = {
  readonly requestId: string; readonly claimedAgent: string; readonly digest: string;
  readonly expiresAt: bigint; readonly chainId: bigint; readonly actor: string;
  readonly controller: string; readonly runtimeCodeHash: string;
  readonly operation: WalletOperation;
  readonly authorization: 'owner-review-required';
  readonly gas: 'review-in-wallet-provider';
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'AGENT_REQUEST_SCHEMA_REFUSED');
  const r = value as Record<string, unknown>;
  check(Object.keys(r).sort().join(',') === [...keys].sort().join(','), 'AGENT_REQUEST_SCHEMA_REFUSED');
  return r;
}
function integer(value: unknown, bits = 256): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'AGENT_REQUEST_INTEGER_REFUSED');
  const n = BigInt(value); check(n < 1n << BigInt(bits), 'AGENT_REQUEST_INTEGER_REFUSED'); return n;
}
function address(value: unknown): string {
  check(controlHex(value, 20) && !/^0x0+$/i.test(value), 'AGENT_REQUEST_ADDRESS_REFUSED'); return value.toLowerCase();
}
function digest(value: unknown): string {
  check(controlHex(value, 32) && !/^0x0+$/i.test(value), 'AGENT_REQUEST_HASH_REFUSED'); return value.toLowerCase();
}
/** Public, bounded JSON only. This parser has no provider, signer, token approval,
 * credential, persistence or network capability. A claimed agent name is not identity.
 * The owner must review every operation; session and on-chain checks still apply.
 */
export function reviewAgentRequest(text: string, context: AgentRequestContext): AgentRequestReview {
  check(typeof text === 'string' && text.length > 0 && text.length <= 8192, 'AGENT_REQUEST_SIZE_REFUSED');
  let input: unknown;
  try { input = JSON.parse(text); } catch { check(false, 'AGENT_REQUEST_JSON_REFUSED'); }
  const r = record(input, ['schema', 'requestId', 'agent', 'chainId', 'actor', 'controller', 'expiresAt', 'operation']);
  check(r.schema === 'xiongan-agent-request/1', 'AGENT_REQUEST_SCHEMA_REFUSED');
  check(typeof r.requestId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.requestId), 'AGENT_REQUEST_ID_REFUSED');
  check(typeof r.agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(r.agent), 'AGENT_REQUEST_NAME_REFUSED');
  validateControlPin(context.controller); validateControlPin(context.token);
  const chainId = integer(r.chainId);
  check([11155111n, 560048n].includes(chainId), 'AGENT_TESTNET_REQUIRED');
  check(chainId === context.controller.chainId && chainId === context.token.chainId, 'AGENT_REQUEST_CHAIN_MISMATCH');
  check(address(r.actor) === address(context.actor), 'AGENT_REQUEST_ACTOR_MISMATCH');
  check(address(r.controller) === context.controller.controller.toLowerCase(), 'AGENT_REQUEST_DEPLOYMENT_MISMATCH');
  const expiresAt = integer(r.expiresAt, 64);
  check(typeof context.now === 'bigint' && context.now >= 0n && expiresAt > context.now && expiresAt - context.now <= 900n,
    'AGENT_REQUEST_EXPIRY_REFUSED');
  const raw = r.operation;
  check(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'AGENT_REQUEST_OPERATION_REFUSED');
  const kind = (raw as Record<string, unknown>).kind;
  let operation: WalletOperation;
  if (kind === 'create-account') {
    record(raw, ['kind']); operation = { kind: 'control', action: { kind } };
  } else if (kind === 'deposit' || kind === 'standalone-withdraw') {
    const op = record(raw, kind === 'deposit' ? ['kind', 'tokenId'] : ['kind', 'tokenId', 'destination']);
    const token = Object.freeze({ ...context.token });
    operation = kind === 'deposit' ? { kind, token, tokenId: integer(op.tokenId) } :
      { kind, token, tokenId: integer(op.tokenId), destination: address(op.destination) };
  } else if (kind === 'complete' || kind === 'return-hop') {
    const op = record(raw, ['kind', 'sequenceId', 'legId', 'expectedRevision']);
    const common = { sequenceId: digest(op.sequenceId), expectedRevision: integer(op.expectedRevision) };
    operation = { kind: 'control', action: kind === 'complete' ?
      { kind, ...common, throughLegId: digest(op.legId) } : { kind, ...common, legId: digest(op.legId) } };
  } else { check(false, 'AGENT_REQUEST_OPERATION_REFUSED'); }
  if (operation.kind === 'control') Object.freeze(operation.action);
  Object.freeze(operation);
  const summary = { requestId: r.requestId, claimedAgent: r.agent, expiresAt, chainId,
    actor: address(r.actor), controller: context.controller.controller.toLowerCase(),
    runtimeCodeHash: context.controller.runtimeCodeHash.toLowerCase(), operation,
    authorization: 'owner-review-required' as const, gas: 'review-in-wallet-provider' as const };
  return Object.freeze({ ...summary, digest: keccak256Utf8(JSON.stringify(summary,
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)) });
}
